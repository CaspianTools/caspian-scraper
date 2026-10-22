import Link from "next/link";
import { requireJob } from "@/lib/jobs";
import { ComparisonSourceForm } from "@/components/ComparisonSourceForm";
import { emptyComparisonSourceInitial } from "@/components/comparisonSourceFormDefaults";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function NewPricesSourcePage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id, "prices");
  return (
    <>
      <Link
        href={`/projects/${job.id}/prices/sources`}
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Sources
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">Add a shop</h2>
      <ComparisonSourceForm
        initial={emptyComparisonSourceInitial()}
        projectId={job.id}
      />
    </>
  );
}
