import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { projectDoc, type carSourcesCol } from "@/lib/firestore/collections";
import { jobHome, jobKind, type JobKind } from "@/lib/jobKinds";

export interface JobRef {
  id: string;
  name: string;
  kind: JobKind;
  uid: string;
  data: Record<string, unknown>;
}

/**
 * For pages under /projects/[id]/…: the session's job, or 404. With `kind`,
 * a job of another type is sent to its own home page instead (e.g. a car
 * job's URL with /prices in it).
 */
export async function requireJob(id: string, kind?: JobKind): Promise<JobRef> {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const snap = await projectDoc(id).get();
  const data = snap.exists ? snap.data() : undefined;
  if (!data || data.owner_uid !== session.uid) notFound();
  const k = jobKind(data.kind);
  if (kind && k !== kind) redirect(jobHome(id, k));
  return { id, name: String(data.name ?? id), kind: k, uid: session.uid, data };
}

/** The ids of a job's sources in a top-level source collection
 *  (car_sources / comparison_sources / generic_sources). */
export async function jobSourceIds(
  col: ReturnType<typeof carSourcesCol>,
  job: JobRef
): Promise<Set<string>> {
  const snap = await col.where("owner_uid", "==", job.uid).get();
  return new Set(snap.docs.filter((d) => d.data().project_id === job.id).map((d) => d.id));
}
