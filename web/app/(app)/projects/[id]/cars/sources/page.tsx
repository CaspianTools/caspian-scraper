import Link from "next/link";
import { carSourcesCol } from "@/lib/firestore/collections";
import { requireJob } from "@/lib/jobs";
import { humanizeCron } from "@/lib/cron/humanize";

export const dynamic = "force-dynamic";

function millis(v: unknown): number {
  const t = v as { toMillis?: () => number };
  if (t && typeof t.toMillis === "function") return t.toMillis();
  if (typeof v === "string") {
    const p = Date.parse(v);
    return Number.isNaN(p) ? 0 : p;
  }
  return 0;
}

function fmtRelative(ms: number): string {
  if (!ms) return "never";
  const delta = Math.round((Date.now() - ms) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

/** A car job's sources: car_sources whose project_id is this job. */
export default async function CarSourcesListPage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id, "cars");
  const base = `/projects/${job.id}/cars`;

  const snap = await carSourcesCol()
    .where("owner_uid", "==", job.uid)
    .get();

  const sources = snap.docs
    .filter((d) => d.data().project_id === job.id)
    .map((d) => {
      const data = d.data();
      const summary = (data.last_run_summary ?? null) as Record<
        string,
        unknown
      > | null;
      return {
        id: d.id,
        name: String(data.name ?? "(unnamed)"),
        site: String(data.site ?? ""),
        query: String(data.query ?? ""),
        active: data.active !== false,
        schedule_cron: String(data.schedule_cron ?? ""),
        createdMs: millis(data.created_at),
        lastRunMs: millis(data.last_run_at),
        lastFound:
          summary && typeof summary === "object"
            ? Number(summary.found ?? 0)
            : 0,
      };
    })
    .sort((a, b) => b.createdMs - a.createdMs);

  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Sources</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            {sources.length === 0
              ? "No sources yet."
              : `${sources.length} source${sources.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <Link
          href={`${base}/sources/new`}
          className="inline-flex items-center h-10 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
        >
          + Add source
        </Link>
      </div>

      {sources.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center bg-white/60 dark:bg-zinc-950/40">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4 max-w-md mx-auto">
            A source is a car website (OpenSooq / Dubizzle) plus a country,
            optional city/search query, a listing cap, and a schedule. Each
            run of the job scrapes every active source into its Cars.
          </p>
          <Link
            href={`${base}/sources/new`}
            className="inline-flex items-center h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
          >
            Add your first source
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 dark:bg-zinc-900/60 text-[11px] font-medium uppercase tracking-wider text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Site</th>
                <th className="text-left px-4 py-2 font-medium">Schedule</th>
                <th className="text-left px-4 py-2 font-medium">Last run</th>
                <th className="text-right px-4 py-2 font-medium">Found</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {sources.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`${base}/sources/${s.id}`}
                      className="font-medium hover:underline"
                    >
                      {s.name}
                    </Link>
                    {s.query && (
                      <div className="text-xs text-zinc-500 truncate max-w-xs">
                        “{s.query}”
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs">{s.site}</code>
                  </td>
                  <td className="px-4 py-3 text-xs" title={s.schedule_cron}>
                    {humanizeCron(s.schedule_cron)}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {fmtRelative(s.lastRunMs)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {s.lastFound}
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
