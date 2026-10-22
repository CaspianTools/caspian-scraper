import { notFound } from "next/navigation";
import { requireJob } from "@/lib/jobs";
import { genericSourcesCol } from "@/lib/firestore/collections";
import { GenericSourceDetail } from "@/components/aiconfig/GenericSourceDetail";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; sid: string }>;
}

/**
 * Generic-source detail inside its "Website data" job. 404s unless the
 * source is the session's and belongs to this job; the data loading happens
 * client-side in GenericSourceDetail via the /api/generic/sources/[sid]
 * routes (which enforce owner == session.uid too).
 */
export default async function GenericSourcePage({ params }: PageProps) {
  const { id, sid } = await params;
  const job = await requireJob(id, "data");

  const snap = await genericSourcesCol().doc(sid).get();
  const src = snap.exists ? snap.data() : undefined;
  if (!src || src.owner_uid !== job.uid || src.project_id !== job.id) notFound();

  return <GenericSourceDetail projectId={job.id} sid={sid} />;
}
