import Link from "next/link";
import { carRunsCol, carSourcesCol } from "@/lib/firestore/collections";
import { jobSourceIds, requireJob } from "@/lib/jobs";
import { RunNowButton } from "@/components/RunNowButton";

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

function statusClasses(s: string): string {
  switch (s) {
    case "ok":
      return "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25";
    case "partial":
      return "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25";
    case "running":
      return "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-600/20 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-400/25";
    case "error":
      return "bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/25";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

const FETCH_CAP = 500;

interface PageProps {
  params: Promise<{ id: string }>;
}

/** A car job's run history: car_runs of its sources (by `source_id`). One
 *  run per source; "Run now" runs every active source of the job. */
export default async function CarRunsPage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id, "cars");
  const sourceIds = await jobSourceIds(carSourcesCol(), job);

  const snap = await carRunsCol()
    .where("owner_uid", "==", job.uid)
    .limit(FETCH_CAP)
    .get();

  const rows = snap.docs
    .filter((d) => sourceIds.has(String(d.data().source_id ?? "")))
    .map((d) => {
      const data = d.data();
      const totals = (data.totals ?? {}) as Record<string, number>;
      return {
        id: d.id,
        source_name: String(data.source_name ?? data.source_id ?? "(unknown)"),
        site: String(data.site ?? ""),
        status: String(data.status ?? ""),
        startedMs: millis(data.started_at),
        found: Number(totals.found ?? 0),
        added: Number(totals.new ?? 0),
        errors_count: Number(totals.errors_count ?? 0),
      };
    })
    .sort((a, b) => b.startedMs - a.startedMs)
    .slice(0, 100);

  return (
    <>
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Runs</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            {rows.length === 0
              ? "No runs yet."
              : `${rows.length} recent run${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <RunNowButton projectId={job.id} />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center bg-white/60 dark:bg-zinc-950/40">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No runs yet — add a website under Sources, then run the job.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 dark:bg-zinc-900/60 text-[11px] font-medium uppercase tracking-wider text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Source</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Started</th>
                <th className="text-right px-4 py-2 font-medium">Found</th>
                <th className="text-right px-4 py-2 font-medium">New</th>
                <th className="text-right px-4 py-2 font-medium">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/projects/${job.id}/cars/runs/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.source_name}
                    </Link>
                    <div className="text-xs text-zinc-500">{r.site}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        "text-xs font-medium px-2 py-0.5 rounded-full " +
                        statusClasses(r.status)
                      }
                    >
                      {r.status.replace("_", " ") || "unknown"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {fmtRelative(r.startedMs)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.found}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.added}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-500">
                    {r.errors_count}
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
