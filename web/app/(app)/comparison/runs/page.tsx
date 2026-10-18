import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { comparisonRunsCol } from "@/lib/firestore/collections";

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

function statusClasses(s: string): string {
  switch (s) {
    case "ok":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "partial":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "running":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
    case "error":
    case "auth_halt":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

export default async function ComparisonRunsPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const snap = await comparisonRunsCol()
    .where("owner_uid", "==", session.uid)
    .orderBy("started_at", "desc")
    .limit(100)
    .get();

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
  const rows: Row[] = snap.docs.map((d) => {
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
            No comparison runs yet. Add a source and trigger Run-now to see
            results immediately.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Source</th>
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
                      href={`/comparison/runs/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.source_name}
                    </Link>
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
