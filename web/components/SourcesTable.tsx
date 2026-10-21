"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export interface SourceRow {
  id: string;
  name: string;
  kind: string;
  ats: string;
  careers_url: string;
  active: boolean;
  countries: string[];
}

interface Props {
  projectId: string;
  sources: SourceRow[];
}

type ActiveFilter = "all" | "active" | "inactive";

export function SourcesTable({ projectId, sources }: Props) {
  const [q, setQ] = useState("");
  const [ats, setAts] = useState<string>("");
  const [kind, setKind] = useState<string>("");
  const [country, setCountry] = useState<string>("");
  const [active, setActive] = useState<ActiveFilter>("all");

  // Derive the available filter options from the actual data so we
  // don't show "Workday" in a project that has no Workday sources.
  const { atsOptions, kindOptions, countryOptions } = useMemo(() => {
    const ats = new Set<string>();
    const kind = new Set<string>();
    const country = new Set<string>();
    for (const s of sources) {
      if (s.ats) ats.add(s.ats);
      if (s.kind) kind.add(s.kind);
      for (const c of s.countries) if (c) country.add(c);
    }
    return {
      atsOptions: Array.from(ats).sort(),
      kindOptions: Array.from(kind).sort(),
      countryOptions: Array.from(country).sort(),
    };
  }, [sources]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sources.filter((s) => {
      if (ats && s.ats !== ats) return false;
      if (kind && s.kind !== kind) return false;
      if (country && !s.countries.includes(country)) return false;
      if (active === "active" && !s.active) return false;
      if (active === "inactive" && s.active) return false;
      if (needle) {
        const hay = `${s.name} ${s.careers_url} ${s.countries.join(" ")}`
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [sources, q, ats, kind, country, active]);

  const clearAll = () => {
    setQ("");
    setAts("");
    setKind("");
    setCountry("");
    setActive("all");
  };

  const anyFilterActive =
    q || ats || kind || country || active !== "all";

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 space-y-3 shadow-card">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, URL, country…"
            className="flex-1 min-w-[200px] h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
          />
          <select
            value={ats}
            onChange={(e) => setAts(e.target.value)}
            className="h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
          >
            <option value="">All ATS</option>
            {atsOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
          >
            <option value="">All kinds</option>
            {kindOptions.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
          >
            <option value="">All countries</option>
            {countryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-300 dark:border-zinc-700 p-0.5">
            {(["all", "active", "inactive"] as ActiveFilter[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setActive(v)}
                className={
                  "text-xs px-2.5 h-8 rounded-md transition-colors " +
                  (active === v
                    ? "bg-white text-zinc-900 font-medium shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-white dark:ring-zinc-700"
                    : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900")
                }
              >
                {v}
              </button>
            ))}
          </div>
          {anyFilterActive && (
            <button
              type="button"
              onClick={clearAll}
              className="text-xs text-zinc-500 hover:underline"
            >
              Clear
            </button>
          )}
        </div>
        <div className="text-xs text-zinc-500">
          {filtered.length === sources.length
            ? `${sources.length} source${sources.length === 1 ? "" : "s"}`
            : `${filtered.length} of ${sources.length} source${sources.length === 1 ? "" : "s"}`}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center text-sm text-zinc-500 bg-white/60 dark:bg-zinc-950/40">
          No sources match these filters.
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 dark:bg-zinc-900/60 text-[11px] font-medium uppercase tracking-wider text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">ATS</th>
                <th className="text-left px-4 py-2 font-medium">Kind</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Countries</th>
                <th className="text-left px-4 py-2 font-medium w-px"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {filtered.map((s) => (
                <tr
                  key={s.id}
                  className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{s.name}</div>
                    <div
                      className="text-xs text-zinc-500 truncate max-w-md"
                      title={s.careers_url}
                    >
                      {s.careers_url}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs text-zinc-600 dark:text-zinc-400">
                      {s.ats}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {s.kind}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        "text-xs font-medium px-2 py-0.5 rounded-full " +
                        (s.active
                          ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25"
                          : "bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-500/15 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-400/15")
                      }
                    >
                      {s.active ? "active" : "paused"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                    {s.countries.length > 0
                      ? s.countries.slice(0, 3).join(", ") +
                        (s.countries.length > 3
                          ? ` +${s.countries.length - 3}`
                          : "")
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/projects/${projectId}/sources/${s.id}`}
                      className="text-sm text-zinc-700 dark:text-zinc-300 hover:underline"
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
