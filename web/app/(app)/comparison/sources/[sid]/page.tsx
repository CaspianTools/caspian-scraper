import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { comparisonSourcesCol } from "@/lib/firestore/collections";
import { ComparisonSourceForm } from "@/components/ComparisonSourceForm";
import type {
  ComparisonSourceFormInitial,
  ExtractionConfigInput,
} from "@/components/comparisonSourceFormDefaults";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ sid: string }>;
}

export default async function EditComparisonSourcePage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { sid } = await params;

  const snap = await comparisonSourcesCol().doc(sid).get();
  if (!snap.exists) notFound();
  const data = snap.data();
  if (!data || data.owner_uid !== session.uid) notFound();

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
        href="/comparison/sources"
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Sources
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">
        Edit {initial.name || "source"}
      </h2>
      <ComparisonSourceForm initial={initial} sourceId={sid} />
    </>
  );
}
