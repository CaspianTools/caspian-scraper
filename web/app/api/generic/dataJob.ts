import { projectDoc } from "@/lib/firestore/collections";

/**
 * True when `projectId` is one of `uid`'s jobs (any job can have "any
 * website" sources — jobs are generic, lib/jobTemplates.ts).
 * Shared by the generic-source and config-job (aiconfig) API routes.
 */
export async function isOwnedDataJob(
  projectId: string,
  uid: string
): Promise<boolean> {
  if (!projectId) return false;
  const snap = await projectDoc(projectId).get();
  const data = snap.exists ? snap.data() : undefined;
  return !!data && data.owner_uid === uid;
}
