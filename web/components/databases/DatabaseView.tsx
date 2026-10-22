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

/** What the server page sends (lib/databases.ts DatabaseInfo). */
export interface DatabaseMeta {
  id: string;
  name: string;
  key: "domain" | "url" | "id";
  record_label: { singular: string; plural: string };
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
  const noun = db.record_label.plural;
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
      for (const [k, v] of Object.entries(extra)) q.set(k, v);
      return q;
    },
    [filters, tagMode, query, showHidden]
  );

  useEffect(() => {
    let live = true;
    const q = params({ sort, page: String(page), size: String(SIZE) });
    apiFetch(`/api/databases/${db.id}/records?${q}`)
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
  }, [db.id, params, sort, page, reload]);

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
    q.set("select", "1");
    const res = await apiFetch(`/api/databases/${db.id}/records?${q}`);
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
        body: JSON.stringify({ ...body, database: db.id, ids: ids.slice(i, i + IDS_PER_CALL) }),
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

  function exportCsv() {
    const q = selected.size > 0 ? new URLSearchParams({ ids: [...selected.keys()].join(",") }) : params();
    window.location.href = `/api/databases/${db.id}/export?${q}`;
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
    const counts = new Map<string, number>();
    for (const x of onPage) for (const k of Object.keys(x.record ?? {})) if (!HIDDEN_FIELDS.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
  }, [companies, onPage]);

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
          {data.totalAll === 0 ? `No ${noun} yet. Jobs that save into this database add them as they run.` : `No ${noun} match the filters.`}
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
                    {c.replace(/_/g, " ")}
                  </th>
                ))}
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

function cell(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
