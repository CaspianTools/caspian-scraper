import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import { ComparisonListingMatchSchema } from "@/lib/firestore/schema";
import {
  comparisonListingsCol,
  comparisonCanonicalsCol,
} from "@/lib/firestore/collections";

function makeCanonicalId(): string {
  // base36 timestamp + 6 random chars. Unique enough per user; avoids a
  // nanoid dependency.
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `c-${t}${r}`;
}

/**
 * POST /api/comparison/listings/[lid]/match
 *
 * Body is one of:
 *   { canonical_id: "..." }                            → attach to existing
 *   { create_canonical: { display_name, brand, ... } } → create then attach
 *
 * Refuses to re-link an already-linked listing (matching is write-once;
 * see plan v2 §4). Owner check on both the listing AND the target canonical.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/comparison/listings/[lid]/match">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { lid } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = ComparisonListingMatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid match", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const listingRef = comparisonListingsCol().doc(lid);
  const listingSnap = await listingRef.get();
  if (!listingSnap.exists) {
    return NextResponse.json({ error: "listing not found" }, { status: 404 });
  }
  const listing = listingSnap.data()!;
  if (listing.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (listing.canonical_id) {
    return NextResponse.json(
      {
        error: "listing already linked",
        canonical_id: listing.canonical_id,
      },
      { status: 409 }
    );
  }

  let canonicalId: string;
  if ("canonical_id" in parsed.data) {
    canonicalId = parsed.data.canonical_id;
    const canSnap = await comparisonCanonicalsCol().doc(canonicalId).get();
    if (!canSnap.exists || canSnap.data()?.owner_uid !== session.uid) {
      return NextResponse.json(
        { error: "canonical not found" },
        { status: 404 }
      );
    }
    const data = canSnap.data() ?? {};
    const listingIds: string[] = data.listing_ids ?? [];
    const retailerIds: string[] = data.retailer_ids ?? [];
    if (!listingIds.includes(lid)) listingIds.push(lid);
    const retailerId = String(listing.retailer_id ?? "");
    if (retailerId && !retailerIds.includes(retailerId)) {
      retailerIds.push(retailerId);
    }
    await comparisonCanonicalsCol().doc(canonicalId).update({
      listing_ids: listingIds,
      retailer_ids: retailerIds,
    });
  } else {
    canonicalId = makeCanonicalId();
    const init = parsed.data.create_canonical;
    await comparisonCanonicalsCol()
      .doc(canonicalId)
      .set({
        owner_uid: session.uid,
        display_name: init.display_name,
        brand: init.brand,
        size_value: init.size_value,
        size_unit: init.size_unit,
        gtin: null,
        listing_ids: [lid],
        retailer_ids: [String(listing.retailer_id ?? "")].filter(Boolean),
        created_at: FieldValue.serverTimestamp(),
        confirmed_by: session.uid,
      });
  }

  await listingRef.update({
    canonical_id: canonicalId,
    status: "linked",
  });
  return NextResponse.json({ ok: true, canonical_id: canonicalId });
}
