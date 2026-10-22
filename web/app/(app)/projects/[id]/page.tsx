import Link from "next/link";
import { requireJob } from "@/lib/jobs";
import {
  carSourcesCol,
  comparisonSourcesCol,
  genericSourcesCol,
  sourcesCol,
} from "@/lib/firestore/collections";
import { listDatabases } from "@/lib/databases";
import { allRecords } from "@/lib/recordstore";
import { countLabel } from "@/lib/jobTemplates";
import { DatabaseView } from "@/components/databases/DatabaseView";
import { RunNowButton } from "@/components/RunNowButton";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * A job's Results — every engine's records gathered into one store
 * (job_results.py), paged and filtered on the server, worded in the job's
 * own record name ("42 vacancies"). New / changed / gone are since the last
 * run; records below the job's relevance cutoff are hidden by default.
 */
export default async function JobResultsPage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id);
  const s = job.settings;

  const [own, cars, shops, sites, databases] = await Promise.all([
    sourcesCol(id).count().get(),
    carSourcesCol().where("owner_uid", "==", job.uid).get(),
    comparisonSourcesCol().where("owner_uid", "==", job.uid).get(),
    genericSourcesCol().where("owner_uid", "==", job.uid).get(),
    listDatabases(job.uid),
  ]);
  const mine = (snap: typeof cars) => snap.docs.filter((d) => d.data().project_id === id).length;
  const sourceCount =
    own.data().count +
    ((job.data.resource_ids as string[] | undefined)?.length ?? 0) +
    s.reads_from.length +
    mine(cars) +
    mine(shops) +
    mine(sites);

  const records = allRecords(`job:${id}`);
  const live = records.filter((r) => r.status !== "gone" && !r.hidden);
  const fresh = live.filter((r) => r.status === "new").length;
  const changed = live.filter((r) => r.status === "changed").length;

  return (
    <>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">
            {countLabel(live.length, s)} found
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            {fresh > 0 || changed > 0 ? (
              <>
                <span className="font-medium text-emerald-700 dark:text-emerald-400">{fresh} new</span>
                {" · "}
                <span className="font-medium text-amber-700 dark:text-amber-400">{changed} changed</span>
                {" since the last run · "}
              </>
            ) : null}
            From {sourceCount} source{sourceCount === 1 ? "" : "s"}
            {s.saves_to.length > 0 && <> · saved into {s.saves_to.map((t) => t.database).join(", ")}</>}
          </p>
        </div>
        <div className="ml-auto">
          <RunNowButton projectId={id} />
        </div>
      </div>

      {sourceCount === 0 && (
        <div className="rounded-2xl border border-brand-200 dark:border-brand-400/30 bg-brand-50/60 dark:bg-brand-500/5 p-5 text-sm">
          <p className="font-semibold tracking-tight">Next steps</p>
          <ol className="mt-2 space-y-1 list-decimal list-inside text-zinc-700 dark:text-zinc-300">
            <li>
              Add the websites to collect {s.record_label.plural} from under{" "}
              <Link href={`/projects/${id}/sources`} className="underline">
                Sources
              </Link>
              {s.modules.discovery && (
                <>
                  {" "}— or find them with{" "}
                  <Link href={`/projects/${id}/discover`} className="underline">
                    Discover
                  </Link>
                </>
              )}
              .
            </li>
            <li>Press Run now (or use Start.bat); what it finds appears here.</li>
          </ol>
        </div>
      )}

      <DatabaseView
        db={{
          id,
          name: job.name,
          key: "url",
          kind: "job",
          record_label: s.record_label,
          columns: s.fields,
          cutoff: s.relevance.cutoff,
          databases: databases.map((d) => ({ id: d.id, name: d.name })),
        }}
      />
    </>
  );
}
