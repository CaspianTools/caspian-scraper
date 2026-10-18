import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { comparisonListingsCol } from "@/lib/firestore/collections";

/**
 * GET /api/comparison/listings
 *
 * Optional query params:
 *   ?retailer_id=<id>    filter by retailer/source
 *   ?status=new|linked|stale|failed_extract
 *   ?unlinked=true       shorthand for canonical_id == null
 *   ?limit=<n>           default 200, capped at 1000
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const retailerId = url.searchParams.get("retailer_id");
  const status = url.searchParams.get("status");
  const unlinked = url.searchParams.get("unlinked") === "true";
  const limitRaw = parseInt(url.searchParams.get("limit") || "200", 10);
  const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 200 : limitRaw), 1000);

  let q: FirebaseFirestore.Query = comparisonListingsCol().where(
    "owner_uid",
    "==",
    session.uid
  );
  if (retailerId) q = q.where("retailer_id", "==", retailerId);
  if (status) q = q.where("status", "==", status);
  if (unlinked) q = q.where("canonical_id", "==", null);
  q = q.orderBy("last_seen_at", "desc").limit(limit);

  const snap = await q.get();
  const listings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ listings });
}
