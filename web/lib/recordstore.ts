import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The web side of the record store (see recordstore.py): the SQLite working
 * database local-data/scraper.db, shared with the Python side. This side only
 * imports committed JSONL files after a git pull (syncIn) and reads; every
 * write goes through Python, which also writes the byte-stable exports.
 *
 *   store "db:<database-id>"  a database, mirrored to db/<id>.jsonl (committed)
 *   store "job:<job-id>"      a job's results (this computer only)
 */

const REPO_ROOT = process.env.CASPIAN_REPO_ROOT ?? path.resolve(/*turbopackIgnore: true*/ process.cwd(), "..");
const DB_PATH = path.join(process.env.CASPIAN_LOCAL_DIR ?? path.join(REPO_ROOT, "local-data"), "scraper.db");
export const DB_DIR = process.env.CASPIAN_FINDINGS_DB ?? path.join(REPO_ROOT, "db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  store TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (store, id)
);
CREATE TABLE IF NOT EXISTS synced (store TEXT PRIMARY KEY, file TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (store TEXT PRIMARY KEY, version INTEGER NOT NULL);
`;

let db: DatabaseSync | null = null;
function conn(): DatabaseSync {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;");
    db.exec(SCHEMA);
  }
  return db;
}

/** The committed file of a database. */
export function databaseFile(databaseId: string): string {
  return path.join(DB_DIR, `${databaseId}.jsonl`);
}

function fileHash(file: string): string {
  try {
    return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

/** Import a committed store's file if it changed since the last sync. */
export function syncIn(store: string, file: string): void {
  const c = conn();
  const h = fileHash(file);
  const row = c.prepare("SELECT hash FROM synced WHERE store = ?").get(store) as { hash: string } | undefined;
  if (row && row.hash === h) return;
  c.exec("BEGIN IMMEDIATE");
  try {
    // Re-check inside the lock: Python may have just synced or exported.
    const again = c.prepare("SELECT hash FROM synced WHERE store = ?").get(store) as { hash: string } | undefined;
    if (!again || again.hash !== fileHash(file)) {
      const recs = new Map<string, string>();
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        /* no file yet: an empty database */
      }
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const r = JSON.parse(t);
          if (r && typeof r === "object" && r.id) recs.set(String(r.id), JSON.stringify(r));
        } catch {
          /* a half-merged line shouldn't sink the whole file */
        }
      }
      const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      c.prepare("DELETE FROM records WHERE store = ?").run(store);
      const ins = c.prepare("INSERT INTO records(store, id, data, updated_at) VALUES (?, ?, ?, ?)");
      for (const [id, data] of recs) ins.run(store, id, data, ts);
      c.prepare("INSERT OR REPLACE INTO synced(store, file, hash) VALUES (?, ?, ?)").run(store, file, fileHash(file));
      c.prepare(
        "INSERT INTO versions(store, version) VALUES (?, 1) ON CONFLICT(store) DO UPDATE SET version = version + 1"
      ).run(store);
    }
    c.exec("COMMIT");
  } catch (e) {
    c.exec("ROLLBACK");
    throw e;
  }
}

function version(store: string): number {
  const row = conn().prepare("SELECT version FROM versions WHERE store = ?").get(store) as { version: number } | undefined;
  return row?.version ?? 0;
}

const cache = new Map<string, { version: number; rows: Record<string, unknown>[] }>();

/** Every record of a store (parsed, cached until the store changes). For a
 *  committed store pass its file so a git pull is picked up first. */
export function allRecords(store: string, file?: string): Record<string, unknown>[] {
  if (file) syncIn(store, file);
  const v = version(store);
  const hit = cache.get(store);
  if (hit && hit.version === v) return hit.rows;
  const rows = (conn().prepare("SELECT data FROM records WHERE store = ? ORDER BY id").all(store) as { data: string }[]).map(
    (r) => JSON.parse(r.data) as Record<string, unknown>
  );
  cache.set(store, { version: v, rows });
  return rows;
}

/** Drop a local-only store (a deleted job's results); never a database. */
export function dropStore(store: string): void {
  if (store.startsWith("db:")) throw new Error("databases are dropped through their file");
  const c = conn();
  c.prepare("DELETE FROM records WHERE store = ?").run(store);
  c.prepare("DELETE FROM synced WHERE store = ?").run(store);
  c.prepare(
    "INSERT INTO versions(store, version) VALUES (?, 1) ON CONFLICT(store) DO UPDATE SET version = version + 1"
  ).run(store);
}

export function countRecords(store: string, file?: string): number {
  if (file) syncIn(store, file);
  const row = conn().prepare("SELECT COUNT(*) AS n FROM records WHERE store = ?").get(store) as { n: number };
  return row.n;
}
