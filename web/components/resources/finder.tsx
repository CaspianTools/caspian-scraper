"use client";

import { useEffect, useMemo, useState } from "react";
import { CountrySelect } from "@/components/CountrySelect";
import { authedFetch } from "@/lib/firebase/clientFetch";
import type { ResourceRow } from "@/lib/firestore/resources";

/**
 * "Find websites" building blocks: the app proposes careers sites — from the
 * built-in employer list, companies in the chosen countries (Wikidata) and
 * DuckDuckGo/Google searches run in a browser (find_websites.py: free, no AI,
 * no keys) — after opening each one to check it works and which platform it
 * runs on. Ticked ones are saved to the shared library.
 *
 *   useFinder()      search state + actions, shared by the two parts below
 *   <FinderForm>     the search controls (fits a sidebar)
 *   <FinderResults>  results as a list or cards, with select + "Add to library"
 */

/** One suggestion from POST /api/resources/discover (find_websites.py). */
export interface Suggestion {
  name: string;
  careers_url: string;
  countries: string[];
  ats: "successfactors" | "jibe" | "unknown";
  reachable: boolean;
  scrapable: boolean;
  note: string;
  why: string;
  source: "catalog" | "directory" | "web";
}

export interface DiscoverResult {
  catalog: Suggestion[];
  directory: Suggestion[];
  web: Suggestion[];
  directory_status: "ok" | "error" | "off";
  directory_error: string;
  web_status: "ok" | "blocked" | "error" | "off";
  web_error: string;
}

const SOURCE_NOTE: Record<Suggestion["source"], string> = {
  catalog: "From the built-in employer list.",
  directory: "Found in the Wikidata company directory.",
  web: "Found by web search.",
};
const ATS_LABEL: Record<string, string> = { successfactors: "SuccessFactors", jibe: "Jibe / iCIMS" };

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
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const all = useMemo(
    () => (result ? [...result.directory, ...result.web, ...result.catalog] : []),
    [result]
  );

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
      // Pre-tick only what will actually be scraped today.
      setPicked(new Set([...r.directory, ...r.web, ...r.catalog].filter((s) => s.scrapable).map((s) => s.careers_url)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** Save the ticked suggestions to the library; returns the saved rows. */
  async function addPicked(): Promise<ResourceRow[]> {
    setBusy("add");
    setError(null);
    const added: ResourceRow[] = [];
    try {
      for (const s of all.filter((x) => picked.has(x.careers_url))) {
        const res = await authedFetch("/api/resources", {
          method: "POST",
          body: JSON.stringify({
            name: s.name,
            kind: "employer",
            ats: s.ats,
            careers_url: s.careers_url,
            countries: s.countries,
            notes: [s.why, SOURCE_NOTE[s.source]].filter(Boolean).join(" "),
          }),
        });
        const b = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(`Couldn't add ${s.name}: ${b.details?.[0]?.message || b.error || res.status}`);
          continue;
        }
        added.push({
          id: b.id,
          name: b.name,
          kind: b.kind,
          ats: b.ats,
          careers_url: b.careers_url,
          active: b.active !== false,
          countries: b.countries ?? [],
          used_by: [],
        });
      }
      // Saved ones leave the results so they can't be added twice.
      const savedUrls = new Set(added.map((a) => a.careers_url));
      setResult((r) =>
        r && {
          ...r,
          catalog: r.catalog.filter((s) => !savedUrls.has(s.careers_url)),
          directory: r.directory.filter((s) => !savedUrls.has(s.careers_url)),
          web: r.web.filter((s) => !savedUrls.has(s.careers_url)),
        }
      );
      setPicked(new Set());
      return added;
    } finally {
      setBusy(null);
    }
  }

  function toggle(url: string) {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(url)) n.delete(url);
      else n.add(url);
      return n;
    });
  }

  function selectWhere(pred: (s: Suggestion) => boolean) {
    setPicked(new Set(all.filter(pred).map((s) => s.careers_url)));
  }

  return {
    query, setQuery, countries, setCountries, useWeb, setUseWeb,
    busy, error, result, all, picked, toggle, selectWhere, search, addPicked,
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
          Careers sites from the built-in employer list, companies in the chosen countries and a
          web search — each opened to check it works. Free: no AI, no keys.
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
          placeholder="HSE jobs in oil & gas"
          className={inputCls}
        />
      </label>
      <div className="text-sm">
        <span className="block font-medium mb-1">
          Countries <span className="text-zinc-500 font-normal">(optional)</span>
        </span>
        <CountrySelect value={f.countries} onChange={f.setCountries} />
      </div>
      <label className="flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={f.useWeb}
          onChange={(e) => f.setUseWeb(e.target.checked)}
          className="w-4 h-4 mt-0.5"
        />
        Also look online (company directory + web search)
      </label>
      <button type="button" onClick={run} disabled={f.busy !== null} className={primaryBtn + " w-full"}>
        {f.busy === "search" ? "Searching…" : "Search"}
      </button>
      {f.busy === "search" && (
        <p className="text-xs text-zinc-500">
          Checking every suggestion{f.useWeb ? " and looking online" : ""} — usually about a minute.
        </p>
      )}
      {f.result && <SearchNotes result={f.result} countriesChosen={f.countries.length > 0} />}
      {f.error && <p className="text-sm text-red-600">{f.error}</p>}
    </div>
  );
}

