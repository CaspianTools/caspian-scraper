"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CountrySelect } from "@/components/CountrySelect";
import { authedFetch } from "@/lib/firebase/clientFetch";
import type { ResourceRow } from "@/lib/firestore/resources";

/**
 * "Find websites" building blocks. find_websites.py searches Google Maps,
 * Google / DuckDuckGo, Wikidata, OpenStreetMap and the findings database
 * (db/) — free, no AI, no keys — saves everything to the database and caches
 * the search, then returns one list of companies.
 *
 *   useFinder()      search state + actions (search, browse, bulk actions
 *                    incl. tags);
 *                    the last results are kept in this browser (persist)
 *   <FinderForm>     the search controls (fits a sidebar)
 *   <FinderResults>  the findings — filters, sort, bulk actions, cards / rows
 */

/** One company from find_websites.py (to_finding). */
export interface Finding {
  id: string;
  name: string;
  website: string;
  careers_url: string;
  description: string;
  countries: string[];
  industries: string[];
  types: string[];
  sources: string[];
  known: boolean;
  ats: "successfactors" | "jibe" | "unknown";
  checked: boolean;
  reachable: boolean | null;
  scrapable: boolean;
  hidden: boolean;
  /** Labels people gave it (absent in results saved before tags existed). */
  tags?: string[];
}

const tagsOf = (f: Finding): string[] => f.tags ?? [];
const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface DiscoverResult {
  findings: Finding[];
  by_source: Record<string, number>;
  errors: { source: string; message: string }[];
  query_used: string;
  countries_used: string[];
  database_size: number;
  searched_at?: string;
  cached?: boolean;
  browse?: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  google_maps: "Google Maps",
  google: "Google",
  duckduckgo: "DuckDuckGo",
  wikidata: "Wikidata",
  osm: "OpenStreetMap",
  web: "Web",
  db: "In database",
};
const ATS_LABEL: Record<string, string> = { successfactors: "SuccessFactors", jibe: "Jibe / iCIMS" };

type StatusKey = "scrapable" | "careers" | "unchecked" | "none" | "broken";
const STATUS_LABEL: Record<StatusKey, string> = {
  scrapable: "Will be scraped",
  careers: "Careers page found",
  unchecked: "Not checked yet",
  none: "No careers page found",
  broken: "Careers page didn't open",
};
function statusOf(f: Finding): StatusKey {
  if (f.scrapable) return "scrapable";
  if (!f.checked) return "unchecked";
  if (f.reachable === false) return "broken";
  return f.careers_url ? "careers" : "none";
}

const PAGE = 60;
const LAST_KEY = "caspian.finder.last";

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs";
const primaryBtn =
  "inline-flex items-center justify-center h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20";
const chipBtn =
  "h-8 px-3 rounded-md text-xs border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50";

