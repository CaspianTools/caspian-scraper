import Link from "next/link";
import { activeClasses, fmtRelative } from "./format";

export interface EngineSourceRow {
  id: string;
  href: string;
  name: string;
  /** A second line under the name (search query, home page, start URL). */
  detail: string;
  /** Site / retailer key, shown as code. */
  site: string;
  active: boolean;
  lastRunMs: number;
  /** The last run's headline count (found / extracted). */
  lastCount: number;
}

/** The sources of one engine (classifieds sites, shops, websites) as a
 *  table linking to each source's own page. */
export function EngineSourcesTable({
  rows,
  siteLabel,
  countLabel,
}: {
  rows: EngineSourceRow[];
  siteLabel: string;
  countLabel: string;
}) {
  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto shadow-card">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50/80 dark:bg-zinc-900/60 text-[11px] font-medium uppercase tracking-wider text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Name</th>
            <th className="text-left px-4 py-2 font-medium">{siteLabel}</th>
            <th className="text-left px-4 py-2 font-medium">Last run</th>
            <th className="text-right px-4 py-2 font-medium">{countLabel}</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((s) => (
            <tr key={s.id}>
              <td className="px-4 py-3">
                <Link href={s.href} className="font-medium hover:underline">
                  {s.name}
                </Link>
                {s.detail && (
                  <div className="text-xs text-zinc-500 truncate max-w-xs">{s.detail}</div>
                )}
              </td>
              <td className="px-4 py-3">
                {s.site ? <code className="text-xs">{s.site}</code> : <span className="text-zinc-400">—</span>}
              </td>
              <td className="px-4 py-3 text-xs text-zinc-500">{fmtRelative(s.lastRunMs)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{s.lastRunMs ? s.lastCount : "—"}</td>
              <td className="px-4 py-3">
                <span className={"text-xs font-medium px-2 py-0.5 rounded-full " + activeClasses(s.active)}>
                  {s.active ? "active" : "paused"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
