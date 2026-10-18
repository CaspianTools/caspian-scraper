import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { lessonsCol } from "@/lib/firestore/collections";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ verdict?: string }>;
}

interface Lesson {
  id: string;
  run_id: string;
  ts: string;
  source_id: string;
  source_name: string;
  ats: string;
  careers_url: string;
  verdict: "ok" | "errors" | "zero_found" | "no_new" | string;
  found: number;
  published: number;
  skipped_duplicate: number;
  errors: string[];
}

const VERDICTS = ["all", "ok", "no_new", "zero_found", "errors"] as const;
const CONSECUTIVE_ZERO_ALERT = 3;

function tsToIso(v: unknown): string {
  if (!v) return "";
  const t = v as { toDate?: () => Date };
  if (typeof t.toDate === "function") return t.toDate().toISOString();
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

function verdictClasses(v: string): string {
  switch (v) {
    case "ok":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "no_new":
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
    case "zero_found":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "errors":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

/**
 * Walk newest → oldest within each source. If the latest streak is
 * ≥ CONSECUTIVE_ZERO_ALERT zero_found entries, flag it as stale.
 */
function computeStaleSources(
  lessons: Lesson[]
): { source_id: string; source_name: string; consecutive: number }[] {
  const bySource = new Map<string, Lesson[]>();
  for (const l of lessons) {
    const list = bySource.get(l.source_id) ?? [];
    list.push(l);
    bySource.set(l.source_id, list);
  }
  const stale: {
    source_id: string;
    source_name: string;
    consecutive: number;
  }[] = [];
  for (const [sid, list] of bySource.entries()) {
    let count = 0;
    for (const l of list) {
      if (l.verdict === "zero_found") count++;
      else break;
    }
    if (count >= CONSECUTIVE_ZERO_ALERT) {
      stale.push({
        source_id: sid,
        source_name: list[0]?.source_name ?? sid,
        consecutive: count,
      });
    }
  }
  return stale.sort((a, b) => b.consecutive - a.consecutive);
}

export default async function LessonsPage({
  params,
  searchParams,
}: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id } = await params;
  const sp = await searchParams;
  const verdictFilter =
    sp.verdict && VERDICTS.includes(sp.verdict as (typeof VERDICTS)[number])
      ? sp.verdict
      : "all";

  // For the "Action required" card we always want recent lessons across
  // every verdict (so the alert never disappears under a filter). For
  // the table itself we apply the verdict filter.
  const [filteredSnap, recentAllSnap] = await Promise.all([
    verdictFilter === "all"
      ? lessonsCol(id).orderBy("ts", "desc").limit(100).get()
      : lessonsCol(id)
          .where("verdict", "==", verdictFilter)
          .orderBy("ts", "desc")
          .limit(100)
          .get(),
    lessonsCol(id).orderBy("ts", "desc").limit(200).get(),
  ]);

  const toLesson = (
    d: FirebaseFirestore.QueryDocumentSnapshot
  ): Lesson => {
    const data = d.data();
    return {
      id: d.id,
      run_id: String(data.run_id ?? ""),
      ts: tsToIso(data.ts),
      source_id: String(data.source_id ?? ""),
      source_name: String(data.source_name ?? ""),
      ats: String(data.ats ?? ""),
      careers_url: String(data.careers_url ?? ""),
      verdict: String(data.verdict ?? ""),
      found: Number(data.found ?? 0),
      published: Number(data.published ?? 0),
      skipped_duplicate: Number(data.skipped_duplicate ?? 0),
      errors: Array.isArray(data.errors) ? data.errors.map(String) : [],
    };
  };

  const lessons = filteredSnap.docs.map(toLesson);
  const recentAll = recentAllSnap.docs.map(toLesson);
  const stale = computeStaleSources(recentAll);

  return (
    <>
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Lessons</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-2xl">
          One row per source per scrape — the scraper&apos;s verdict on
          what happened. Use the filters to find what needs attention.
        </p>
      </div>

      {stale.length > 0 && (
        <div className="rounded-2xl border border-amber-300 dark:border-amber-700/50 bg-amber-50/70 dark:bg-amber-950/20 p-5">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="w-8 h-8 rounded-full bg-amber-500 text-white flex items-center justify-center text-sm font-bold shrink-0"
            >
              !
            </span>
            <div className="min-w-0">
              <h3 className="font-medium text-amber-900 dark:text-amber-200">
                Action required: {stale.length} source
                {stale.length === 1 ? "" : "s"} found nothing in the last{" "}
                {CONSECUTIVE_ZERO_ALERT}+ runs
              </h3>
              <p className="text-sm text-amber-800 dark:text-amber-300 mt-1 mb-3">
                Usually means selectors drifted or the search URL needs
                refreshing. Click through to inspect.
              </p>
              <ul className="space-y-1 text-sm">
                {stale.map((s) => (
                  <li key={s.source_id}>
                    <Link
                      href={`/projects/${id}/sources/${s.source_id}`}
                      className="underline hover:no-underline text-amber-900 dark:text-amber-200"
                    >
                      {s.source_name}
                    </Link>{" "}
                    <span className="text-xs text-amber-700 dark:text-amber-300">
                      · {s.consecutive} consecutive runs with no HSE roles
                      found
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {VERDICTS.map((v) => {
          const active = verdictFilter === v;
          const href =
            v === "all"
              ? `/projects/${id}/lessons`
              : `/projects/${id}/lessons?verdict=${v}`;
          return (
            <Link
              key={v}
              href={href}
              className={
                "text-xs px-2.5 py-1.5 rounded-full border transition-colors " +
                (active
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
                  : "border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900")
              }
            >
              {v === "all" ? "All" : v.replace("_", " ")}
            </Link>
          );
        })}
      </div>

      {lessons.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center text-sm text-zinc-500">
          {verdictFilter === "all"
            ? "No lessons yet. They land here after the first scrape run."
            : `No lessons with verdict '${verdictFilter}' in the last 100 entries.`}
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">When</th>
                <th className="text-left px-4 py-2 font-medium">Source</th>
                <th className="text-left px-4 py-2 font-medium">Verdict</th>
                <th className="text-right px-4 py-2 font-medium">Found</th>
                <th className="text-right px-4 py-2 font-medium">Published</th>
                <th className="text-right px-4 py-2 font-medium">Dup</th>
                <th className="text-left px-4 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800 align-top">
              {lessons.map((l) => (
                <tr key={l.id}>
                  <td
                    className="px-4 py-3 text-xs text-zinc-500 whitespace-nowrap"
                    title={l.ts}
                  >
                    {fmtRelative(l.ts)}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/projects/${id}/sources/${l.source_id}`}
                      className="font-medium hover:underline"
                    >
                      {l.source_name || l.source_id}
                    </Link>
                    <div className="text-xs text-zinc-500">{l.ats}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        "text-xs px-2 py-0.5 rounded-full whitespace-nowrap " +
                        verdictClasses(l.verdict)
                      }
                    >
                      {l.verdict.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {l.found}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {l.published}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-zinc-500">
                    {l.skipped_duplicate}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {l.errors.length > 0 ? (
                      <details className="group">
                        <summary className="cursor-pointer text-red-600 dark:text-red-400 hover:underline list-none">
                          {l.errors.length} error
                          {l.errors.length === 1 ? "" : "s"} — show
                        </summary>
                        <ul className="mt-2 space-y-1 text-zinc-700 dark:text-zinc-300 max-w-xl">
                          {l.errors.map((e, i) => (
                            <li
                              key={i}
                              className="font-mono text-[11px] break-words whitespace-pre-wrap"
                            >
                              {e}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
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
