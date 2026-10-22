import Link from "next/link";
import { requireJob, jobSourceIds } from "@/lib/jobs";
import { comparisonSourcesCol } from "@/lib/firestore/collections";
import { allRecords } from "@/lib/recordstore";
import { countLabel } from "@/lib/jobTemplates";
import { compareGroups } from "@/lib/compareGroups";
import { CompareTable } from "@/components/job-modules/CompareTable";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * A job's Compare page (the compare module): the same item across this job's
 * sources, matched over its results store (job:<id>) by product code or by
 * name — see lib/compareGroups.ts. Shops' hand-made matches live on
 * /projects/[id]/prices/compare.
 */
export default async function ComparePage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id);
  const records = allRecords(`job:${id}`);
  const shopSources = await jobSourceIds(comparisonSourcesCol(), job);
  const { groups, sources } = compareGroups(records);
  const live = records.filter((r) => r.hidden !== true && r.status !== "gone").length;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Compare</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            {groups.length > 0
              ? `${countLabel(groups.length, job.settings)} found in 2+ sources (${sources.length} sources in all). The cheapest price in each row is highlighted.`
              : "The same item across this job's sources, side by side."}
          </p>
        </div>
        {shopSources.size > 0 && (
          <Link
            href={`/projects/${id}/prices/compare`}
            className="text-sm font-medium text-brand-700 dark:text-brand-300 hover:underline"
          >
            Match products by hand →
          </Link>
        )}
      </div>

      {!job.settings.modules.compare && (
        <p className="rounded-xl bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm">
          Compare is turned off for this job, so it isn&apos;t in the job&apos;s menu.{" "}
          <Link href={`/projects/${id}/settings`} className="underline">
            Turn it on in Settings
          </Link>
          .
        </p>
      )}

      {groups.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center bg-white/60 dark:bg-zinc-950/40">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-lg mx-auto">
            Compare matches the same item across this job&apos;s sources — by product code when the
            sources give one, otherwise by name — and shows their prices side by side.{" "}
            {live === 0
              ? "This job has no results yet: add sources and run the job."
              : `None of this job's ${live.toLocaleString()} results is in two or more sources yet: add more sources, or run the job again.`}
          </p>
          <div className="mt-4 flex justify-center gap-4 text-sm">
            <Link href={`/projects/${id}/sources`} className="font-medium text-brand-700 dark:text-brand-300 hover:underline">
              Sources →
            </Link>
            <Link href={`/projects/${id}/runs`} className="font-medium text-brand-700 dark:text-brand-300 hover:underline">
              Runs →
            </Link>
          </div>
        </div>
      ) : (
        <CompareTable groups={groups} sources={sources} />
      )}
    </>
  );
}
