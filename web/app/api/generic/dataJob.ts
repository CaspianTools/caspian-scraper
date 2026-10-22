import { projectDoc } from "@/lib/firestore/collections";
import { jobKind } from "@/lib/jobKinds";

/**
 * True when `projectId` is one of `uid`'s jobs of kind "data" ("Website
 * data") — the only jobs generic sources and config jobs may belong to.
 * Shared by the generic-source and config-job (aiconfig) API routes.
 */
export async function isOwnedDataJob(
  projectId: string,
  uid: string
): Promise<boolean> {
  if (!projectId) return false;
  const snap = await projectDoc(projectId).get();
  const data = snap.exists ? snap.data() : undefined;
  return !!data && data.owner_uid === uid && jobKind(data.kind) === "data";
}
