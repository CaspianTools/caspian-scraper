"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { SourceSection } from "./SourceSection";
import { addButtonClasses } from "./format";

export interface ReadsFromEntry {
  database: string;
  only_tags: string[];
  /** The database's name, or its id when it no longer exists. */
  name: string;
  exists: boolean;
  /** Records that would be scraped now (computed server-side). */
  qualifying: number;
}

export interface DatabaseOption {
  id: string;
  name: string;
  count: number;
}

const primaryBtn =
  "inline-flex items-center h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20";
const inputCls =
  "h-9 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40";

/** "a, b ,, A" → ["a", "b"] (case-insensitive dedupe, schema limits). */
function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const t = raw.trim().slice(0, 40);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, 50);
}

/**
 * The job's "From databases" sources (projects/{id}.reads_from): each run
 * scrapes the careers pages of a database's records (scrape.database_sources).
 * Add / remove entries; saves the whole list with PATCH /api/projects/[id].
 */
export function ReadsFromEditor({
  projectId,
  entries,
  databases,
}: {
  projectId: string;
  entries: ReadsFromEntry[];
  databases: DatabaseOption[];
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const available = databases.filter((d) => !entries.some((e) => e.database === d.id));
  const [dbId, setDbId] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: { database: string; only_tags: string[] }[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          reads_from: next.map((e) =>
            e.only_tags.length > 0 ? { database: e.database, only_tags: e.only_tags } : { database: e.database }
          ),
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.details?.[0]?.message || b.error || `Save failed (${res.status})`);
        return false;
      }
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const current = entries.map((e) => ({ database: e.database, only_tags: e.only_tags }));

  async function add() {
    const id = dbId || available[0]?.id;
    if (!id) return;
    if (await save([...current, { database: id, only_tags: parseTags(tags) }])) {
      setAdding(false);
      setDbId("");
      setTags("");
    }
  }

  const blurb = (
    <>
      Each run scrapes the careers pages of a database&apos;s records — only
      records with a careers page on a supported platform (SuccessFactors,
      Jibe), optionally only those with certain tags.
    </>
  );
  const action = !adding && (
    <button type="button" onClick={() => setAdding(true)} className={addButtonClasses}>
      + Add database
    </button>
  );

  return (
    <SourceSection
      title="From databases"
      count={entries.length}
      blurb={blurb}
      action={action}
      empty={entries.length === 0 && !adding}
    >
      {entries.length > 0 && (
        <ul className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-card divide-y divide-zinc-100 dark:divide-zinc-800">
          {entries.map((e) => (
            <li key={e.database} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {e.exists ? (
                    <Link href={`/databases/${e.database}`} className="text-sm font-medium hover:underline">
                      {e.name}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium">{e.name}</span>
                  )}
                  {e.only_tags.map((t) => (
                    <span
                      key={t}
                      className="text-xs px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-600/15 dark:bg-brand-500/10 dark:text-brand-300"
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <div className="text-xs text-zinc-500 mt-0.5">
                  {!e.exists
                    ? "Database not found — nothing is read from it."
                    : `${e.qualifying.toLocaleString()} careers page${e.qualifying === 1 ? "" : "s"} qualify${
                        e.only_tags.length > 0 ? " (records with any of these tags)" : ""
                      }`}
                </div>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => save(current.filter((c) => c.database !== e.database))}
                className="text-xs text-zinc-500 hover:text-red-600 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-card p-4 space-y-3">
          {available.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {databases.length === 0 ? "No databases yet" : "This job already reads every database"} — create
              one under{" "}
              <Link href="/databases" className="underline">
                Databases
              </Link>
              .
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1">
                <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Database</span>
                <select
                  value={dbId || available[0].id}
                  onChange={(e) => setDbId(e.target.value)}
                  className={inputCls}
                >
                  {available.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.count.toLocaleString()})
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 flex-1 min-w-48">
                <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Only records tagged (optional, comma-separated)
                </span>
                <input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="e.g. oil & gas, gulf"
                  className={inputCls + " w-full"}
                />
              </label>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
              className={addButtonClasses}
            >
              Cancel
            </button>
            {available.length > 0 && (
              <button type="button" disabled={busy} onClick={add} className={primaryBtn}>
                {busy ? "Saving…" : "Add"}
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </SourceSection>
  );
}
