import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { comparisonSourcesCol } from "@/lib/firestore/collections";
import { humanizeCron } from "@/lib/cron/humanize";

export const dynamic = "force-dynamic";

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

export default async function ComparisonSourcesListPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const snap = await comparisonSourcesCol()
    .where("owner_uid", "==", session.uid)
    .orderBy("created_at", "desc")
    .get();

  const sources = snap.docs.map((d) => {
    const data = d.data();
    const lastRunSummary = data.last_run_summary ?? null;
    return {
      id: d.id,
      name: String(data.name ?? "(unnamed)"),
      retailer_id: String(data.retailer_id ?? ""),
      home_url: String(data.home_url ?? ""),
      active: data.active !== false,
      schedule_cron: String(data.schedule_cron ?? ""),
      last_run_at: tsToIso(data.last_run_at),
      last_run_extracted:
        lastRunSummary && typeof lastRunSummary === "object"
          ? Number(
              (lastRunSummary as Record<string, unknown>).extracted ?? 0
            )
          : 0,
    };
  });

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
          href="/comparison/sources/new"
          className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          + Add source
        </Link>
      </div>

      {sources.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4 max-w-md mx-auto">
            A comparison source is a retailer category page plus an
            extraction strategy. Each source carries its own schedule,
            extractor chain, and retailer_id (used as the column key in
            the side-by-side compare table).
          </p>
          <Link
            href="/comparison/sources/new"
            className="inline-flex items-center h-9 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Add your first source
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Retailer</th>
                <th className="text-left px-4 py-2 font-medium">Schedule</th>
                <th className="text-left px-4 py-2 font-medium">Last run</th>
                <th className="text-right px-4 py-2 font-medium">Extracted</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {sources.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/comparison/sources/${s.id}`}
                      className="font-medium hover:underline"
                    >
                      {s.name}
                    </Link>
                    <div className="text-xs text-zinc-500 truncate max-w-xs">
                      {s.home_url}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs">{s.retailer_id}</code>
                  </td>
                  <td
                    className="px-4 py-3 text-xs"
                    title={s.schedule_cron}
                  >
                    {humanizeCron(s.schedule_cron)}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {fmtRelative(s.last_run_at)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {s.last_run_extracted}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        "text-xs px-2 py-0.5 rounded-full " +
                        (s.active
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400")
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
