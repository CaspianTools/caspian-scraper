import Link from "next/link";
import { notFound } from "next/navigation";
import { sourcesCol } from "@/lib/firestore/collections";
import {
  SourceForm,
  type SourceFormInitial,
} from "@/components/SourceForm";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; sourceId: string }>;
}

export default async function EditSourcePage({ params }: PageProps) {
  const { id, sourceId } = await params;
  // Ownership enforced by parent layout.
  const snap = await sourcesCol(id).doc(sourceId).get();
  if (!snap.exists) notFound();
  const data = snap.data() ?? {};

  const initial: SourceFormInitial = {
    name: data.name ?? "",
    kind: (data.kind as SourceFormInitial["kind"]) ?? "employer",
    ats: (data.ats as SourceFormInitial["ats"]) ?? "unknown",
    careers_url: data.careers_url ?? "",
    active: data.active !== false,
    countries: Array.isArray(data.countries) ? data.countries : [],
    segment: data.segment ?? "",
    headquarters: data.headquarters ?? "",
    website: data.website ?? "",
    linkedin: data.linkedin ?? "",
    notes: data.notes ?? "",
  };

  return (
    <>
      <Link
        href={`/projects/${id}/sources`}
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Sources
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">
        Edit {initial.name || "source"}
      </h2>
      <SourceForm projectId={id} sourceId={sourceId} initial={initial} />
    </>
  );
}