function fmtAgo(iso?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "earlier";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// ---- state -------------------------------------------------------------------

export type Finder = ReturnType<typeof useFinder>;

interface Job {
  id: string;
  name: string;
  resource_ids?: string[];
}

export function useFinder({
  defaultQuery = "",
  persist = true,
}: {
  defaultQuery?: string;
  /** Keep the last search in this browser (off for the DB page's browse). */
  persist?: boolean;
} = {}) {
  const [query, setQuery] = useState(defaultQuery);
  const [countries, setCountries] = useState<string[]>([]);
  const [useWeb, setUseWeb] = useState(true);
  const [busy, setBusy] = useState<"search" | "add" | "enrich" | "hide" | "tag" | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const restored = useRef(false);

  // Keep the last search (words, countries, results) in this browser, so
  // leaving the page or reloading doesn't start over.
  useEffect(() => {
    if (!persist) return;
    try {
      const raw = localStorage.getItem(LAST_KEY);
      if (raw) {
        const last = JSON.parse(raw);
        /* eslint-disable react-hooks/set-state-in-effect -- one-time restore of the saved search */
        if (typeof last.query === "string" && !defaultQuery) setQuery(last.query);
        if (Array.isArray(last.countries)) setCountries(last.countries);
        if (typeof last.useWeb === "boolean") setUseWeb(last.useWeb);
        if (last.result?.findings) setResult(last.result);
        /* eslint-enable react-hooks/set-state-in-effect */
      }
    } catch {
      /* storage unavailable or old format — start empty */
    }
    restored.current = true;
  }, [defaultQuery, persist]);
  useEffect(() => {
    if (!persist || !restored.current) return;
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ query, countries, useWeb, result }));
    } catch {
      /* quota exceeded — keeping results is a convenience only */
    }
  }, [persist, query, countries, useWeb, result]);

  const all = useMemo(() => result?.findings ?? [], [result]);

  function patchFindings(update: (f: Finding) => Finding | null) {
    setResult((r) =>
      r && { ...r, findings: r.findings.map(update).filter((f): f is Finding => f !== null) }
    );
  }

  async function run(body: Record<string, unknown>) {
    setBusy("search");
    setError(null);
    setNotice(null);
    try {
      const res = await authedFetch("/api/resources/discover", { method: "POST", body: JSON.stringify(body) });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.error || `Search failed (${res.status})`);
        return;
      }
      const r = b as DiscoverResult;
      setResult(r);
      setPicked(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const search = (refresh = false) => run({ query: query.trim(), countries, use_web: useWeb, refresh });
  const browse = () => run({ browse: true });

  /** Find + check careers pages for the given findings; updates them in place. */
  async function enrich(items: Finding[]): Promise<Map<string, Finding> | null> {
    const res = await authedFetch("/api/resources/enrich", {
      method: "POST",
      body: JSON.stringify({ ids: items.map((f) => f.id).slice(0, 200) }),
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(b.error || `Careers-page lookup failed (${res.status})`);
      return null;
    }
    const found = new Map<string, Finding>((b.findings as Finding[]).map((f) => [f.id, f]));
    patchFindings((f) => found.get(f.id) ?? f);
    return found;
  }

  const selected = () => all.filter((f) => picked.has(f.id));

  async function findCareersPages() {
    const chosen = selected();
    setBusy("enrich");
    setError(null);
    setProgress(`Finding careers pages for ${chosen.length}…`);
    try {
      const found = await enrich(chosen);
      if (found) {
        const n = [...found.values()].filter((f) => f.careers_url).length;
        setNotice(`Careers pages found for ${n} of ${chosen.length}. Saved to the findings database.`);
      }
    } finally {
      setBusy(null);
      setProgress("");
    }
  }

  /** Find careers pages, save the picked companies to the resource library,
   *  and optionally attach them to a job. Returns the saved rows. */
  async function addPicked(job?: Job): Promise<ResourceRow[]> {
    const chosen = selected();
    setBusy("add");
    setError(null);
    setNotice(null);
    const added: ResourceRow[] = [];
    const addedIds = new Set<string>();
    try {
      setProgress(`Finding careers pages for ${chosen.length} compan${chosen.length === 1 ? "y" : "ies"}…`);
      const found = (await enrich(chosen.filter((f) => !f.checked))) ?? new Map<string, Finding>();
      for (const [i, f0] of chosen.entries()) {
        const f = found.get(f0.id) ?? f0;
        setProgress(`Adding ${i + 1} of ${chosen.length}…`);
        const r = await authedFetch("/api/resources", {
          method: "POST",
          body: JSON.stringify({
            name: f.name.slice(0, 120),
            kind: "employer",
            ats: f.scrapable ? f.ats : "unknown",
            careers_url: f.careers_url || f.website,
            countries: f.countries.slice(0, 20),
            website: f.website.slice(0, 300),
            notes: [
              f.careers_url ? "" : "No careers page found yet - this is the company website.",
              `Found via ${f.sources.map((s) => SOURCE_LABEL[s] ?? s).join(", ")}.`,
            ]
              .filter(Boolean)
              .join(" "),
          }),
        });
        const rb = await r.json().catch(() => ({}));
        if (!r.ok) {
          setError(`Couldn't add ${f.name}: ${rb.details?.[0]?.message || rb.error || r.status}`);
          continue;
        }
        addedIds.add(f0.id);
        added.push({
          id: rb.id,
          name: rb.name,
          kind: rb.kind,
          ats: rb.ats,
          careers_url: rb.careers_url,
          active: rb.active !== false,
          countries: rb.countries ?? [],
          used_by: [],
        });
      }
      if (job && added.length > 0) {
        setProgress(`Attaching to ${job.name}…`);
        const ids = Array.from(new Set([...(job.resource_ids ?? []), ...added.map((a) => a.id)]));
        const r = await authedFetch(`/api/projects/${job.id}`, {
          method: "PATCH",
          body: JSON.stringify({ resource_ids: ids }),
        });
        if (!r.ok) setError(`Added to the library, but couldn't attach to ${job.name} (${r.status}).`);
      }
      // Added ones leave the results so they can't be added twice.
      patchFindings((f) => (addedIds.has(f.id) ? null : f));
      setPicked(new Set());
      if (added.length > 0) {
        setNotice(
          `Added ${added.length} to the library${job ? ` and attached to ${job.name}` : ""}.`
        );
      }
      return added;
    } finally {
      setBusy(null);
      setProgress("");
    }
  }

  async function setHidden(hidden: boolean) {
    const chosen = selected();
    setBusy("hide");
    setError(null);
    try {
      const res = await authedFetch("/api/resources/mark", {
        method: "POST",
        body: JSON.stringify({ ids: chosen.map((f) => f.id), hidden }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error || `Couldn't update (${res.status})`);
        return;
      }
      const ids = new Set(chosen.map((f) => f.id));
      patchFindings((f) => (ids.has(f.id) ? { ...f, hidden } : f));
      setPicked(new Set());
      setNotice(
        hidden
          ? `Hid ${chosen.length}. They stay out of results until you show hidden ones.`
          : `Unhid ${chosen.length}.`
      );
    } finally {
      setBusy(null);
    }
  }

  /** Add / remove tags on the picked findings; saved to the findings database.
   *  The selection stays, so several tags can be given in a row. */
  async function retag(add: string[], remove: string[]) {
    const chosen = selected();
    if (chosen.length === 0 || add.length + remove.length === 0) return;
    setBusy("tag");
    setError(null);
    try {
      const res = await authedFetch("/api/resources/tag", {
        method: "POST",
        body: JSON.stringify({ ids: chosen.map((f) => f.id), add, remove }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.details?.[0]?.message || b.error || `Couldn't update tags (${res.status})`);
        return;
      }
      const tags = (b.tags ?? {}) as Record<string, string[]>;
      patchFindings((f) => (f.id in tags ? { ...f, tags: tags[f.id] } : f));
      const n = Object.keys(tags).length;
      const names = (l: string[]) => l.map((t) => `“${t}”`).join(", ");
      setNotice(add.length > 0 ? `Tagged ${n} with ${names(add)}.` : `Removed ${names(remove)} from ${n}.`);
    } finally {
      setBusy(null);
    }
  }

  function toggle(id: string) {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  return {
    query, setQuery, countries, setCountries, useWeb, setUseWeb,
    busy, progress, error, notice, setNotice, result, all, picked, setPicked, toggle,
    search, browse, addPicked, findCareersPages, setHidden, retag, selected,
  };
}

// ---- form --------------------------------------------------------------------

export function FinderForm({ finder, onSearch }: { finder: Finder; onSearch?: () => void }) {
  const f = finder;
  const go = (fn: () => void) => () => {
    onSearch?.();
    fn();
  };
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold tracking-tight">Find websites</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          Searches Google Maps, Google, Wikidata and OpenStreetMap, and your findings database.
          Everything found is saved; repeat searches come back instantly. Free: no AI, no keys.
        </p>
      </div>
      <label className="block text-sm">
        <span className="block font-medium mb-1">What are you looking for?</span>
        <input
          type="text"
          value={f.query}
          onChange={(e) => f.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!f.busy) go(() => f.search())();
            }
          }}
          placeholder="Training centres, oil & gas companies…"
          className={inputCls}
        />
      </label>
      <div className="text-sm">
        <span className="block font-medium mb-1">Countries</span>
        <CountrySelect value={f.countries} onChange={f.setCountries} />
        <p className="text-xs text-zinc-500 mt-1">
          The directories and maps need countries. The first 4 are searched on Google.
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={f.useWeb}
          onChange={(e) => f.setUseWeb(e.target.checked)}
          className="w-4 h-4 mt-0.5"
        />
        Search Google Maps and the web too (slower, finds the most)
      </label>
      <button type="button" onClick={go(() => f.search())} disabled={f.busy !== null} className={primaryBtn + " w-full"}>
        {f.busy === "search" ? "Searching…" : "Search"}
      </button>
      <button
        type="button"
        onClick={go(f.browse)}
        disabled={f.busy !== null}
        className="w-full text-xs text-zinc-600 dark:text-zinc-400 hover:underline disabled:opacity-50"
      >
        Browse everything saved{f.result ? ` (${f.result.database_size} companies)` : ""}
      </button>
      {f.busy === "search" && (
        <p className="text-xs text-zinc-500">
          Looking in every source{f.useWeb ? " — Google Maps and the web take 1–3 minutes" : ""}.
        </p>
      )}
    </div>
  );
}

