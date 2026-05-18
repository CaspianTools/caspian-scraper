import Link from "next/link";
import { SourceForm } from "@/components/SourceForm";
import { emptySourceFormInitial } from "@/components/sourceFormDefaults";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function NewSourcePage({ params }: PageProps) {
  const { id } = await params;
  return (
    <>
      <Link
        href={`/projects/${id}/sources`}
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Sources
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">Add source</h2>
      <SourceForm projectId={id} initial={emptySourceFormInitial()} />
    </>
  );
}
