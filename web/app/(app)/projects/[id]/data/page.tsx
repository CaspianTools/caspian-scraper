import { requireJob, jobSourceIds } from "@/lib/jobs";
import { genericSourcesCol } from "@/lib/firestore/collections";
import { AiConfigDashboard } from "@/components/aiconfig/AiConfigDashboard";
import { RunNowButton } from "@/components/RunNowButton";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * A "Website data" job's home: its sources and what they collected. Two
 * surfaces via a client-side tab switcher: "Sources" (this job's generic
 * sources → records and runs on each source's page) and "New scrape" (the
 * ConfigWizard — describe a site, approve the proposed config into a source
 * of this job; Use AI is optional, its key is in /settings). Opens on
 * "New scrape" while the job has no sources. The page stays a server
 * component doing the job guard; all interactivity lives in AiConfigDashboard.
 */
export default async function DataJobPage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id, "data");
  const sourceIds = await jobSourceIds(genericSourcesCol(), job);

  return (
    <>
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="max-w-2xl">
          <h2 className="text-xl font-semibold tracking-tight">Sources &amp; records</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Describe a site and what to collect from it. The page is inspected,
            a scraper config is proposed and checked against the live page,
            and — once you approve — it becomes a source of this job that
            scrapes on its own schedule. Turn on <strong>Use AI</strong>{" "}for
            sites the automatic setup can&apos;t handle (the AI key is in
            Settings).
          </p>
        </div>
        {sourceIds.size > 0 && <RunNowButton projectId={job.id} />}
      </div>

      <AiConfigDashboard
        projectId={job.id}
        initialTab={sourceIds.size > 0 ? "sources" : "new"}
      />
    </>
  );
}
