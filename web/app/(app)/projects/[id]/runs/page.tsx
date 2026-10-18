import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { runRequestsCol, runsCol } from "@/lib/firestore/collections";
import { RunNowButton } from "@/components/RunNowButton";
import { DryRunPanel } from "@/components/DryRunPanel";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

interface RequestRow {
  id: string;
  status: string;
  created_at: string;
  picked_up_at: string | null;
  finished_at: string | null;
  run_id: string;
}

function tsToIso(v: unknown): string {
  if (!v) return "";
  // Firestore Timestamp
  const t = v as { toDate?: () => Date };
  if (typeof t.toDate === "function") {
    return t.toDate().toISOString();
  }
  if (typeof v === "string") return v;
  return "";
}

function fmtRelative(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Math.round((Date.now() - t) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

function statusClasses(status: string): string {
  switch (status) {
    case "ok":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "partial":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "running":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
    case "auth_halt":
    case "error":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

export default async function RunsPage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id } = await params;

  const [requestsSnap, runsSnap] = await Promise.all([
    runRequestsCol()
      .where("project_id", "==", id)
      .orderBy("created_at", "desc")
      .limit(20)
      .get(),
    runsCol(id).orderBy("started_at", "desc").limit(20).get(),
  ]);

  const requests: RequestRow[] = requestsSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      status: String(data.status ?? ""),
      created_at: tsToIso(data.created_at),
      picked_up_at: tsToIso(data.picked_up_at) || null,
      finished_at: tsToIso(data.finished_at) || null,
      run_id: String(data.run_id ?? ""),
    };
  });
  const pendingRequests = requests.filter((r) => r.status === "pending");

  const runs = runsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  return (
    <>
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Runs</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Scrape history and ad-hoc triggering.
          </p>
        </div>
        <RunNowButton projectId={id} />
      </div>

      <DryRunPanel projectId={id} />

      {pendingRequests.length > 0 && (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4">
          <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">
            Pending requests
          </div>
          <ul className="text-sm divide-y divide-zinc-100 dark:divide-zinc-800">
            {pendingRequests.map((r) => (
              <li key={r.id} className="py-2 flex items-center justify-between">
                <span>
                  <code className="text-xs text-zinc-500">{r.id}</code>
                </span>
                <span className="text-xs text-zinc-500">
                  queued {fmtRelative(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
        <div className="px-4 py-2 text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
          Recent runs
        </div>
        {runs.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            No runs yet. The first scheduled or ad-hoc run will appear
            here once the runner is wired up.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 text-sm">
            {runs.map((r) => {
              const row = r as Record<string, unknown> & { id: string };
              const started = tsToIso(row.started_at);
              const status = String(row.status ?? "");
              const totals = (row.totals ?? {}) as Record<string, number>;
              return (
                <li key={row.id}>
                  <Link
                    href={`/projects/${id}/runs/${row.id}`}
                    className="block px-4 py-3 flex items-center justify-between gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={
                            "text-xs px-2 py-0.5 rounded-full " +
                            statusClasses(status)
                          }
                        >
                          {status.replace("_", " ") || "unknown"}
                        </span>
                        {Object.keys(totals).length > 0 && (
                          <span className="text-xs text-zinc-600 dark:text-zinc-400 tabular-nums">
                            {Number(totals.found ?? 0)} found ·{" "}
                            {Number(totals.published ?? 0)} published ·{" "}
                            {Number(totals.errors_count ?? 0)} err
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-500 mt-1">
                        started {fmtRelative(started)} · trigger{" "}
                        {String(row.trigger ?? "")}
                      </div>
                    </div>
                    <code className="text-xs text-zinc-500 shrink-0">
                      {row.id}
                    </code>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