function SearchNotes({ result, countriesChosen }: { result: DiscoverResult; countriesChosen: boolean }) {
  const notes: string[] = [];
  if (result.web_status !== "off" && result.directory_status === "off" && !countriesChosen) {
    notes.push("Pick countries (or name a region like “Middle East”) to also get companies from the directory.");
  }
  if (result.directory_status === "error") {
    notes.push(`The company directory didn't answer (${result.directory_error}). Try again in a moment.`);
  }
  if (result.web_status === "blocked") {
    notes.push("The search engines are limiting automated searches right now — try again in a few minutes.");
  } else if (result.web_status === "error") {
    notes.push(`Web search failed: ${result.web_error}`);
  }
  if (notes.length === 0) return null;
  return (
    <div className="text-xs rounded-lg bg-amber-50 dark:bg-amber-950/30 px-3 py-2 space-y-1">
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
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

  if (f.busy === "search") return <LoadingGrid view={view} />;
  if (!f.result) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center text-sm text-zinc-500">
        {emptyHint}
      </div>
    );
  }

  const groups: { title: string; items: Suggestion[] }[] = [
    { title: "Companies in the chosen countries", items: f.result.directory },
    { title: "Found on the web", items: f.result.web },
    { title: "From the built-in employer list", items: f.result.catalog },
  ].filter((g) => g.items.length > 0);
  const total = f.all.length;
  const scrapable = f.all.filter((s) => s.scrapable).length;

  return (
    <div className="space-y-5">
      <div className="sticky top-0 z-10 -mx-1 px-1 py-2 bg-zinc-50/90 dark:bg-black/80 backdrop-blur flex flex-wrap items-center gap-2">
        <p className="text-sm mr-auto">
          <span className="font-medium">{total}</span> found ·{" "}
          <span className="text-emerald-700 dark:text-emerald-400">{scrapable} scrapable now</span> ·{" "}
          {f.picked.size} selected
        </p>
        <div className="flex items-center gap-1">
          <button type="button" className={chipBtn} onClick={() => f.selectWhere((s) => s.scrapable)}>
            Scrapable
          </button>
          <button type="button" className={chipBtn} onClick={() => f.selectWhere(() => true)}>
            All
          </button>
          <button type="button" className={chipBtn} onClick={() => f.selectWhere(() => false)}>
            None
          </button>
        </div>
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

      {total === 0 ? (
        <p className="text-sm text-zinc-500">Nothing new matched — try other words or countries.</p>
      ) : (
        groups.map((g) => (
          <section key={g.title}>
            <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-2">
              {g.title} <span className="normal-case tracking-normal">({g.items.length})</span>
            </h3>
            {view === "cards" ? (
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {g.items.map((s) => (
                  <ResultCard key={s.careers_url} s={s} picked={f.picked.has(s.careers_url)} onToggle={f.toggle} />
                ))}
              </div>
            ) : (
              <ul className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 divide-y divide-zinc-100 dark:divide-zinc-800">
                {g.items.map((s) => (
                  <ResultRow key={s.careers_url} s={s} picked={f.picked.has(s.careers_url)} onToggle={f.toggle} />
                ))}
              </ul>
            )}
          </section>
        ))
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

function StatusBadge({ s }: { s: Suggestion }) {
  const [cls, text] = !s.reachable
    ? ["bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300", "couldn't check"]
    : s.scrapable
      ? ["bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300", `${ATS_LABEL[s.ats]} — will be scraped`]
      : ["bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300", "saved, not scraped yet"];
  return <span className={"text-xs px-1.5 py-0.5 rounded whitespace-nowrap " + cls}>{text}</span>;
}

function UrlLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="block text-xs text-zinc-500 font-mono truncate hover:underline"
      title={url}
    >
      {url.replace(/^https?:\/\/(www\.)?/, "")}
    </a>
  );
}

function ResultRow({ s, picked, onToggle }: { s: Suggestion; picked: boolean; onToggle: (url: string) => void }) {
  return (
    <li>
      <label className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
        <input type="checkbox" checked={picked} onChange={() => onToggle(s.careers_url)} className="w-4 h-4 mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{s.name}</span>
            <StatusBadge s={s} />
            {s.countries.length > 0 && <span className="text-xs text-zinc-500">{s.countries.slice(0, 4).join(", ")}</span>}
          </span>
          <UrlLink url={s.careers_url} />
          {(s.why || s.note) && (
            <span className="block text-xs text-zinc-500 mt-0.5">{[s.why, s.note].filter(Boolean).join(" — ")}</span>
          )}
        </span>
      </label>
    </li>
  );
}

function ResultCard({ s, picked, onToggle }: { s: Suggestion; picked: boolean; onToggle: (url: string) => void }) {
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
        onChange={() => onToggle(s.careers_url)}
        className="absolute top-3 right-3 w-4 h-4"
        aria-label={`Select ${s.name}`}
      />
      <span className="flex items-center gap-2 pr-6">
        <span className="w-8 h-8 shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-sm font-semibold text-zinc-600 dark:text-zinc-300">
          {s.name.trim().charAt(0).toUpperCase()}
        </span>
        <span className="text-sm font-medium leading-tight line-clamp-2">{s.name}</span>
      </span>
      <span>
        <StatusBadge s={s} />
      </span>
      <UrlLink url={s.careers_url} />
      {s.countries.length > 0 && <span className="text-xs text-zinc-500">{s.countries.slice(0, 4).join(", ")}</span>}
      {(s.why || s.note) && (
        <span className="text-xs text-zinc-500 line-clamp-2">{[s.why, s.note].filter(Boolean).join(" — ")}</span>
      )}
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