// ---- results -----------------------------------------------------------------

type View = "list" | "cards";
type Sort = "relevance" | "name" | "sources";
const VIEW_KEY = "caspian.finder.view";

function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>("cards");
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore of a saved preference
      if (v === "list" || v === "cards") setView(v);
    } catch {
      /* storage unavailable — keep the default */
    }
  }, []);
  return [
    view,
    (v) => {
      setView(v);
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {
        /* ignore */
      }
    },
  ];
}

type FacetKey = "tag" | "country" | "category" | "source" | "status";
type Filters = Record<FacetKey, Set<string>>;
const emptyFilters = (): Filters => ({
  tag: new Set(), country: new Set(), category: new Set(), source: new Set(), status: new Set(),
});
/** Several tags picked: a company needs any one of them, or all of them. */
type TagMode = "any" | "all";
const UNTAGGED = "(untagged)";

function facetValues(f: Finding, key: FacetKey): string[] {
  switch (key) {
    case "tag":
      return tagsOf(f).length ? tagsOf(f) : [UNTAGGED];
    case "country":
      return f.countries.length ? f.countries : ["(no country)"];
    case "category": {
      const v = [...f.types, ...f.industries].map((x) => x.trim()).filter(Boolean);
      return v.length ? Array.from(new Set(v.map((x) => x.charAt(0).toUpperCase() + x.slice(1)))) : ["(none)"];
    }
    case "source":
      return [...f.sources, ...(f.known ? ["db"] : [])];
    case "status":
      return [statusOf(f)];
  }
}
const FACET_LABEL: Record<FacetKey, string> = {
  tag: "Tags", country: "Country", category: "Category", source: "Source", status: "Status",
};
const optionLabel = (key: FacetKey, v: string) =>
  key === "source" ? (SOURCE_LABEL[v] ?? v) : key === "status" ? STATUS_LABEL[v as StatusKey] : v;

