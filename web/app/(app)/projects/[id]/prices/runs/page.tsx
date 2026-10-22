import Link from "next/link";
import { requireJob } from "@/lib/jobs";
import { comparisonRunsCol } from "@/lib/firestore/collections";
import { pricesJobScope } from "@/app/api/comparison/jobScope";
import { RunNowButton } from "@/components/RunNowButton";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function tsToIso(v: unknown): string {
  if (!v) return "";
  const t = v as { toDate?: () => Date };
  if (typeof t.toDate === "function") return t.toDate().toISOString();
  if (typeof v === "string") return v;
  return "";
}

function fmtRelative(iso: string): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Math.round((Date.now() - t) / 1000);
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
    case "auth_halt":
      return "bg-red-50 text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/25";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

/**
 * A prices job's Runs: the recent comparison runs of its shops. Run now
 * scrapes every shop of the job; a single shop runs from its edit page.
 */
export default async function PricesRunsPage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id, "prices");
  const base = `/projects/${job.id}/prices`;

  const [scope, snap] = await Promise.all([
    pricesJobScope(job.uid, job.id),
    comparisonRunsCol()
      .where("owner_uid", "==", job.uid)
      .orderBy("started_at", "desc")
      .get(),
  ]);

  type Row = {
    id: string;
    source_name: string;
    source_id: string;
    status: string;
    started_at: string;
    duration_seconds: number;
    found: number;
    extracted: number;
    errors_count: number;
  };
  const rows: Row[] = snap.docs
    .filter((d) => scope.hasRun(d.data()))
    .slice(0, 100)
    .map((d) => {
      const data = d.data();
      const totals = (data.totals ?? {}) as Record<string, number>;
      return {
        id: d.id,
        source_name: String(data.source_name ?? data.source_id ?? "(unknown)"),
        source_id: String(data.source_id ?? ""),
        status: String(data.status ?? ""),
        started_at: tsToIso(data.started_at),
        duration_seconds: Number(data.duration_seconds ?? 0),
        found: Number(totals.found ?? 0),
        extracted: Number(totals.extracted ?? 0),
        errors_count: Number(totals.errors_count ?? 0),
      };
    });

  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Runs</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            {rows.length === 0
              ? "No runs yet."
              : `${rows.length} recent run${rows.length === 1 ? "" : "s"}`}{" "}
            · Run now scrapes every shop of this job.
          </p>
        </div>
        <RunNowButton projectId={job.id} />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center bg-white/60 dark:bg-zinc-950/40">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No runs yet.{" "}
            {scope.sources.length === 0 ? (
              <>
                Add a shop under{" "}
                <Link href={`${base}/sources`} className="underline">Sources</Link>,
                then run the job.
              </>
            ) : (
              "Press Run now to scrape this job's shops."
            )}
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 dark:bg-zinc-900/60 text-[11px] font-medium uppercase tracking-wider text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Shop</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Started</th>
                <th className="text-right px-4 py-2 font-medium">Found</th>
                <th className="text-right px-4 py-2 font-medium">Extracted</th>
                <th className="text-right px-4 py-2 font-medium">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`${base}/runs/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.source_name}
                    </Link>
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
                    {fmtRelative(r.started_at)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.found}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.extracted}
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
