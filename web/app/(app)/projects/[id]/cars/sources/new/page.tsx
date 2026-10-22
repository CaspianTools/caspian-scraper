import Link from "next/link";
import { CarSourceForm } from "@/components/CarSourceForm";
import { emptyCarSourceInitial } from "@/components/carSourceFormDefaults";
import { requireJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function NewCarSourcePage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id, "cars");
  return (
    <>
      <Link
        href={`/projects/${job.id}/cars/sources`}
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Sources
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">Add source</h2>
      <CarSourceForm projectId={job.id} initial={emptyCarSourceInitial()} />
    </>
  );
}
