"""The record store — SQLite working database for record collections, with
committed ones mirrored to JSON Lines files in git.

    local-data/scraper.db    SQLite (WAL), this computer only
        records(store, id, data, updated_at)   one row per record, data = JSON
        synced(store, file, hash)              the JSONL file as last synced
        versions(store, version)               bumped on every write (caches)

A *store* is a named collection of records:

    db:<database-id>   a database (data/databases/<id>.json) — committed: every
                       write is exported to db/<id>.jsonl, one record per
                       line sorted by id, so git merges two computers' changes
    job:<job-id>       a job's own results — this computer only, no file

Sync with git: before reading a committed store, sync_in() compares the JSONL
file's hash with the one last imported/exported; if it differs (a git pull
changed it) the store is replaced from the file. Local changes can't be lost
that way: every write exports in the same step, so the file always holds them
before git touches it. Only Python writes exports (byte-stable formatting);
the web app (web/lib/recordstore.ts) imports and reads.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

REPO_ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("CASPIAN_LOCAL_DIR") or REPO_ROOT / "local-data") / "scraper.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
  store TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store, id)
);
CREATE TABLE IF NOT EXISTS synced (
  store TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  store TEXT PRIMARY KEY,
  version INTEGER NOT NULL
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """A connection with the schema in place; commits on success."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30)
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA busy_timeout=30000")
        con.executescript(SCHEMA)
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


def dump_line(rec: dict) -> str:
    """One record as its JSONL line — the committed format."""
    return json.dumps(rec, ensure_ascii=False, sort_keys=True)


def _file_hash(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest() if path.exists() else ""


def _read_jsonl(path: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue  # a half-merged line shouldn't sink the whole file
        if isinstance(rec, dict) and rec.get("id"):
            out[str(rec["id"])] = rec
    return out


def _bump(con: sqlite3.Connection, store: str) -> None:
    con.execute(
        "INSERT INTO versions(store, version) VALUES (?, 1) "
        "ON CONFLICT(store) DO UPDATE SET version = version + 1", (store,))


def sync_in(store: str, file: Path) -> None:
    """Import the committed file into the store if it changed since the last
    sync (a git pull), or on first use."""
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        h = _file_hash(file)
        row = con.execute("SELECT hash FROM synced WHERE store = ?", (store,)).fetchone()
        if row and row[0] == h:
            return
        recs = _read_jsonl(file)
        ts = now_iso()
        con.execute("DELETE FROM records WHERE store = ?", (store,))
        con.executemany("INSERT INTO records(store, id, data, updated_at) VALUES (?, ?, ?, ?)",
                        [(store, k, json.dumps(v, ensure_ascii=False), ts) for k, v in recs.items()])
        con.execute("INSERT OR REPLACE INTO synced(store, file, hash) VALUES (?, ?, ?)",
                    (store, str(file), h))
        _bump(con, store)


def load(store: str, file: Path | None = None) -> dict[str, dict]:
    """Every record of the store, by id (syncing a committed store first)."""
    if file is not None:
        sync_in(store, file)
    with connect() as con:
        rows = con.execute("SELECT id, data FROM records WHERE store = ?", (store,)).fetchall()
    return {k: json.loads(v) for k, v in rows}


def _export(con: sqlite3.Connection, store: str, file: Path) -> None:
    rows = con.execute("SELECT id, data FROM records WHERE store = ? ORDER BY id", (store,)).fetchall()
    lines = [dump_line(json.loads(v)) for _, v in rows]
    file.parent.mkdir(parents=True, exist_ok=True)
    tmp = file.with_name(f".{file.name}.{secrets.token_hex(4)}.tmp")
    # newline="\n": LF on every OS, matching .gitattributes (no CRLF churn).
    tmp.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8", newline="\n")
    os.replace(tmp, file)
    con.execute("INSERT OR REPLACE INTO synced(store, file, hash) VALUES (?, ?, ?)",
                (store, str(file), _file_hash(file)))


def write(store: str, upserts: dict[str, dict] | None = None, deletes: list[str] = (),
          file: Path | None = None, *, replace: bool = False) -> None:
    """Upsert / delete records (replace=True: the store becomes exactly
    `upserts`), then export a committed store to its file — in one step."""
    if file is not None:
        sync_in(store, file)
    ts = now_iso()
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        if replace:
            con.execute("DELETE FROM records WHERE store = ?", (store,))
        for k in deletes:
            con.execute("DELETE FROM records WHERE store = ? AND id = ?", (store, k))
        con.executemany(
            "INSERT INTO records(store, id, data, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(store, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            [(store, k, json.dumps(v, ensure_ascii=False), ts) for k, v in (upserts or {}).items()])
        _bump(con, store)
        if file is not None:
            _export(con, store, file)


def count(store: str) -> int:
    with connect() as con:
        return con.execute("SELECT COUNT(*) FROM records WHERE store = ?", (store,)).fetchone()[0]


def drop(store: str) -> None:
    """Remove a store's records and sync state (its file is left alone)."""
    with connect() as con:
        con.execute("DELETE FROM records WHERE store = ?", (store,))
        con.execute("DELETE FROM synced WHERE store = ?", (store,))
        _bump(con, store)
