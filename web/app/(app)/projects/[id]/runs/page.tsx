import Link from "next/link";
import {
  carRunsCol,
  carSourcesCol,
  comparisonRunsCol,
  genericRunsCol,
  genericSourcesCol,
  lessonsCol,
  runRequestsCol,
  runsCol,
} from "@/lib/firestore/collections";
import { jobSourceIds, requireJob } from "@/lib/jobs";
import { pricesJobScope } from "@/app/api/comparison/jobScope";
import { RunNowButton } from "@/components/RunNowButton";
import { DryRunPanel } from "@/components/DryRunPanel";
import { fmtRelative, millis, statusClasses } from "@/components/job-sources/format";
import type { DocumentData } from "@/lib/localdb";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

interface RequestRow {
  id: string;
  status: string;
  createdMs: number;
}

type Engine = "careers" | "cars" | "shop" | "website";

const ENGINE_LABEL: Record<Engine, string> = {
  careers: "Careers pages",
  cars: "Classifieds",
  shop: "Shop",
  website: "Website",
};

/** One run of any engine, as a row of the merged list. */
interface RunRow {
  key: string;
  id: string;
  engine: Engine;
  /** The source the run scraped (careers-page runs cover all of them). */
  title: string;
  href: string;
  status: string;
  startedMs: number;
  counts: string;
  trigger: string;
}

/** Most rows shown; vacancy runs are fetched newest first up to this too. */
const SHOW = 100;

function totalsOf(data: DocumentData): Record<string, number> {
  return (data.totals ?? {}) as Record<string, number>;
}

/**
 * A job's Runs: every engine's runs merged newest first — careers-page runs
 * (projects/{id}/runs: one per job run, over all its careers pages) and the
 * per-source runs of its classifieds sites (car_runs), shops
 * (comparison_runs) and any-website scrapes (generic_runs), matched to this
 * job by `source_id`. Each row opens that engine's own run page (generic
 * runs: the source's page, which lists its runs). Run now runs every part
 * of the job.
 */
