import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  comparisonCanonicalsCol,
  comparisonListingsCol,
} from "@/lib/firestore/collections";

/**
 * GET /api/comparison/canonicals
 *
 * List the signed-in user's canonical products, each joined with the
 * latest snapshot of its linked listings. Used by /comparison/compare.
 *
 * ?limit=<n> default 200, capped at 500.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get("limit") || "200", 10);
  const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 200 : limitRaw), 500);

  const canonicalsSnap = await comparisonCanonicalsCol()
    .where("owner_uid", "==", session.uid)
    .orderBy("created_at", "desc")
    .limit(limit)
    .get();

  // Batch-fetch every referenced listing in chunks of 10 (Firestore `in` cap).
  const listingIds = new Set<string>();
  for (const d of canonicalsSnap.docs) {
    const ids = (d.data().listing_ids ?? []) as string[];
    for (const lid of ids) listingIds.add(lid);
  }
  const ids = Array.from(listingIds);
  const listingsById = new Map<string, FirebaseFirestore.DocumentData>();
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    if (chunk.length === 0) continue;
    const chunkSnap = await comparisonListingsCol()
      .where(
        "__name__",
        "in",
        chunk.map((lid) => comparisonListingsCol().doc(lid))
      )
      .get();
    for (const ld of chunkSnap.docs) {
      // Defensive: only include listings that belong to the same owner.
      if (ld.data().owner_uid !== session.uid) continue;
      listingsById.set(ld.id, { id: ld.id, ...ld.data() });
    }
  }

  const canonicals = canonicalsSnap.docs.map((d) => {
    const data = d.data();
    const linkedIds = (data.listing_ids ?? []) as string[];
    const listings = linkedIds
      .map((lid) => listingsById.get(lid))
      .filter((v): v is FirebaseFirestore.DocumentData => !!v);
    return { id: d.id, ...data, listings };
  });

  return NextResponse.json({ canonicals });
}
