import { databaseDoc, databasesCol } from "@/lib/firestore/collections";
import { allRecords, databaseFile } from "@/lib/recordstore";
import { toFinding, tagsOf, type Finding } from "@/lib/findings";

/**
 * Databases: named record collections (config in data/databases/<id>.json,
 * records in db/<id>.jsonl through the SQLite record store). Jobs save into
 * them and read from them; /databases browses them.
 */

export interface DatabaseInfo {
  id: string;
  name: string;
  description: string;
  /** "domain": company records (careers pages, categories…); else plain records. */
  key: "domain" | "url" | "id";
  record_label: { singular: string; plural: string };
  count: number;
  file: string;
}

function info(id: string, d: Record<string, unknown>): DatabaseInfo {
  const label = (d.record_label ?? {}) as { singular?: string; plural?: string };
  const key = d.key === "domain" || d.key === "url" ? d.key : "id";
  return {
    id,
    name: String(d.name ?? id),
    description: String(d.description ?? ""),
    key,
    record_label: { singular: label.singular || "record", plural: label.plural || "records" },
    count: allRecords(`db:${id}`, databaseFile(id)).length,
    file: `db/${id}.jsonl`,
  };
}

export async function listDatabases(uid: string): Promise<DatabaseInfo[]> {
  const snap = await databasesCol().where("owner_uid", "==", uid).get();
  return snap.docs.map((d) => info(d.id, d.data())).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getDatabase(uid: string, id: string): Promise<DatabaseInfo | null> {
  const snap = await databaseDoc(id).get();
  const d = snap.exists ? snap.data() : undefined;
  if (!d || d.owner_uid !== uid) return null;
  return info(id, d);
}

export function databaseRecords(id: string): Record<string, unknown>[] {
  return allRecords(`db:${id}`, databaseFile(id));
}

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : [];
const str = (...vs: unknown[]): string => {
  for (const v of vs) if (typeof v === "string" && v) return v;
  return "";
};

/**
 * Any record as a Finding, so one set of filter rules serves every database:
 * company records map field for field; other records (vacancies, listings…)
 * map their title / url / location / source onto the same slots.
 */
export function asFinding(rec: Record<string, unknown>, key: DatabaseInfo["key"]): Finding {
  if (key === "domain") return toFinding(rec);
  return {
    id: String(rec.id),
    name: str(rec.title, rec.name, rec.id),
    website: str(rec.url, rec.website, rec.link),
    careers_url: "",
    description: str(rec.description, rec.summary, rec.company),
    countries: [...strs(rec.countries), ...strs(rec.country), ...strs(rec.location)],
    industries: strs(rec.industries),
    types: [...strs(rec.types), ...strs(rec.category)],
    sources: [...strs(rec.sources), ...strs(rec.source), ...strs(rec.job)],
    known: false,
    ats: "unknown",
    checked: false,
    reachable: null,
    scrapable: false,
    hidden: Boolean(rec.hidden),
    tags: tagsOf(rec as { tags?: string[] }),
    relevance: typeof rec.relevance === "number" ? rec.relevance : undefined,
  };
}

/** CSV of records: company columns, or every field the records have. */
export function toCsv(rows: Record<string, unknown>[], key: DatabaseInfo["key"]): string {
  const esc = (v: unknown) => {
    const s = Array.isArray(v) ? v.join("; ") : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols =
    key === "domain"
      ? ["name", "website", "careers_url", "countries", "types", "industries", "sources", "tags", "description"]
      : Array.from(rows.reduce((set, r) => {
          for (const k of Object.keys(r)) set.add(k);
          return set;
        }, new Set<string>(["id"])));
  return "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
}
