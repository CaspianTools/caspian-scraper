import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { projectDoc, type carSourcesCol } from "@/lib/firestore/collections";
import { jobSettings, type JobSettings } from "@/lib/jobTemplates";

export interface JobRef {
  id: string;
  name: string;
  uid: string;
  settings: JobSettings;
  data: Record<string, unknown>;
}

/** For pages under /projects/[id]/…: the session's job, or 404. */
export async function requireJob(id: string): Promise<JobRef> {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const snap = await projectDoc(id).get();
  const data = snap.exists ? snap.data() : undefined;
  if (!data || data.owner_uid !== session.uid) notFound();
  return { id, name: String(data.name ?? id), uid: session.uid, settings: jobSettings(data), data };
}

/** For API routes: is this the user's job? */
export async function isOwnJob(projectId: string, uid: string): Promise<boolean> {
  if (!projectId) return false;
  const snap = await projectDoc(projectId).get();
  return snap.exists && snap.data()?.owner_uid === uid;
}

/** The ids of a job's sources in a top-level source collection
 *  (car_sources / comparison_sources / generic_sources). */
export async function jobSourceIds(
  col: ReturnType<typeof carSourcesCol>,
  job: { id: string; uid: string }
): Promise<Set<string>> {
  const snap = await col.where("owner_uid", "==", job.uid).get();
  return new Set(snap.docs.filter((d) => d.data().project_id === job.id).map((d) => d.id));
}
