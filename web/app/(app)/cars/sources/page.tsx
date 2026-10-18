import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { carSourcesCol } from "@/lib/firestore/collections";
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

export default async function CarSourcesListPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const snap = await carSourcesCol()
    .where("owner_uid", "==", session.uid)
    .get();

  const sources = snap.docs
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
          href="/cars/sources/new"
          className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          + Add source
        </Link>
      </div>

      {sources.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4 max-w-md mx-auto">
            A car source is a site (OpenSooq / Dubizzle / YallaMotor) plus a
            country, optional city/search query, a listing cap, and a
            schedule. Each source scrapes on its own cron and writes car
            listings you can browse here.
          </p>
          <Link
            href="/cars/sources/new"
            className="inline-flex items-center h-9 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Add your first source
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
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
                      href={`/cars/sources/${s.id}`}
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
