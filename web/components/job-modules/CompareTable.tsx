"use client";

import { useMemo, useState } from "react";
import { normTitle, type CompareGroup } from "@/lib/compareGroups";

const PAGE = 200;

function fmtPrice(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/**
 * The Compare table: one row per matched item, one column per source with
 * its price (linking to the record), the cheapest highlighted. Search and a
 * "found in N+ sources" filter work in the browser.
 */
export function CompareTable({ groups, sources }: { groups: CompareGroup[]; sources: string[] }) {
  const [q, setQ] = useState("");
  const [min, setMin] = useState(2);
  const [shown, setShown] = useState(PAGE);
  const maxSources = sources.length;

  const visible = useMemo(() => {
    const needle = normTitle(q);
    return groups.filter(
      (g) =>
        g.sources.length >= min &&
        (!needle || normTitle(`${g.title} ${g.brand} ${g.gtin} ${g.sources.join(" ")}`).includes(needle))
    );
  }, [groups, q, min]);
  // Only the columns the visible rows use.
  const cols = useMemo(() => {
    const used = new Set(visible.flatMap((g) => g.sources));
    return sources.filter((s) => used.has(s));
  }, [visible, sources]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShown(PAGE);
          }}
          placeholder="Search name, brand, code or source…"
          className="flex-1 min-w-48 max-w-md h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
        />
        {maxSources > 2 && (
          <select
            value={min}
            onChange={(e) => {
              setMin(Number(e.target.value));
              setShown(PAGE);
            }}
            aria-label="Minimum number of sources"
            className="h-9 px-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
          >
            {Array.from({ length: maxSources - 1 }, (_, i) => i + 2).map((n) => (
              <option key={n} value={n}>
                In {n}+ sources
              </option>
            ))}
          </select>
        )}
        <span className="text-xs text-zinc-500">
          {visible.length === groups.length ? `${groups.length} items` : `${visible.length} of ${groups.length} items`}
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing matches the filters.</p>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 dark:bg-zinc-900/60 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="text-left px-4 py-2.5 font-medium min-w-64">Item</th>
                {cols.map((s) => (
                  <th key={s} className="text-left px-4 py-2.5 font-medium whitespace-nowrap">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {visible.slice(0, shown).map((g) => (
                <tr key={g.key} className="hover:bg-zinc-50/60 dark:hover:bg-zinc-900/40">
                  <td className="px-4 py-3 align-top">
                    <div className="font-medium">{g.title || "(untitled)"}</div>
                    <div className="text-xs text-zinc-500 mt-0.5 flex flex-wrap gap-x-2">
                      {g.brand && <span>{g.brand}</span>}
                      {g.gtin && <span className="font-mono">{g.gtin}</span>}
                      <span>
                        {g.sources.length} sources · matched by {g.by === "gtin" ? "product code" : "name"}
                      </span>
                    </div>
                  </td>
                  {cols.map((s) => {
                    const c = g.cells[s];
                    if (!c) {
                      return (
                        <td key={s} className="px-4 py-3 align-top text-zinc-300 dark:text-zinc-700">
                          —
                        </td>
                      );
                    }
                    const best = g.cheapest === s;
                    const label = c.price !== null ? `${fmtPrice(c.price)}${c.currency ? ` ${c.currency}` : ""}` : "view";
                    return (
                      <td
                        key={s}
                        className={"px-4 py-3 align-top whitespace-nowrap " + (best ? "bg-brand-50/70 dark:bg-brand-500/10" : "")}
                      >
                        {/^https?:\/\//i.test(c.url) ? (
                          <a
                            href={c.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            title={c.title}
                            className={
                              "tabular-nums hover:underline " +
                              (best
                                ? "font-semibold text-brand-700 dark:text-brand-300"
                                : c.price !== null
                                  ? "font-medium"
                                  : "text-zinc-500")
                            }
                          >
                            {label}
                          </a>
                        ) : (
                          <span title={c.title} className={"tabular-nums " + (best ? "font-semibold text-brand-700 dark:text-brand-300" : "")}>
                            {label}
                          </span>
                        )}
                        {best && (
                          <div className="text-[11px] font-medium uppercase tracking-wider text-brand-600 dark:text-brand-400 mt-0.5">
                            Cheapest
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {visible.length > shown && (
        <div className="text-center">
          <button
            type="button"
            onClick={() => setShown((n) => n + PAGE)}
            className="h-9 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 shadow-xs"
          >
            Show more ({visible.length - shown} left)
          </button>
        </div>
      )}
    </div>
  );
}
