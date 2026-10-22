import { comparisonSourcesCol, projectDoc } from "@/lib/firestore/collections";
import { jobKind } from "@/lib/jobKinds";
import type { DocumentData, QueryDocumentSnapshot } from "@/lib/localdb";

/**
 * One prices job's slice of the comparison collections. Sources carry the
 * job's id in `project_id`; listings and runs point at their source by
 * `source_id` (listings also carry the source's `retailer_id`, unique per
 * owner); a canonical belongs to the job when one of its `listing_ids` does.
 * Shared by the /projects/[id]/prices pages and the ?project_id= filters of
 * the /api/comparison list routes.
 */
export interface PricesJobScope {
  sources: QueryDocumentSnapshot[];
  sourceIds: Set<string>;
  retailerIds: Set<string>;
  hasListing: (listing: DocumentData) => boolean;
  hasRun: (run: DocumentData) => boolean;
}

export async function pricesJobScope(
  uid: string,
  projectId: string
): Promise<PricesJobScope> {
  const snap = await comparisonSourcesCol()
    .where("owner_uid", "==", uid)
    .orderBy("created_at", "desc")
    .get();
  const sources = snap.docs.filter((d) => d.data().project_id === projectId);
  const sourceIds = new Set(sources.map((d) => d.id));
  const retailerIds = new Set(
    sources.map((d) => String(d.data().retailer_id ?? "")).filter(Boolean)
  );
  return {
    sources,
    sourceIds,
    retailerIds,
    hasListing: (l) =>
      sourceIds.has(String(l.source_id ?? "")) ||
      retailerIds.has(String(l.retailer_id ?? "")),
    hasRun: (r) => sourceIds.has(String(r.source_id ?? "")),
  };
}

/** True when `projectId` is one of `uid`'s jobs of kind "prices". */
export async function isOwnPricesJob(
  uid: string,
  projectId: string
): Promise<boolean> {
  const snap = await projectDoc(projectId).get();
  const data = snap.exists ? snap.data() : undefined;
  return !!data && data.owner_uid === uid && jobKind(data.kind) === "prices";
}
