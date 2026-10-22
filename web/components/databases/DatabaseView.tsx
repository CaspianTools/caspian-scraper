"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  FACET_KEYS, FACET_LABEL, emptyFilters, filtersToQuery, optionLabel,
  type FacetKey, type Filters, type Finding, type Sort, type TagMode,
} from "@/lib/findings";
import {
  FacetMenu, LoadingGrid, ResultCard, ResultRow, TagMenu, ViewToggle, chipBtn, useView,
} from "@/components/resources/finder";
import { AiTagDialog, SparkIcon } from "@/components/resources/AiTag";

/** What the server page sends: a database (lib/databases.ts DatabaseInfo)
 *  or a job's results store. */
export interface DatabaseMeta {
  id: string;
  name: string;
  key: "domain" | "url" | "id";
  record_label: { singular: string; plural: string };
  /** "job": a job's results (its id) — adds change filters, Save to
   *  database and Refresh; default "db". */
  kind?: "db" | "job";
  /** Columns for plain records (a job's fields); default: the commonest. */
  columns?: { key: string; label: string }[];
  /** Hide records scored below this relevance unless "show hidden". */
  cutoff?: number;
  /** Databases a job's results can be saved into. */
  databases?: { id: string; name: string }[];
}

interface Page {
  total: number;
  totalAll: number;
  hiddenCount: number;
  page: number;
  size: number;
  items: { finding: Finding; record: Record<string, unknown> }[];
  facets: Record<FacetKey, [string, number][]>;
  allTags: string[];
}

const SIZE = 60;
/** Ids per action request (the API's limit). */
const IDS_PER_CALL = 2000;
const ENRICH_BATCH = 25;
/** Placeholder facet values: a facet with only these is hidden. */
const EMPTY_VALUES = new Set(["(no country)", "(none)", "unchecked"]);
/** Fields not worth a column in a plain-records table. */
const HIDDEN_FIELDS = new Set(["id", "tags", "hidden", "raw", "found_by", "first_seen", "updated_at"]);

/**
 * A database's records, paged, filtered and sorted on the server
 * (/api/databases/[id]/records), with bulk actions on a selection that can
 * span pages: tags, AI tag, hide, find careers pages (company databases),
 * export, delete.
 */