export default async function RunsPage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id);
  const base = `/projects/${job.id}`;

  const [requestsSnap, runsSnap, lessonsSnap, carIds, priceScope, webIds, carSnap, shopSnap, webSnap] =
    await Promise.all([
      runRequestsCol()
        .where("project_id", "==", id)
        .orderBy("created_at", "desc")
        .limit(20)
        .get(),
      runsCol(id).orderBy("started_at", "desc").limit(SHOW).get(),
      lessonsCol(id).limit(1).get(),
      jobSourceIds(carSourcesCol(), job),
      pricesJobScope(job.uid, job.id),
      jobSourceIds(genericSourcesCol(), job),
      // Equality-only queries, filtered to this job's sources below; no
      // limit() without orderBy, which would drop arbitrary (maybe newest) runs.
      carRunsCol().where("owner_uid", "==", job.uid).get(),
      comparisonRunsCol().where("owner_uid", "==", job.uid).orderBy("started_at", "desc").get(),
      genericRunsCol().where("owner_uid", "==", job.uid).get(),
    ]);

  const requests: RequestRow[] = requestsSnap.docs.map((d) => {
    const data = d.data();
    return { id: d.id, status: String(data.status ?? ""), createdMs: millis(data.created_at) };
  });
  const pendingRequests = requests.filter((r) => r.status === "pending");
  const hasLessons = !lessonsSnap.empty;

  const rows: RunRow[] = [];
  for (const d of runsSnap.docs) {
    const data = d.data();
    const t = totalsOf(data);
    rows.push({
      key: `careers:${d.id}`,
      id: d.id,
      engine: "careers",
      title: data.dry_run ? "All careers pages (dry run)" : "All careers pages",
      href: `${base}/runs/${d.id}`,
      status: String(data.status ?? ""),
      startedMs: millis(data.started_at),
      counts:
        Object.keys(t).length > 0
          ? `${Number(t.found ?? 0)} found · ${Number(t.published ?? 0)} published · ${Number(t.errors_count ?? 0)} err`
          : "",
      trigger: String(data.trigger ?? ""),
    });
  }
  for (const d of carSnap.docs) {
    const data = d.data();
    if (!carIds.has(String(data.source_id ?? ""))) continue;
    const t = totalsOf(data);
    rows.push({
      key: `cars:${d.id}`,
      id: d.id,
      engine: "cars",
      title: String(data.source_name ?? data.source_id ?? "(unknown)"),
      href: `${base}/cars/runs/${d.id}`,
      status: String(data.status ?? ""),
      startedMs: millis(data.started_at),
      counts: `${Number(t.found ?? 0)} found · ${Number(t.new ?? 0)} new · ${Number(t.errors_count ?? 0)} err`,
      trigger: String(data.trigger ?? ""),
    });
  }
  for (const d of shopSnap.docs) {
    const data = d.data();
    if (!priceScope.hasRun(data)) continue;
    const t = totalsOf(data);
    rows.push({
      key: `shop:${d.id}`,
      id: d.id,
      engine: "shop",
      title: String(data.source_name ?? data.source_id ?? "(unknown)"),
      href: `${base}/prices/runs/${d.id}`,
      status: String(data.status ?? ""),
      startedMs: millis(data.started_at),
      counts: `${Number(t.found ?? 0)} found · ${Number(t.extracted ?? 0)} extracted · ${Number(t.errors_count ?? 0)} err`,
      trigger: String(data.trigger ?? ""),
    });
  }
  for (const d of webSnap.docs) {
    const data = d.data();
    const sid = String(data.source_id ?? "");
    if (!webIds.has(sid)) continue;
    const t = totalsOf(data);
    rows.push({
      key: `website:${d.id}`,
      id: d.id,
      engine: "website",
      title: String(data.source_name ?? sid),
      href: `${base}/data/sources/${sid}`,
      status: String(data.status ?? ""),
      startedMs: millis(data.started_at),
      counts: `${Number(t.found ?? 0)} found · ${Number(t.extracted ?? 0)} extracted · ${Number(t.errors_count ?? 0)} err`,
      trigger: String(data.trigger ?? ""),
    });
  }
  // A run still "running" has no server timestamp yet in some stores: keep it on top.
  const sortKey = (r: RunRow) => r.startedMs || Number.MAX_SAFE_INTEGER;
  rows.sort((a, b) => sortKey(b) - sortKey(a));
  const shown = rows.slice(0, SHOW);

  return (
    <>
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Runs</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Scrape history of every part of this job. Run now scrapes all of
            its sources.
            {hasLessons && (
              <>
                {" "}
                <Link href={`${base}/lessons`} className="underline">
                  Lessons
                </Link>{" "}
                — per-source verdicts from careers-page runs.
              </>
            )}
          </p>
        </div>
        <RunNowButton projectId={id} />
      </div>

      <DryRunPanel projectId={id} />

      {pendingRequests.length > 0 && (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 shadow-card">
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
                  queued {fmtRelative(r.createdMs, "—")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden shadow-card">
        <div className="px-4 py-2 text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
          Recent runs
          {rows.length > SHOW && (
            <span className="normal-case tracking-normal"> · newest {SHOW} of {rows.length}</span>
          )}
        </div>
        {shown.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            No runs yet. Add a source under{" "}
            <Link href={`${base}/sources`} className="underline">
              Sources
            </Link>
            , then press Run now.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 text-sm">
            {shown.map((r) => (
              <li key={r.key}>
                <Link
                  href={r.href}
                  className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-md bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-500/15 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-400/15">
                        {ENGINE_LABEL[r.engine]}
                      </span>
                      <span className="font-medium truncate">{r.title}</span>
                      <span
                        className={
                          "text-xs font-medium px-2 py-0.5 rounded-full " +
                          statusClasses(r.status)
                        }
                      >
                        {r.status.replace("_", " ") || "unknown"}
                      </span>
                      {r.counts && (
                        <span className="text-xs text-zinc-600 dark:text-zinc-400 tabular-nums">
                          {r.counts}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">
                      started {fmtRelative(r.startedMs, "—")}
                      {r.trigger && <> · trigger {r.trigger}</>}
                    </div>
                  </div>
                  <code className="text-xs text-zinc-500 shrink-0 hidden sm:block">{r.id}</code>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
