import Link from "next/link";
import { requireJob } from "@/lib/jobs";
import { TEMPLATE_INFO } from "@/lib/jobTemplates";
import { listResources } from "@/lib/firestore/resources";
import { DiscoverWorkspace } from "@/components/job-modules/DiscoverWorkspace";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * A job's Discover page (the discovery module): find websites — Google Maps,
 * the web, Wikidata, OpenStreetMap, the companies database — and add them to
 * this job as shared-library websites.
 */
export default async function DiscoverPage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id);

  const header = (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">Discover</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
        Find companies and their websites, then add the ones you want to this job.
      </p>
    </div>
  );

  if (!job.settings.modules.discovery) {
    return (
      <>
        {header}
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center bg-white/60 dark:bg-zinc-950/40">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md mx-auto">
            Discover is turned off for this job.{" "}
            <Link href={`/projects/${id}/settings`} className="font-medium text-brand-700 dark:text-brand-300 hover:underline">
              Turn it on in Settings
            </Link>{" "}
            to find websites to add as sources.
          </p>
        </div>
      </>
    );
  }

  const library = await listResources(job.uid);
  const rawIds = job.data.resource_ids;
  // The job's description prefills the search — unless it is still the
  // template's stock sentence, which makes a poor query.
  const description = typeof job.data.description === "string" ? job.data.description.trim() : "";
  const defaultQuery = description === TEMPLATE_INFO[job.settings.template].description ? "" : description;
  const resourceIds = Array.isArray(rawIds) ? rawIds.filter((x): x is string => typeof x === "string") : [];

  return (
    <>
      {header}
      <DiscoverWorkspace
        job={{ id: job.id, name: job.name, resource_ids: resourceIds }}
        defaultQuery={defaultQuery}
        library={library}
      />
    </>
  );
}
