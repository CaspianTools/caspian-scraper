"use client";

import { useEffect, useMemo, useState } from "react";
import { CountrySelect } from "@/components/CountrySelect";
import { authedFetch } from "@/lib/firebase/clientFetch";
import type { ResourceRow } from "@/lib/firestore/resources";

/**
 * "Find websites" building blocks. find_websites.py searches Google Maps,
 * Google / DuckDuckGo, Wikidata, OpenStreetMap and the findings database
 * (db/) — free, no AI, no keys — saves everything to the database, and
 * returns one list of companies. Picked ones get their careers page found
 * (/api/resources/enrich) and are added to the resource library.
 *
 *   useFinder()      search state + actions, shared by the two parts below
 *   <FinderForm>     the search controls (fits a sidebar)
 *   <FinderResults>  one list of findings — cards or rows, with chips
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
}

export interface DiscoverResult {
  findings: Finding[];
  by_source: Record<string, number>;
  errors: { source: string; message: string }[];
  query_used: string;
  countries_used: string[];
  database_size: number;
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
const PAGE = 60;

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400";
const primaryBtn =
  "inline-flex items-center justify-center h-9 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200";
const chipBtn =
  "h-7 px-2.5 rounded-md text-xs border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900";

// ---- state -------------------------------------------------------------------

export type Finder = ReturnType<typeof useFinder>;

export function useFinder({ defaultQuery = "" }: { defaultQuery?: string } = {}) {
  const [query, setQuery] = useState(defaultQuery);
  const [countries, setCountries] = useState<string[]>([]);
  const [useWeb, setUseWeb] = useState(true);
  const [busy, setBusy] = useState<"search" | "add" | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const all = useMemo(() => result?.findings ?? [], [result]);

  async function search() {
    setBusy("search");
    setError(null);
    setResult(null);
    try {
      const res = await authedFetch("/api/resources/discover", {
        method: "POST",
        body: JSON.stringify({ query: query.trim(), countries, use_web: useWeb }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.error || `Search failed (${res.status})`);
        return;
      }
      const r = b as DiscoverResult;
      setResult(r);
      setPicked(new Set(r.findings.filter((f) => f.scrapable).map((f) => f.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** Find careers pages for the picked companies, then save them to the
   *  resource library; returns the saved rows. */
  async function addPicked(): Promise<ResourceRow[]> {
    setBusy("add");
    setError(null);
    const chosen = all.filter((f) => picked.has(f.id));
    const added: ResourceRow[] = [];
    const addedIds = new Set<string>();
    try {
      setProgress(`Finding careers pages for ${chosen.length} compan${chosen.length === 1 ? "y" : "ies"}…`);
      const res = await authedFetch("/api/resources/enrich", {
        method: "POST",
        body: JSON.stringify({ ids: chosen.map((f) => f.id).slice(0, 200) }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.error || `Careers-page lookup failed (${res.status})`);
        return [];
      }
      const enriched = new Map<string, Finding>((b.findings as Finding[]).map((f) => [f.id, f]));

      for (const [i, f0] of chosen.entries()) {
        const f = enriched.get(f0.id) ?? f0;
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
      // Added ones leave the results so they can't be added twice; the rest
      // pick up any careers pages found.
      setResult((r) =>
        r && {
          ...r,
          findings: r.findings
            .filter((f) => !addedIds.has(f.id))
            .map((f) => enriched.get(f.id) ?? f),
        }
      );
      setPicked(new Set());
      return added;
    } finally {
      setBusy(null);
      setProgress("");
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

  function selectIds(ids: string[]) {
    setPicked(new Set(ids));
  }

  return {
    query, setQuery, countries, setCountries, useWeb, setUseWeb,
    busy, progress, error, result, all, picked, toggle, selectIds, search, addPicked,
  };
}

// ---- form --------------------------------------------------------------------

export function FinderForm({ finder, onSearch }: { finder: Finder; onSearch?: () => void }) {
  const f = finder;
  const run = () => {
    onSearch?.();
    f.search();
  };
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold tracking-tight">Find websites</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          Searches Google Maps, Google, Wikidata and OpenStreetMap, and your findings database.
          Everything found is saved to the database. Free: no AI, no keys.
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
              if (!f.busy) run();
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
      <button type="button" onClick={run} disabled={f.busy !== null} className={primaryBtn + " w-full"}>
        {f.busy === "search" ? "Searching…" : "Search"}
      </button>
      {f.busy === "search" && (
        <p className="text-xs text-zinc-500">
          Looking in every source{f.useWeb ? " — Google Maps and the web take 1–3 minutes" : ""}.
        </p>
      )}
      {f.error && <p className="text-sm text-red-600">{f.error}</p>}
    </div>
  );
}

// ---- results -----------------------------------------------------------------

type View = "list" | "cards";
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

export function FinderResults({
  finder,
  onAdded,
  emptyHint = "Describe what you're looking for and press Search.",
}: {
  finder: Finder;
  onAdded: (rows: ResourceRow[]) => void;
  emptyHint?: string;
}) {
  const f = finder;
  const [view, setView] = useView();
  const [text, setText] = useState("");
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return f.all.filter((x) => {
      if (sources.size > 0) {
        const own = new Set([...x.sources, ...(x.known ? ["db"] : [])]);
        if (![...sources].some((s) => own.has(s))) return false;
      }
      if (!needle) return true;
      return [x.name, x.website, x.description, ...x.countries, ...x.types, ...x.industries]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [f.all, text, sources]);

  if (f.busy === "search") return <LoadingGrid view={view} />;
  if (!f.result) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center text-sm text-zinc-500">
        {emptyHint}
      </div>
    );
  }

  const r = f.result;
  const counts = Object.entries(r.by_source).filter(([, n]) => n > 0);
  const scrapable = f.all.filter((x) => x.scrapable).length;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm">
          <span className="font-medium">{f.all.length}</span> found for{" "}
          <span className="font-medium">“{r.query_used || "anything"}”</span>
          {r.countries_used.length > 0 && <> in {r.countries_used.join(", ")}</>}
          {scrapable > 0 && <span className="text-emerald-700 dark:text-emerald-400"> · {scrapable} scrapable now</span>}
          <span className="text-zinc-500"> · findings database: {r.database_size} companies</span>
        </p>
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

      <div className="sticky top-0 z-10 -mx-1 px-1 py-2 bg-zinc-50/90 dark:bg-black/80 backdrop-blur flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setShown(PAGE);
          }}
          placeholder="Filter results…"
          className="h-8 w-48 px-2.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
        />
        <div className="flex flex-wrap items-center gap-1">
          {counts.map(([s, n]) => {
            const on = sources.has(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setSources((cur) => {
                    const next = new Set(cur);
                    if (next.has(s)) next.delete(s);
                    else next.add(s);
                    return next;
                  });
                  setShown(PAGE);
                }}
                className={
                  "h-7 px-2.5 rounded-full text-xs border " +
                  (on
                    ? "bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900")
                }
              >
                {SOURCE_LABEL[s] ?? s} {n}
              </button>
            );
          })}
        </div>
        <span className="mx-auto" />
        <span className="text-xs text-zinc-500">{f.picked.size} selected</span>
        <button type="button" className={chipBtn} onClick={() => f.selectIds(filtered.map((x) => x.id))}>
          All shown
        </button>
        <button type="button" className={chipBtn} onClick={() => f.selectIds([])}>
          None
        </button>
        <ViewToggle view={view} onChange={setView} />
        <button
          type="button"
          disabled={f.busy !== null || f.picked.size === 0}
          onClick={async () => {
            const rows = await f.addPicked();
            if (rows.length > 0) onAdded(rows);
          }}
          className={primaryBtn}
        >
          {f.busy === "add" ? "Adding…" : `Add ${f.picked.size} to library`}
        </button>
      </div>
      {f.progress && <p className="text-xs text-zinc-500">{f.progress}</p>}

      {filtered.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {f.all.length === 0 ? "Nothing matched — try other words or countries." : "No results match the filter."}
        </p>
      ) : view === "cards" ? (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filtered.slice(0, shown).map((x) => (
            <ResultCard key={x.id} f={x} picked={f.picked.has(x.id)} onToggle={f.toggle} />
          ))}
        </div>
      ) : (
        <ul className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 divide-y divide-zinc-100 dark:divide-zinc-800">
          {filtered.slice(0, shown).map((x) => (
            <ResultRow key={x.id} f={x} picked={f.picked.has(x.id)} onToggle={f.toggle} />
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
    good: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    bad: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  };
  return (
    <span title={title} className={"text-[11px] leading-4 px-1.5 py-0.5 rounded whitespace-nowrap " + cls[tone]}>
      {children}
    </span>
  );
}

/** Status, sources, place and kind — the chips every finding shows. */
function Chips({ f }: { f: Finding }) {
  const status = f.scrapable ? (
    <Chip tone="good">{ATS_LABEL[f.ats]} — will be scraped</Chip>
  ) : !f.checked ? (
    <Chip tone="plain" title="The careers page is looked up when you add it">careers page not checked yet</Chip>
  ) : f.reachable === false ? (
    <Chip tone="bad">careers page didn&apos;t open</Chip>
  ) : f.careers_url ? (
    <Chip tone="warn">other platform — saved, not scraped yet</Chip>
  ) : (
    <Chip tone="warn">no careers page found</Chip>
  );
  const kinds = [...f.types, ...f.industries].filter(Boolean);
  return (
    <span className="flex flex-wrap gap-1">
      {status}
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

function ResultRow({ f, picked, onToggle }: { f: Finding; picked: boolean; onToggle: (id: string) => void }) {
  return (
    <li>
      <label className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
        <input type="checkbox" checked={picked} onChange={() => onToggle(f.id)} className="w-4 h-4 mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-medium">{f.name}</span>
            <Chips f={f} />
          </span>
          <UrlLink url={f.careers_url || f.website} />
          {f.description && <span className="block text-xs text-zinc-500 line-clamp-1">{f.description}</span>}
        </span>
      </label>
    </li>
  );
}

function ResultCard({ f, picked, onToggle }: { f: Finding; picked: boolean; onToggle: (id: string) => void }) {
  return (
    <label
      className={
        "relative flex flex-col gap-2 rounded-xl border bg-white dark:bg-zinc-950 p-4 cursor-pointer transition-colors " +
        (picked
          ? "border-zinc-900 dark:border-zinc-100 ring-1 ring-zinc-900 dark:ring-zinc-100"
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