export function DatabaseView({ db }: { db: DatabaseMeta }) {
  const companies = db.key === "domain";
  const isJob = db.kind === "job";
  const noun = db.record_label.plural;
  // Where this store's records are read / exported, and its id for actions.
  const listUrl = isJob ? `/api/projects/${db.id}/results` : `/api/databases/${db.id}/records`;
  const exportUrl = isJob ? `/api/projects/${db.id}/results/export` : `/api/databases/${db.id}/export`;
  const storeId = isJob ? `job:${db.id}` : db.id;
  const [view, setView] = useView();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [tagMode, setTagMode] = useState<TagMode>("any");
  const [sort, setSort] = useState<Sort>("name");
  const [showHidden, setShowHidden] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Map<string, string[]>>(new Map());
  const [busy, setBusy] = useState<null | "tag" | "hide" | "enrich" | "delete" | "select">(null);
  const [progress, setProgress] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const stop = useRef(false);

  // Type, then search: wait for a pause.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(text);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [text]);

  const params = useCallback(
    (extra: Record<string, string> = {}) => {
      const q = filtersToQuery({ filters, tagMode, text: query });
      if (showHidden) q.set("hidden", "1");
      if (db.cutoff) q.set("minRelevance", String(db.cutoff));
      for (const [k, v] of Object.entries(extra)) q.set(k, v);
      return q;
    },
    [filters, tagMode, query, showHidden, db.cutoff]
  );

  useEffect(() => {
    let live = true;
    const q = params({ sort, page: String(page), size: String(SIZE) });
    apiFetch(`${listUrl}?${q}`)
      .then(async (res) => {
        const b = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) setError(b.error || `Couldn't load (${res.status})`);
        else setData(b as Page);
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [listUrl, params, sort, page, reload]);

  const refresh = () => setReload((n) => n + 1);

  function toggleFilter(key: FacetKey, v: string) {
    setFilters((cur) => {
      const next = { ...cur, [key]: new Set(cur[key]) };
      if (next[key].has(v)) next[key].delete(v);
      else next[key].add(v);
      return next;
    });
    setPage(1);
  }

  /** Every matching id (with its tags), from the server. */
  async function matchingIds(all = false): Promise<{ id: string; tags: string[]; hidden: boolean }[]> {
    const q = all ? new URLSearchParams(showHidden ? { hidden: "1" } : {}) : params();
    if (all && db.cutoff && !showHidden) q.set("minRelevance", String(db.cutoff));
    q.set("select", "1");
    const res = await apiFetch(`${listUrl}?${q}`);
    const b = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(b.error || `Couldn't load (${res.status})`);
    return b.items;
  }

  async function selectAllMatching() {
    setBusy("select");
    try {
      const items = await matchingIds();
      setSelected(new Map(items.map((x) => [x.id, x.tags])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function togglePick(f: Finding) {
    setSelected((cur) => {
      const n = new Map(cur);
      if (n.has(f.id)) n.delete(f.id);
      else n.set(f.id, f.tags ?? []);
      return n;
    });
  }

  /** POST an action for the selected ids, IDS_PER_CALL at a time. */
  async function act(path: string, body: Record<string, unknown>, ids = [...selected.keys()]) {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < ids.length; i += IDS_PER_CALL) {
      const res = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify({ ...body, database: storeId, ids: ids.slice(i, i + IDS_PER_CALL) }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.details?.[0]?.message || b.error || `Failed (${res.status})`);
      out.push(b);
    }
    return out;
  }

  async function run(kind: NonNullable<typeof busy>, fn: () => Promise<string | void>) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setProgress("");
    }
  }

  const retag = (add: string[], remove: string[]) =>
    run("tag", async () => {
      const res = await act("/api/resources/tag", { add, remove });
      const tags = Object.assign({}, ...res.map((b) => b.tags as Record<string, string[]>));
      setSelected((cur) => new Map([...cur].map(([id, t]) => [id, tags[id] ?? t])));
      const n = Object.keys(tags).length;
      const names = (l: string[]) => l.map((t) => `“${t}”`).join(", ");
      return add.length ? `Tagged ${n} with ${names(add)}.` : `Removed ${names(remove)} from ${n}.`;
    });

  const pickedHidden = useMemo(
    () => data?.items.some((x) => selected.has(x.finding.id) && x.finding.hidden) ?? false,
    [data, selected]
  );

  const setHidden = (hidden: boolean) =>
    run("hide", async () => {
      await act("/api/resources/mark", { hidden });
      const n = selected.size;
      setSelected(new Map());
      return hidden ? `Hid ${n}. Turn on “Show hidden” to see them.` : `Unhid ${n}.`;
    });

  const findCareers = () =>
    run("enrich", async () => {
      const ids = [...selected.keys()];
      stop.current = false;
      let done = 0;
      let found = 0;
      for (let i = 0; i < ids.length && !stop.current; i += ENRICH_BATCH) {
        setProgress(`Finding careers pages… ${done} of ${ids.length} checked`);
        const [b] = await act("/api/resources/enrich", {}, ids.slice(i, i + ENRICH_BATCH));
        const fs = (b.findings ?? []) as Finding[];
        done += fs.length;
        found += fs.filter((f) => f.careers_url).length;
        refresh();
      }
      return `Careers pages found for ${found} of ${done} checked${done < ids.length ? ` (stopped; ${ids.length - done} not checked)` : ""}.`;
    });

  const remove = () => {
    if (!confirm(`Delete ${selected.size} ${noun} from ${db.name}? This can't be undone (except through git).`)) return;
    return run("delete", async () => {
      const res = await act("/api/resources/delete", {});
      const n = res.reduce((s, b) => s + Number(b.deleted ?? 0), 0);
      setSelected(new Map());
      return `Deleted ${n}.`;
    });
  };

  const saveTo = (database: string) =>
    run("tag", async () => {
      const res = await apiFetch(`/api/projects/${db.id}/results/save`, {
        method: "POST",
        body: JSON.stringify({ database, ids: [...selected.keys()] }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error || `Couldn't save (${res.status})`);
      const name = db.databases?.find((d) => d.id === database)?.name ?? database;
      return `Saved ${b.saved} into ${name}.`;
    });

  const refreshFromRuns = () =>
    run("select", async () => {
      setProgress("Gathering what the runs have found…");
      const res = await apiFetch(`/api/projects/${db.id}/results/collect`, { method: "POST" });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error || `Couldn't refresh (${res.status})`);
      return `Up to date: ${b.new ?? 0} new, ${b.changed ?? 0} changed, ${b.gone ?? 0} gone.`;
    });

  function exportCsv() {
    const q = selected.size > 0 ? new URLSearchParams({ ids: [...selected.keys()].join(",") }) : params();
    window.location.href = `${exportUrl}?${q}`;
  }

  const facetKeys = FACET_KEYS.filter(
    (k) => k === "tag" || (data?.facets[k] ?? []).some(([v]) => !EMPTY_VALUES.has(v))
  ).filter((k) => companies || (k !== "status" && k !== "category") || (data?.facets[k] ?? []).length > 1);
  const activeFilters = FACET_KEYS.flatMap((k) => [...filters[k]].map((v) => [k, v] as const));
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  const onPage = useMemo(() => data?.items ?? [], [data]);
  const pageAllPicked = onPage.length > 0 && onPage.every((x) => selected.has(x.finding.id));

  // Columns for plain records: the most common fields on this page.
  const columns = useMemo(() => {
    if (companies) return [];
    if (db.columns?.length) return db.columns.map((c) => c.key);
    const counts = new Map<string, number>();
    for (const x of onPage) for (const k of Object.keys(x.record ?? {})) if (!HIDDEN_FIELDS.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
  }, [companies, onPage, db.columns]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Search ${noun}…`}
          aria-label={`Search ${noun}`}
          className="h-8 w-60 px-2.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
        />
        {facetKeys.map((key) => (
          <FacetMenu
            key={key}
            label={FACET_LABEL[key]}
            options={(data?.facets[key] ?? []).map(([v, n]) => ({ value: v, label: optionLabel(key, v), count: n }))}
            selected={filters[key]}
            onToggle={(v) => toggleFilter(key, v)}
            onClear={() => {
              setFilters((cur) => ({ ...cur, [key]: new Set() }));
              setPage(1);
            }}
            {...(key === "tag" && {
              mode: tagMode,
              onMode: (m: TagMode) => {
                setTagMode(m);
                setPage(1);
              },
              hint: data && data.allTags.length === 0 ? `No tags yet. Select ${noun} and use Tags to add some.` : undefined,
            })}
          />
        ))}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="h-8 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
          aria-label="Sort"
        >
          <option value="name">Sort: name A–Z</option>
          <option value="relevance">Sort: relevance</option>
          {companies && <option value="sources">Sort: most sources</option>}
        </select>
        {data && data.hiddenCount > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => {
                setShowHidden(e.target.checked);
                setPage(1);
              }}
            />
            Show hidden ({data.hiddenCount})
          </label>
        )}
        <span className="mx-auto" />
        {isJob && (
          <button type="button" className={chipBtn} disabled={busy !== null} onClick={refreshFromRuns} title="Gather what this job's runs have found so far">
            Refresh from runs
          </button>
        )}
        {companies && <ViewToggle view={view} onChange={setView} />}
      </div>
      {activeFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {activeFilters.map(([k, v]) => (
            <button
              key={`${k}:${v}`}
              type="button"
              onClick={() => toggleFilter(k, v)}
              className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-600/20 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-400/25"
            >
              {FACET_LABEL[k]}: {optionLabel(k, v)} <span aria-hidden>×</span>
            </button>
          ))}
          {filters.tag.size > 1 && <span className="text-zinc-500">Tags: match {tagMode}</span>}
          <button
            type="button"
            className="underline text-zinc-500"
            onClick={() => {
              setFilters(emptyFilters());
              setPage(1);
            }}
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Selection + bulk actions */}
      <div className="sticky top-14 z-10 -mx-1 px-1 py-2 bg-zinc-50/90 dark:bg-black/80 backdrop-blur flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={pageAllPicked}
            onChange={(e) =>
              setSelected((cur) => {
                const n = new Map(cur);
                for (const x of onPage) {
                  if (e.target.checked) n.set(x.finding.id, x.finding.tags ?? []);
                  else n.delete(x.finding.id);
                }
                return n;
              })
            }
            aria-label="Select this page"
          />
          {selected.size > 0 ? (
            <span>
              <span className="font-medium">{selected.size}</span> selected
            </span>
          ) : (
            <span className="text-zinc-500">
              {data ? `${data.total.toLocaleString()} ${noun}` : "Loading…"}
              {data && data.total !== data.totalAll ? ` of ${data.totalAll.toLocaleString()}` : ""}
            </span>
          )}
        </label>
        {data && data.total > onPage.length && selected.size < data.total && (
          <button type="button" className={chipBtn} disabled={busy !== null} onClick={selectAllMatching}>
            {busy === "select" ? "Selecting…" : `Select all ${data.total.toLocaleString()}`}
          </button>
        )}
        <button
          type="button"
          disabled={busy !== null || !data || data.totalAll === 0}
          onClick={() => setAiOpen(true)}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-400/30 dark:bg-brand-500/10 dark:text-brand-300 dark:hover:bg-brand-500/20"
        >
          <SparkIcon className="w-3.5 h-3.5" />
          AI tag
        </button>
        <button type="button" className={chipBtn} onClick={exportCsv} disabled={!data || data.total === 0}>
          Export CSV{selected.size > 0 ? " (selected)" : ""}
        </button>
        {selected.size > 0 && (
          <>
            <span className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-700" />
            <TagMenu
              tags={data?.allTags ?? []}
              chosen={[...selected.values()].map((tags) => ({ tags }))}
              disabled={busy !== null}
              onChange={retag}
            />
            {isJob && (db.databases?.length ?? 0) > 0 && (
              <select
                aria-label="Save to database"
                className={chipBtn}
                disabled={busy !== null}
                value=""
                onChange={(e) => e.target.value && saveTo(e.target.value)}
              >
                <option value="">Save to database…</option>
                {db.databases!.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
            {companies && (
              <button type="button" className={chipBtn} disabled={busy !== null} onClick={findCareers}>
                {busy === "enrich" ? "Finding…" : "Find careers pages"}
              </button>
            )}
            <button type="button" className={chipBtn} disabled={busy !== null} onClick={() => setHidden(!pickedHidden)}>
              {pickedHidden ? "Unhide" : "Hide"}
            </button>
            <button
              type="button"
              className={chipBtn + " text-red-700 dark:text-red-300"}
              disabled={busy !== null}
              onClick={remove}
            >
              Delete
            </button>
            <button type="button" className="text-xs text-zinc-500 hover:underline" onClick={() => setSelected(new Map())}>
              Clear selection
            </button>
          </>
        )}
      </div>
      {(progress || notice) && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400 flex items-center gap-2">
          {progress || notice}
          {progress && busy === "enrich" && (
            <button type="button" className="underline text-zinc-500 hover:text-red-600" onClick={() => (stop.current = true)}>
              Stop
            </button>
          )}
          {notice && !progress && (
            <button type="button" className="text-zinc-400 hover:text-zinc-700" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          )}
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Records */}
      {!data ? (
        <LoadingGrid view={companies ? view : "list"} />
      ) : onPage.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center text-sm text-zinc-500 bg-white/60 dark:bg-zinc-950/40">
          {data.totalAll === 0
            ? isJob
              ? `No ${noun} yet. Add sources, then Run now (Runs) — or Refresh from runs if it has run before.`
              : `No ${noun} yet. Jobs that save into this database add them as they run.`
            : `No ${noun} match the filters.`}
        </div>
      ) : companies && view === "cards" ? (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {onPage.map(({ finding }) => (
            <ResultCard key={finding.id} f={finding} picked={selected.has(finding.id)} onToggle={() => togglePick(finding)} onTag={(t) => !filters.tag.has(t) && toggleFilter("tag", t)} />
          ))}
        </div>
      ) : companies ? (
        <ul className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 divide-y divide-zinc-100 dark:divide-zinc-800 shadow-card">
          {onPage.map(({ finding }) => (
            <ResultRow key={finding.id} f={finding} picked={selected.has(finding.id)} onToggle={() => togglePick(finding)} onTag={(t) => !filters.tag.has(t) && toggleFilter("tag", t)} />
          ))}
        </ul>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 dark:bg-zinc-900/60 text-[11px] font-medium uppercase tracking-wider text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className="w-10 px-3 py-2" />
                {columns.map((c) => (
                  <th key={c} className="text-left px-3 py-2 whitespace-nowrap">
                    {db.columns?.find((x) => x.key === c)?.label ?? c.replace(/_/g, " ")}
                  </th>
                ))}
                {isJob && <th className="text-left px-3 py-2">Change</th>}
                <th className="text-left px-3 py-2">Tags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {onPage.map(({ finding, record }) => (
                <tr key={finding.id} className={"hover:bg-zinc-50 dark:hover:bg-zinc-900/40 " + (finding.hidden ? "opacity-60" : "")}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(finding.id)} onChange={() => togglePick(finding)} aria-label={`Select ${finding.name}`} />
                  </td>
                  {columns.map((c) => (
                    <td key={c} className="px-3 py-2 max-w-xs truncate" title={cell(record?.[c])}>
                      {/^https?:\/\//.test(cell(record?.[c])) ? (
                        <a href={cell(record?.[c])} target="_blank" rel="noreferrer" className="text-brand-600 dark:text-brand-400 hover:underline">
                          {cell(record?.[c]).replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}
                        </a>
                      ) : (
                        cell(record?.[c])
                      )}
                    </td>
                  ))}
                  {isJob && (
                    <td className="px-3 py-2 text-xs whitespace-nowrap">
                      <ChangeChip change={finding.change} />
                      {typeof finding.relevance === "number" && (
                        <span className="ml-1.5 text-zinc-400" title="Relevance">
                          {finding.relevance}
                        </span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 text-xs text-brand-700 dark:text-brand-300">{(finding.tags ?? []).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button type="button" className={chipBtn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Previous
          </button>
          <span className="text-zinc-500">
            Page {page} of {pages}
          </span>
          <button type="button" className={chipBtn} disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next →
          </button>
        </div>
      )}

      {aiOpen && data && (
        <AiTagDialog
          database={db.id}
          noun={noun}
          counts={{ selected: selected.size, shown: data.total, all: data.totalAll }}
          idsFor={async (scope) =>
            scope === "selected" ? [...selected.keys()] : (await matchingIds(scope === "all")).map((x) => x.id)
          }
          onTagged={() => refresh()}
          onShowTags={(tags) => {
            setText("");
            setFilters({ ...emptyFilters(), tag: new Set(tags) });
            setTagMode("any");
            setPage(1);
          }}
          onClose={() => setAiOpen(false)}
        />
      )}
    </div>
  );
}

function ChangeChip({ change }: { change?: string }) {
  if (!change) return null;
  const cls: Record<string, string> = {
    new: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300",
    changed: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300",
    gone: "bg-zinc-100 text-zinc-500 ring-zinc-500/15 dark:bg-zinc-800 dark:text-zinc-400",
    unchanged: "text-zinc-400 ring-transparent",
  };
  return (
    <span className={"px-1.5 py-0.5 rounded-full ring-1 ring-inset font-medium " + (cls[change] ?? cls.unchanged)}>
      {change}
    </span>
  );
}

function cell(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
