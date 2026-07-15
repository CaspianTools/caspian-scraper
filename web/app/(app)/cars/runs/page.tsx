import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { carRunsCol } from "@/lib/firestore/collections";

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
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "partial":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "running":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
    case "error":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

const FETCH_CAP = 500;

export default async function CarRunsPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const snap = await carRunsCol()
    .where("owner_uid", "==", session.uid)
    .limit(FETCH_CAP)
    .get();

  const rows = snap.docs
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
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Runs</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          {rows.length === 0
            ? "No runs yet."
            : `${rows.length} recent run${rows.length === 1 ? "" : "s"}`}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No car-scrape runs yet. Add a source and trigger Run-now.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
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
                      href={`/cars/runs/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.source_name}
                    </Link>
                    <div className="text-xs text-zinc-500">{r.site}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        "text-xs px-2 py-0.5 rounded-full " +
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