export function FinderResults({
  finder,
  onAdded,
  emptyHint = "Describe what you're looking for and press Search.",
  allowAddToJob = false,
}: {
  finder: Finder;
  onAdded: (rows: ResourceRow[]) => void;
  emptyHint?: string;
  /** Offer "Add to job…" (not inside the New-job wizard, which adds to its own job). */
  allowAddToJob?: boolean;
}) {
  const f = finder;
  const [view, setView] = useView();
  const [text, setText] = useState("");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [sort, setSort] = useState<Sort>("relevance");
  const [showHidden, setShowHidden] = useState(false);
  const [tagMode, setTagMode] = useState<TagMode>("any");
  const [shown, setShown] = useState(PAGE);

  const visibleBase = useMemo(() => f.all.filter((x) => showHidden || !x.hidden), [f.all, showHidden]);

  const matches = (x: Finding, skip?: FacetKey) => {
    for (const key of Object.keys(filters) as FacetKey[]) {
      if (key === skip || filters[key].size === 0) continue;
      const vals = facetValues(x, key);
      if (key === "tag" && tagMode === "all") {
        if (![...filters.tag].every((v) => vals.includes(v))) return false;
      } else if (!vals.some((v) => filters[key].has(v))) return false;
    }
    const needle = text.trim().toLowerCase();
    if (!needle) return true;
    return [x.name, x.website, x.description, ...x.countries, ...x.types, ...x.industries, ...tagsOf(x)]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  };

  const filtered = useMemo(() => {
    const out = visibleBase.filter((x) => matches(x));
    if (sort === "name") out.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "sources") out.sort((a, b) => b.sources.length - a.sources.length);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matches() reads filters/text
  }, [visibleBase, filters, tagMode, text, sort]);

  // Facet counts: for each facet, count within the other filters.
  const facetCounts = useMemo(() => {
    const out = {} as Record<FacetKey, [string, number][]>;
    for (const key of Object.keys(FACET_LABEL) as FacetKey[]) {
      const counts = new Map<string, number>();
      for (const x of visibleBase) {
        if (!matches(x, key)) continue;
        for (const v of facetValues(x, key)) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      out[key] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matches() reads filters/text
  }, [visibleBase, filters, tagMode, text]);

  const hiddenCount = f.all.filter((x) => x.hidden).length;
  // Every tag in use (one spelling each), for the Tags menu.
  const allTags = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of f.all) for (const t of tagsOf(x)) if (!m.has(t.toLowerCase())) m.set(t.toLowerCase(), t);
    return [...m.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [f.all]);
  const activeFilters = (Object.keys(filters) as FacetKey[]).flatMap((k) =>
    [...filters[k]].map((v) => [k, v] as const)
  );

  function toggleFilter(key: FacetKey, v: string) {
    setFilters((cur) => {
      const next = { ...cur, [key]: new Set(cur[key]) };
      if (next[key].has(v)) next[key].delete(v);
      else next[key].add(v);
      return next;
    });
    setShown(PAGE);
  }

  /** A tag chip on a result: filter by that tag too. */
  function filterTag(t: string) {
    if (!filters.tag.has(t)) toggleFilter("tag", t);
  }

  if (f.busy === "search") return <LoadingGrid view={view} />;
  if (!f.result) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center text-sm text-zinc-500 bg-white/60 dark:bg-zinc-950/40">
        {emptyHint}
      </div>
    );
  }

  const r = f.result;
  const selectedHere = filtered.filter((x) => f.picked.has(x.id)).length;
  const pickedHidden = f.all.some((x) => f.picked.has(x.id) && x.hidden);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm">
          {r.browse ? (
            <>
              <span className="font-medium">{f.all.length}</span> companies saved in the findings database
            </>
          ) : (
            <>
              <span className="font-medium">{f.all.length}</span> found for{" "}
              <span className="font-medium">“{r.query_used || "anything"}”</span>
              {r.countries_used.length > 0 && <> in {r.countries_used.join(", ")}</>}
              <span className="text-zinc-500"> · findings database: {r.database_size} companies</span>
            </>
          )}
        </p>
        {r.cached && (
          <p className="text-xs rounded-lg bg-sky-50 dark:bg-sky-950/30 px-3 py-2 flex flex-wrap items-center gap-2">
            Saved results from {fmtAgo(r.searched_at)} — nothing was searched again.
            <button type="button" className="underline" onClick={() => f.search(true)} disabled={f.busy !== null}>
              Search again
            </button>
          </p>
        )}
        {r.errors.length > 0 && (
          <div className="text-xs rounded-lg bg-amber-50 dark:bg-amber-950/30 px-3 py-2 space-y-0.5">
            {r.errors.map((e, i) => (
              <p key={i}>
                <span className="font-medium">{SOURCE_LABEL[e.source] ?? e.source}:</span> {e.message}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setShown(PAGE);
          }}
          placeholder="Filter by name, site, text…"
          className="h-8 w-56 px-2.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
        />
        {(Object.keys(FACET_LABEL) as FacetKey[]).map((key) => (
          <FacetMenu
            key={key}
            label={FACET_LABEL[key]}
            options={facetCounts[key].map(([v, n]) => ({ value: v, label: optionLabel(key, v), count: n }))}
            selected={filters[key]}
            onToggle={(v) => toggleFilter(key, v)}
            onClear={() => setFilters((cur) => ({ ...cur, [key]: new Set() }))}
            {...(key === "tag" && {
              mode: tagMode,
              onMode: setTagMode,
              hint: allTags.length === 0 ? "No tags yet. Select companies and use Tags to add some." : undefined,
            })}
          />
        ))}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className="h-8 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
          aria-label="Sort"
        >
          <option value="relevance">Sort: relevance</option>
          <option value="name">Sort: name A–Z</option>
          <option value="sources">Sort: most sources</option>
        </select>
        {hiddenCount > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show hidden ({hiddenCount})
          </label>
        )}
        <span className="mx-auto" />
        <ViewToggle view={view} onChange={setView} />
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
          {filters.tag.size > 1 && (
            <span className="text-zinc-500">Tags: match {tagMode}</span>
          )}
          <button type="button" className="underline text-zinc-500" onClick={() => setFilters(emptyFilters())}>
            Clear filters
          </button>
        </div>
      )}

      {/* Bulk actions */}
      <div className="sticky top-14 z-10 -mx-1 px-1 py-2 bg-zinc-50/90 dark:bg-black/80 backdrop-blur flex flex-wrap items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filtered.length > 0 && selectedHere === filtered.length}
            ref={(el) => {
              if (el) el.indeterminate = selectedHere > 0 && selectedHere < filtered.length;
            }}
            onChange={(e) => {
              const ids = filtered.map((x) => x.id);
              f.setPicked((p) => {
                const n = new Set(p);
                for (const id of ids) {
                  if (e.target.checked) n.add(id);
                  else n.delete(id);
                }
                return n;
              });
            }}
            aria-label="Select all shown"
          />
          {f.picked.size > 0 ? (
            <span>
              <span className="font-medium">{f.picked.size}</span> selected
            </span>
          ) : (
            <span className="text-zinc-500">
              {filtered.length} shown{filtered.length !== visibleBase.length ? ` of ${visibleBase.length}` : ""}
            </span>
          )}
        </label>
        <button type="button" className={chipBtn} onClick={() => f.setPicked(new Set(filtered.filter((x) => x.scrapable).map((x) => x.id)))}>
          Select scrapable
        </button>
        {f.picked.size > 0 && (
          <>
            <span className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-700" />
            <button
              type="button"
              disabled={f.busy !== null}
              onClick={async () => {
                const rows = await f.addPicked();
                if (rows.length > 0) onAdded(rows);
              }}
              className={primaryBtn}
            >
              {f.busy === "add" ? "Adding…" : "Add to library"}
            </button>
            {allowAddToJob && (
              <AddToJobMenu
                disabled={f.busy !== null}
                onPick={async (job) => {
                  const rows = await f.addPicked(job);
                  if (rows.length > 0) onAdded(rows);
                }}
              />
            )}
            <TagMenu tags={allTags} chosen={f.selected()} disabled={f.busy !== null} onChange={f.retag} />
            <button type="button" className={chipBtn} disabled={f.busy !== null} onClick={f.findCareersPages}>
              {f.busy === "enrich" ? "Finding…" : "Find careers pages"}
            </button>
            <button type="button" className={chipBtn} onClick={() => exportCsv(f.selected())}>
              Export CSV
            </button>
            <button
              type="button"
              className={chipBtn}
              onClick={async () => {
                const links = f.selected().map((x) => x.careers_url || x.website).join("\n");
                try {
                  await navigator.clipboard.writeText(links);
                  f.setNotice(`Copied ${f.picked.size} links.`);
                } catch {
                  f.setNotice("Couldn't copy — the browser blocked clipboard access.");
                }
              }}
            >
              Copy links
            </button>
            <button type="button" className={chipBtn} disabled={f.busy !== null} onClick={() => f.setHidden(!pickedHidden)}>
              {pickedHidden ? "Unhide" : "Hide"}
            </button>
            <button type="button" className="text-xs text-zinc-500 hover:underline" onClick={() => f.setPicked(new Set())}>
              Clear selection
            </button>
          </>
        )}
      </div>
      {(f.progress || f.notice) && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400 flex items-center gap-2">
          {f.progress || f.notice}
          {f.notice && !f.progress && (
            <button type="button" className="text-zinc-400 hover:text-zinc-700" onClick={() => f.setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          )}
        </p>
      )}

      {filtered.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {f.all.length === 0 ? "Nothing matched — try other words or countries." : "No results match the filters."}
        </p>
      ) : view === "cards" ? (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filtered.slice(0, shown).map((x) => (
            <ResultCard key={x.id} f={x} picked={f.picked.has(x.id)} onToggle={f.toggle} onTag={filterTag} />
          ))}
        </div>
      ) : (
        <ul className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 divide-y divide-zinc-100 dark:divide-zinc-800">
          {filtered.slice(0, shown).map((x) => (
            <ResultRow key={x.id} f={x} picked={f.picked.has(x.id)} onToggle={f.toggle} onTag={filterTag} />
          ))}
        </ul>
      )}
      {filtered.length > shown && (
        <div className="text-center">
          <button type="button" className={chipBtn + " h-9 px-4"} onClick={() => setShown((n) => n + PAGE)}>
            Show more ({filtered.length - shown} left)
          </button>
        </div>
      )}
      {f.error && <p className="text-sm text-red-600">{f.error}</p>}
    </div>
  );
}

