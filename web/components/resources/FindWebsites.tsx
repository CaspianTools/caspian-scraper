"use client";

import { useMemo, useState } from "react";
import { CountrySelect } from "@/components/CountrySelect";
import { authedFetch } from "@/lib/firebase/clientFetch";
import type { ResourceRow } from "@/lib/firestore/resources";

/** One suggestion from POST /api/resources/discover (find_websites.py). */
interface Suggestion {
  name: string;
  careers_url: string;
  countries: string[];
  ats: "successfactors" | "jibe" | "unknown";
  reachable: boolean;
  scrapable: boolean;
  note: string;
  why: string;
  source: "catalog" | "web";
}

interface DiscoverResult {
  catalog: Suggestion[];
  web: Suggestion[];
  web_status: "ok" | "no_key" | "bad_key" | "limited" | "error" | "off";
  web_error: string;
}

interface Props {
  /** Prefill for "what are you looking for" (e.g. the job's name). */
  defaultQuery?: string;
  /** Called with the resources saved to the library. */
  onAdded: (rows: ResourceRow[]) => void;
  onClose: () => void;
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400";
const primaryBtn =
  "inline-flex items-center h-9 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200";
const secondaryBtn =
  "inline-flex items-center h-9 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50";

const ATS_LABEL: Record<string, string> = {
  successfactors: "SuccessFactors",
  jibe: "Jibe / iCIMS",
};

/**
 * "Find websites": the app proposes careers sites for a job — from the
 * built-in employer list and a Brave Search web search (find_websites.py,
 * no AI) — after opening each one to check it works and which platform it
 * runs on. Ticked ones are saved to the shared library.
 */
export function FindWebsites({ defaultQuery = "", onAdded, onClose }: Props) {
  const [query, setQuery] = useState(defaultQuery);
  const [countries, setCountries] = useState<string[]>([]);
  const [useWeb, setUseWeb] = useState(true);
  const [busy, setBusy] = useState<"search" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const all = useMemo(() => (result ? [...result.web, ...result.catalog] : []), [result]);

  async function search() {
    setBusy("search");
    setError(null);
    setResult(null);
    try {
      const res = await authedFetch("/api/resources/discover", {
        method: "POST",
        body: JSON.stringify({
          query: query.trim(),
          countries,
          use_web: useWeb,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.error || `Search failed (${res.status})`);
        return;
      }
      const r = b as DiscoverResult;
      setResult(r);
      // Pre-tick only what will actually be scraped today.
      setPicked(new Set([...r.web, ...r.catalog].filter((s) => s.scrapable).map((s) => s.careers_url)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function addPicked() {
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
            notes: [s.why, s.source === "web" ? "Found by web search." : "From the built-in employer list."]
              .filter(Boolean)
              .join(" "),
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
      if (added.length > 0) onAdded(added);
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

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Find websites</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Suggests careers sites from the built-in employer list and a web search
            (Brave Search), and opens each one to check it works.
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-xs text-zinc-500 hover:underline">
          Close
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-3">
        <label className="block text-sm">
          <span className="block font-medium mb-1">What are you looking for?</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (!busy) search();
              }
            }}
            placeholder="HSE jobs in oil & gas, Middle East"
            className={inputCls}
          />
        </label>
        <div className="block text-sm">
          <span className="block font-medium mb-1">
            Countries <span className="text-zinc-500 font-normal">(optional)</span>
          </span>
          <CountrySelect value={countries} onChange={setCountries} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={useWeb} onChange={(e) => setUseWeb(e.target.checked)} className="w-4 h-4" />
          Also search the web (Brave Search)
        </label>
        <button type="button" onClick={search} disabled={busy !== null} className={primaryBtn}>
          {busy === "search" ? "Searching…" : "Search"}
        </button>
      </div>

      {busy === "search" && (
        <p className="text-xs text-zinc-500">
          Checking every suggestion{useWeb ? " and searching the web" : ""} — this can take a minute.
        </p>
      )}

      {result && (
        <div className="space-y-4">
          <WebStatus result={result} onKeySaved={search} />
          {result.web.length > 0 && (
            <Group
              title="Found on the web"
              items={result.web}
              picked={picked}
              onToggle={toggle}
            />
          )}
          <Group title="From the built-in employer list" items={result.catalog} picked={picked} onToggle={toggle} />

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-zinc-200 dark:border-zinc-800">
            <p className="text-xs text-zinc-500">
              Only SuccessFactors and Jibe sites are scraped today; others are saved for later.
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className={secondaryBtn}>
                Cancel
              </button>
              <button
                type="button"
                onClick={addPicked}
                disabled={busy !== null || picked.size === 0}
                className={primaryBtn}
              >
                {busy === "add" ? "Adding…" : `Add ${picked.size} to library`}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function WebStatus({
  result,
  onKeySaved,
}: {
  result: DiscoverResult;
  onKeySaved: () => void;
}) {
  if (result.web_status === "no_key" || result.web_status === "bad_key") {
    return <SearchKeyForm rejected={result.web_status === "bad_key"} onSaved={onKeySaved} />;
  }
  if (result.web_status === "limited" || result.web_status === "error") {
    return (
      <p className="text-xs rounded-lg bg-red-50 dark:bg-red-950/30 px-3 py-2">
        Web search failed: {result.web_error}
      </p>
    );
  }
  if (result.web_status === "ok" && result.web.length === 0) {
    return <p className="text-xs text-zinc-500">The web search found no new careers sites.</p>;
  }
  return null;
}

/** Paste the Brave Search API key (stored in local-data/, never committed). */
function SearchKeyForm({ rejected, onSaved }: { rejected: boolean; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await authedFetch("/api/search-key", {
        method: "PUT",
        body: JSON.stringify({ value: value.trim() }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.error || `Save failed (${res.status})`);
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 px-3 py-3 space-y-2">
      <p className="text-xs">
        {rejected
          ? "Brave Search rejected the saved key - paste a valid one."
          : "Web search needs a Brave Search API key (a normal search API, no AI; billed per search by Brave)."}{" "}
        Get one at{" "}
        <a
          href="https://api-dashboard.search.brave.com"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          api-dashboard.search.brave.com
        </a>
        . It&apos;s stored on this computer only.
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (value.trim() && !busy) save();
            }
          }}
          placeholder="Brave Search API key"
          autoComplete="off"
          className={inputCls + " font-mono"}
        />
        <button type="button" onClick={save} disabled={busy || !value.trim()} className={primaryBtn}>
          {busy ? "Saving…" : "Save & search"}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function Group({
  title,
  items,
  picked,
  onToggle,
}: {
  title: string;
  items: Suggestion[];
  picked: Set<string>;
  onToggle: (url: string) => void;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
        {title} <span className="font-normal">({items.length})</span>
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing new matched.</p>
      ) : (
        <ul className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 divide-y divide-zinc-100 dark:divide-zinc-800 max-h-80 overflow-y-auto">
          {items.map((s) => (
            <li key={s.careers_url}>
              <label className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
                <input
                  type="checkbox"
                  checked={picked.has(s.careers_url)}
                  onChange={() => onToggle(s.careers_url)}
                  className="w-4 h-4 mt-0.5 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{s.name}</span>
                    <StatusBadge s={s} />
                    {s.countries.length > 0 && (
                      <span className="text-xs text-zinc-500">{s.countries.slice(0, 4).join(", ")}</span>
                    )}
                  </span>
                  <a
                    href={s.careers_url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="block text-xs text-zinc-500 font-mono truncate hover:underline"
                  >
                    {s.careers_url}
                  </a>
                  {(s.why || s.note) && (
                    <span className="block text-xs text-zinc-500 mt-0.5">
                      {[s.why, s.note].filter(Boolean).join(" — ")}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ s }: { s: Suggestion }) {
  const [cls, text] = !s.reachable
    ? ["bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300", "couldn't check"]
    : s.scrapable
      ? ["bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300", `${ATS_LABEL[s.ats]} — will be scraped`]
      : ["bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300", "other platform — saved, not scraped yet"];
  return <span className={"text-xs px-1.5 py-0.5 rounded " + cls}>{text}</span>;
}
