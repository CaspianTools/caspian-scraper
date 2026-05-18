import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import {
  projectDoc,
  sourcesCol,
  destinationsCol,
  secretsCol,
  runsCol,
  lessonsCol,
  publishedCol,
} from "@/lib/firestore/collections";
import { humanizeCron } from "@/lib/cron/humanize";
import { TrendBars, type TrendBarRun } from "@/components/TrendBars";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

const CONSECUTIVE_ZERO_ALERT = 3;

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

function computeStaleSources(
  lessons: { source_id: string; source_name: string; verdict: string }[]
) {
  const bySource = new Map<
    string,
    { source_id: string; source_name: string; verdict: string }[]
  >();
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

export default async function ProjectOverviewPage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id } = await params;

  const snap = await projectDoc(id).get();
  if (!snap.exists) notFound();
  const data = snap.data();
  if (!data || data.owner_uid !== session.uid) notFound();

  const [
    sourcesCountSnap,
    destinationsCountSnap,
    secretsCountSnap,
    runsSnap,
    lessonsSnap,
    publishedSnap,
  ] = await Promise.all([
    sourcesCol(id).count().get(),
    destinationsCol(id).count().get(),
    secretsCol(id).count().get(),
    runsCol(id).orderBy("started_at", "desc").limit(14).get(),
    lessonsCol(id).orderBy("ts", "desc").limit(200).get(),
    publishedCol(id).orderBy("published_at", "desc").limit(5).get(),
  ]);

  const sourcesCount = sourcesCountSnap.data().count;
  const destsCount = destinationsCountSnap.data().count;
  const secretsCount = secretsCountSnap.data().count;

  // Trend chart wants oldest → newest; the query was newest first.
  const recentRuns = runsSnap.docs.map((d) => d.data());
  const trendData: TrendBarRun[] = recentRuns
    .slice()
    .reverse()
    .map((r, i) => {
      const totals = (r.totals ?? {}) as Record<string, number>;
      return {
        id: runsSnap.docs[runsSnap.docs.length - 1 - i].id,
        status: String(r.status ?? ""),
        started_at: tsToIso(r.started_at),
        found: Number(totals.found ?? 0),
        published: Number(totals.published ?? 0),
        errors_count: Number(totals.errors_count ?? 0),
      };
    });

  const latestRun = recentRuns[0];
  const latestRunId = runsSnap.docs[0]?.id;

  // Stale-source detection.
  const lessons = lessonsSnap.docs.map((d) => {
    const data = d.data();
    return {
      source_id: String(data.source_id ?? ""),
      source_name: String(data.source_name ?? ""),
      verdict: String(data.verdict ?? ""),
    };
  });
  const stale = computeStaleSources(lessons);

  // Recent published.
  const recentPublished = publishedSnap.docs.map((d) => d.data());

  const lastRunIso =
    tsToIso(data.last_run_at) ||
    (latestRun ? tsToIso(latestRun.started_at) : "");

  const needsSources = sourcesCount === 0;
  const needsDestinations = destsCount === 0;
  const needsSecrets = secretsCount === 0;
  const stillSettingUp = needsSources || needsDestinations || needsSecrets;

  return (
    <>
      {data.description && (
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          {data.description}
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Schedule"
          value={humanizeCron(data.schedule_cron)}
          hint={data.schedule_cron}
        />
        <StatCard
          label="Sources"
          value={String(sourcesCount)}
          link={`/projects/${id}/sources`}
        />
        <StatCard
          label="Last run"
          value={lastRunIso ? fmtRelative(lastRunIso) : "never"}
          hint={lastRunIso}
          link={latestRunId ? `/projects/${id}/runs/${latestRunId}` : undefined}
        />
        <StatCard
          label="Status"
          value={data.enabled !== false ? "enabled" : "disabled"}
        />
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
              <ul className="mt-2 space-y-1 text-sm">
                {stale.slice(0, 5).map((s) => (
                  <li key={s.source_id}>
                    <Link
                      href={`/projects/${id}/sources/${s.source_id}`}
                      className="underline hover:no-underline text-amber-900 dark:text-amber-200"
                    >
                      {s.source_name}
                    </Link>{" "}
                    <span className="text-xs text-amber-700 dark:text-amber-300">
                      · {s.consecutive} consecutive zero_found
                    </span>
                  </li>
                ))}
                {stale.length > 5 && (
                  <li className="text-xs">
                    <Link
                      href={`/projects/${id}/lessons?verdict=zero_found`}
                      className="underline text-amber-900 dark:text-amber-200"
                    >
                      and {stale.length - 5} more…
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {latestRun && (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-medium">Last run</h3>
              <span
                className={
                  "text-xs px-2 py-0.5 rounded-full " +
                  statusClasses(String(latestRun.status ?? ""))
                }
              >
                {String(latestRun.status ?? "").replace("_", " ")}
              </span>
              {latestRun.dry_run && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  dry run
                </span>
              )}
            </div>
            {latestRunId && (
              <Link
                href={`/projects/${id}/runs/${latestRunId}`}
                className="text-sm underline text-zinc-700 dark:text-zinc-300"
              >
                View details →
              </Link>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <RunStat
              label="Checked"
              value={Number(
                (latestRun.totals as Record<string, number>)?.checked ?? 0
              )}
            />
            <RunStat
              label="Found"
              value={Number(
                (latestRun.totals as Record<string, number>)?.found ?? 0
              )}
            />
            <RunStat
              label="Published"
              value={Number(
                (latestRun.totals as Record<string, number>)?.published ?? 0
              )}
            />
            <RunStat
              label="Duplicates"
              value={Number(
                (latestRun.totals as Record<string, number>)?.skipped_duplicate ?? 0
              )}
            />
            <RunStat
              label="Errors"
              value={Number(
                (latestRun.totals as Record<string, number>)?.errors_count ?? 0
              )}
            />
          </div>
        </div>
      )}

      {trendData.length > 1 && (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-medium">
                Trend (last {trendData.length} runs)
              </h3>
              <p className="text-xs text-zinc-500 mt-1">
                Bar height = found · colour = status · click to open
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Legend color="bg-emerald-500" label="ok" />
              <Legend color="bg-amber-500" label="partial" />
              <Legend color="bg-red-500" label="error" />
              <Legend color="bg-blue-400" label="running" />
            </div>
          </div>
          <div className="overflow-x-auto">
            <TrendBars projectId={id} runs={trendData} />
          </div>
        </div>
      )}

      {recentPublished.length > 0 && (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
          <div className="px-4 py-2 text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
            Recently published
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 text-sm">
            {recentPublished.map((p, i) => {
              const published_at = tsToIso(p.published_at);
              return (
                <li key={i} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {String(p.title ?? "(untitled)")}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {String(p.employer ?? "")}
                      {p.location ? ` · ${p.location}` : ""}
                      {p.country
                        ? ` · ${String(p.country).toUpperCase()}`
                        : ""}
                    </div>
                  </div>
                  <span className="text-xs text-zinc-500 shrink-0">
                    {fmtRelative(published_at)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {stillSettingUp && (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6">
          <h2 className="text-lg font-medium mb-2">Next steps</h2>
          <ol className="text-sm text-zinc-600 dark:text-zinc-400 space-y-2 list-decimal list-inside">
            {needsSources && (
              <li>
                Add{" "}
                <Link
                  href={`/projects/${id}/sources`}
                  className="underline"
                >
                  sources
                </Link>{" "}
                — the URLs to scrape (each tagged with an ATS type).
              </li>
            )}
            {needsDestinations && (
              <li>
                Configure a{" "}
                <Link
                  href={`/projects/${id}/destinations`}
                  className="underline"
                >
                  destination
                </Link>{" "}
                — the API to POST findings to.
              </li>
            )}
            {needsSecrets && (
              <li>
                Store the API key for that destination as a{" "}
                <Link
                  href={`/projects/${id}/secrets`}
                  className="underline"
                >
                  secret
                </Link>
                .
              </li>
            )}
            <li>
              Wait for the schedule, or trigger an ad-hoc run from{" "}
              <Link href={`/projects/${id}/runs`} className="underline">
                Runs
              </Link>
              .
            </li>
          </ol>
        </div>
      )}
    </>
  );
}

function StatCard({
  label,
  value,
  link,
  hint,
}: {
  label: string;
  value: string;
  link?: string;
  hint?: string;
}) {
  const body = (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 hover:border-zinc-400 dark:hover:border-zinc-600 transition-colors">
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
        {label}
      </div>
      <div
        className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate"
        title={hint || value}
      >
        {value}
      </div>
    </div>
  );
  return link ? <Link href={link}>{body}</Link> : body;
}

function RunStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-0.5">
        {label}
      </div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={"w-2.5 h-2.5 rounded-sm inline-block " + color} />
      {label}
    </span>
  );
}