function exportCsv(items: Finding[]) {
  const cols = ["name", "website", "careers_url", "countries", "category", "sources", "status", "tags"] as const;
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = items.map((x) =>
    [
      x.name,
      x.website,
      x.careers_url,
      x.countries.join("; "),
      [...x.types, ...x.industries].join("; "),
      x.sources.map((s) => SOURCE_LABEL[s] ?? s).join("; "),
      STATUS_LABEL[statusOf(x)],
      tagsOf(x).join("; "),
    ].map(esc).join(",")
  );
  const blob = new Blob(["﻿" + [cols.join(","), ...rows].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `findings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Dismisses a popover when clicking outside it. */
function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

function FacetMenu({
  label,
  options,
  selected,
  onToggle,
  onClear,
  mode,
  onMode,
  hint,
}: {
  label: string;
  options: { value: string; label: string; count: number }[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  onClear: () => void;
  /** Offer "match any / all" of the picked values (Tags). */
  mode?: TagMode;
  onMode?: (m: TagMode) => void;
  /** Shown under the options (e.g. how to make some). */
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useOutside(open, () => setOpen(false));
  const shownOpts = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={
          "h-8 px-3 rounded-md text-xs border inline-flex items-center gap-1 " +
          (selected.size > 0
            ? "border-brand-300 bg-brand-50/60 text-brand-800 dark:border-brand-400/40 dark:bg-brand-500/10 dark:text-brand-200 font-medium"
            : "border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900")
        }
      >
        {label}
        {selected.size > 0 && <span className="px-1.5 rounded bg-brand-600 text-white dark:bg-brand-500">{selected.size}</span>}
        <span aria-hidden className="text-zinc-400">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-72 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-lg p-2 space-y-2">
          {options.length > 8 && (
            <input
              type="search"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="w-full h-8 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
            />
          )}
          <ul className="max-h-64 overflow-y-auto text-sm">
            {shownOpts.map((o) => (
              <li key={o.value}>
                <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-50 dark:hover:bg-zinc-900 cursor-pointer">
                  <input type="checkbox" checked={selected.has(o.value)} onChange={() => onToggle(o.value)} />
                  <span className="flex-1 truncate">{o.label}</span>
                  <span className="text-xs text-zinc-500">{o.count}</span>
                </label>
              </li>
            ))}
            {shownOpts.length === 0 && <li className="px-2 py-1 text-xs text-zinc-500">Nothing matches.</li>}
          </ul>
          {hint && <p className="px-2 text-xs text-zinc-500">{hint}</p>}
          {mode && onMode && (
            <div className="flex items-center gap-2 px-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <span className="text-xs text-zinc-500">Match</span>
              <div className="inline-flex p-0.5 rounded-md bg-zinc-100 dark:bg-zinc-900">
                {(["any", "all"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => onMode(m)}
                    title={m === "any" ? "Has at least one of the picked tags" : "Has every picked tag"}
                    className={
                      "h-6 px-2 rounded text-xs " +
                      (mode === m
                        ? "bg-white dark:bg-zinc-800 shadow-sm font-medium text-zinc-900 dark:text-zinc-100"
                        : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")
                    }
                  >
                    {m === "any" ? "Any" : "All"}
                  </button>
                ))}
              </div>
              <span className="text-[11px] text-zinc-400">of the picked tags</span>
            </div>
          )}
          {selected.size > 0 && (
            <button type="button" className="text-xs text-zinc-500 hover:underline px-2" onClick={onClear}>
              Clear {label.toLowerCase()}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AddToJobMenu({ disabled, onPick }: { disabled: boolean; onPick: (job: Job) => void }) {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useOutside(open, () => setOpen(false));

  async function load() {
    setOpen((v) => !v);
    if (jobs !== null) return;
    try {
      const res = await authedFetch("/api/projects");
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error || String(res.status));
      setJobs((b.projects ?? []).map((p: Job) => ({ id: p.id, name: p.name, resource_ids: p.resource_ids })));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" disabled={disabled} onClick={load} className={chipBtn} aria-expanded={open}>
        Add to job… <span aria-hidden className="text-zinc-400">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-64 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-lg p-1 text-sm">
          {err ? (
            <p className="px-2 py-1.5 text-xs text-red-600">Couldn&apos;t load jobs: {err}</p>
          ) : jobs === null ? (
            <p className="px-2 py-1.5 text-xs text-zinc-500">Loading jobs…</p>
          ) : jobs.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-zinc-500">No jobs yet — create one first.</p>
          ) : (
            jobs.map((j) => (
              <button
                key={j.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(j);
                }}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-zinc-50 dark:hover:bg-zinc-900 truncate"
              >
                {j.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Bulk "Tags" menu for the selected findings: tick a tag to give it to all
 * of them, untick to take it off (a dash means only some have it); type to
 * find a tag or create a new one.
 */
function TagMenu({
  tags,
  chosen,
  disabled,
  onChange,
}: {
  tags: string[];
  chosen: Finding[];
  disabled: boolean;
  onChange: (add: string[], remove: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useOutside(open, () => setOpen(false));
  const query = q.trim().replace(/\s+/g, " ").slice(0, 40);
  const shownTags = tags.filter((t) => !query || t.toLowerCase().includes(query.toLowerCase()));
  const existing = query ? tags.find((t) => sameTag(t, query)) : undefined;
  const countWith = (t: string) => chosen.filter((x) => tagsOf(x).some((y) => sameTag(y, t))).length;
  const onSelected = tags.filter((t) => countWith(t) > 0);

  function flip(t: string) {
    if (countWith(t) === chosen.length) onChange([], [t]);
    else onChange([t], []);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={chipBtn + " inline-flex items-center gap-1.5"}
      >
        <TagIcon className="w-3.5 h-3.5 text-zinc-500" />
        Tags <span aria-hidden className="text-zinc-400">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-72 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-lg p-2 space-y-2">
          <input
            type="text"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !query || disabled) return;
              e.preventDefault();
              if (existing) flip(existing);
              else onChange([query], []);
              setQ("");
            }}
            placeholder={tags.length ? "Find or create a tag…" : "Name a new tag…"}
            aria-label="Find or create a tag"
            className="w-full h-8 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
          />
          <p className="px-2 text-[11px] text-zinc-500">
            For the {chosen.length} selected compan{chosen.length === 1 ? "y" : "ies"}. Ticked: all have it.
          </p>
          <ul className="max-h-64 overflow-y-auto text-sm">
            {shownTags.map((t) => {
              const n = countWith(t);
              return (
                <li key={t}>
                  <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-zinc-50 dark:hover:bg-zinc-900 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={n > 0 && n === chosen.length}
                      ref={(el) => {
                        if (el) el.indeterminate = n > 0 && n < chosen.length;
                      }}
                      disabled={disabled}
                      onChange={() => flip(t)}
                    />
                    <span className="flex-1 truncate">{t}</span>
                    {n > 0 && n < chosen.length && (
                      <span className="text-xs text-zinc-500" title={`${n} of the selected have it`}>
                        {n}/{chosen.length}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
            {query && !existing && (
              <li>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onChange([query], []);
                    setQ("");
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded text-left text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10"
                >
                  <span aria-hidden>+</span>
                  <span className="truncate">
                    Create “<span className="font-medium">{query}</span>”
                  </span>
                </button>
              </li>
            )}
            {!query && tags.length === 0 && (
              <li className="px-2 py-1 text-xs text-zinc-500">No tags yet. Type a name and press Enter.</li>
            )}
          </ul>
          {onSelected.length > 0 && (
            <button
              type="button"
              disabled={disabled}
              className="text-xs text-zinc-500 hover:text-red-600 hover:underline px-2"
              onClick={() => onChange([], onSelected)}
            >
              Remove all tags from the selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const btn = (v: View, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      aria-pressed={view === v}
      title={`${label} view`}
      onClick={() => onChange(v)}
      className={
        "h-7 px-2 inline-flex items-center gap-1 text-xs rounded-md " +
        (view === v
          ? "bg-white dark:bg-zinc-800 shadow-sm text-zinc-900 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")
      }
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div className="inline-flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
      {btn(
        "list",
        "List",
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M5 4h9M5 8h9M5 12h9M2 4h.01M2 8h.01M2 12h.01" strokeLinecap="round" />
        </svg>
      )}
      {btn(
        "cards",
        "Cards",
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <rect x="9" y="9" width="5" height="5" rx="1" />
        </svg>
      )}
    </div>
  );
}

function Chip({ children, tone = "plain", title }: { children: React.ReactNode; tone?: string; title?: string }) {
  const cls: Record<string, string> = {
    plain: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    source: "bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
    known: "bg-violet-50 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
    good: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25",
    warn: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25",
    bad: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/25",
  };
  return (
    <span title={title} className={"text-[11px] leading-4 px-1.5 py-0.5 rounded whitespace-nowrap " + cls[tone]}>
      {children}
    </span>
  );
}

function TagIcon({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
      <path d="M2 2.5v5l6.5 6.5 5-5L7 2.5z" />
      <circle cx="5" cy="5.5" r=".9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A finding's tags; clicking one filters by it. */
function TagChips({ tags, onTag }: { tags: string[]; onTag?: (t: string) => void }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <button
          key={t}
          type="button"
          title={onTag ? `Show companies tagged “${t}”` : undefined}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onTag?.(t);
          }}
          className="inline-flex items-center gap-1 text-[11px] leading-4 px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-600/20 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-400/25 dark:hover:bg-brand-500/20"
        >
          <TagIcon />
          {t}
        </button>
      ))}
    </span>
  );
}

/** Status, sources, place and kind — the chips every finding shows. */
function Chips({ f }: { f: Finding }) {
  const st = statusOf(f);
  const tone = { scrapable: "good", careers: "warn", unchecked: "plain", none: "warn", broken: "bad" }[st];
  const text =
    st === "scrapable" ? `${ATS_LABEL[f.ats]} — will be scraped`
      : st === "careers" ? "careers page found — not scraped yet"
        : st === "unchecked" ? "careers page not checked yet"
          : st === "broken" ? "careers page didn't open" : "no careers page found";
  const kinds = [...f.types, ...f.industries].filter(Boolean);
  return (
    <span className="flex flex-wrap gap-1">
      <Chip tone={tone}>{text}</Chip>
      {f.hidden && <Chip tone="bad">hidden</Chip>}
      {f.known && <Chip tone="known">In database</Chip>}
      {f.sources.map((s) => (
        <Chip key={s} tone="source">
          {SOURCE_LABEL[s] ?? s}
        </Chip>
      ))}
      {f.countries.slice(0, 3).map((c) => (
        <Chip key={c}>{c}</Chip>
      ))}
      {kinds.slice(0, 2).map((k) => (
        <Chip key={k}>{k}</Chip>
      ))}
    </span>
  );
}

function UrlLink({ url }: { url: string }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="block text-xs text-zinc-500 font-mono truncate hover:underline"
      title={url}
    >
      {url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
    </a>
  );
}

interface ResultProps {
  f: Finding;
  picked: boolean;
  onToggle: (id: string) => void;
  /** Clicking a tag chip (filters by it). */
  onTag?: (t: string) => void;
}

function ResultRow({ f, picked, onToggle, onTag }: ResultProps) {
  return (
    <li className={f.hidden ? "opacity-60" : ""}>
      <label className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
        <input type="checkbox" checked={picked} onChange={() => onToggle(f.id)} className="w-4 h-4 mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-medium">{f.name}</span>
            <TagChips tags={tagsOf(f)} onTag={onTag} />
            <Chips f={f} />
          </span>
          <UrlLink url={f.careers_url || f.website} />
          {f.description && <span className="block text-xs text-zinc-500 line-clamp-1">{f.description}</span>}
        </span>
      </label>
    </li>
  );
}

function ResultCard({ f, picked, onToggle, onTag }: ResultProps) {
  return (
    <label
      className={
        "relative flex flex-col gap-2 rounded-xl border bg-white dark:bg-zinc-950 p-4 cursor-pointer transition-colors " +
        (f.hidden ? "opacity-60 " : "") +
        (picked
          ? "border-brand-500 ring-1 ring-brand-500 bg-brand-50/30 dark:bg-brand-500/5"
          : "border-zinc-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600")
      }
    >
      <input
        type="checkbox"
        checked={picked}
        onChange={() => onToggle(f.id)}
        className="absolute top-3 right-3 w-4 h-4"
        aria-label={`Select ${f.name}`}
      />
      <span className="flex items-center gap-2 pr-6">
        <span className="w-8 h-8 shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-sm font-semibold text-zinc-600 dark:text-zinc-300">
          {f.name.trim().charAt(0).toUpperCase()}
        </span>
        <span className="text-sm font-medium leading-tight line-clamp-2">{f.name}</span>
      </span>
      <UrlLink url={f.careers_url || f.website} />
      <TagChips tags={tagsOf(f)} onTag={onTag} />
      <Chips f={f} />
      {f.description && <span className="text-xs text-zinc-500 line-clamp-2">{f.description}</span>}
    </label>
  );
}

function LoadingGrid({ view }: { view: View }) {
  const n = view === "cards" ? 8 : 6;
  return (
    <div className={view === "cards" ? "grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" : "space-y-2"}>
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          className={
            "rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 animate-pulse " +
            (view === "cards" ? "h-36" : "h-14")
          }
        />
      ))}
    </div>
  );
}
