import Link from "next/link";
import { notFound } from "next/navigation";
import { requireJob } from "@/lib/jobs";
import { comparisonSourcesCol } from "@/lib/firestore/collections";
import { ComparisonSourceForm } from "@/components/ComparisonSourceForm";
import type {
  ComparisonSourceFormInitial,
  ExtractionConfigInput,
} from "@/components/comparisonSourceFormDefaults";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; sid: string }>;
}

/** Edit one shop of a prices job; 404 for a source of another job. */
export default async function EditPricesSourcePage({ params }: PageProps) {
  const { id, sid } = await params;
  const job = await requireJob(id, "prices");

  const snap = await comparisonSourcesCol().doc(sid).get();
  if (!snap.exists) notFound();
  const data = snap.data();
  if (!data || data.owner_uid !== job.uid || data.project_id !== job.id) {
    notFound();
  }

  const initial: ComparisonSourceFormInitial = {
    name: String(data.name ?? ""),
    retailer_id: String(data.retailer_id ?? ""),
    home_url: String(data.home_url ?? ""),
    start_urls: Array.isArray(data.start_urls)
      ? (data.start_urls as string[])
      : [],
    extraction: (data.extraction ?? {
      link_discovery: { mode: "css", link_selector: "a[href]", max_pages: 5 },
      extractors: [{ type: "jsonld_product" }],
      request_delay_ms: 1500,
      respect_robots: true,
    }) as ExtractionConfigInput,
    schedule_cron: String(data.schedule_cron ?? "30 4 * * *"),
    active: data.active !== false,
    notes: String(data.notes ?? ""),
  };

  return (
    <>
      <Link
        href={`/projects/${job.id}/prices/sources`}
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Sources
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">
        Edit {initial.name || "shop"}
      </h2>
      <ComparisonSourceForm initial={initial} projectId={job.id} sourceId={sid} />
    </>
  );
}
