import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { carListingsCol } from "@/lib/firestore/collections";

/** Millis from a Firestore Timestamp, ISO string, or 0. */
function millis(v: unknown): number {
  if (v && typeof (v as { toMillis?: () => number }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

// Equality-only fetch cap; sort + slice happen in memory (no composite index).
const FETCH_CAP = 3000;

/**
 * GET /api/cars/listings
 *
 * Optional query params:
 *   ?source_id=<sid>   filter to one source
 *   ?site=opensooq|…   filter by site
 *   ?status=new|seen
 *   ?limit=<n>         default 200, capped at 1000
 *
 * Uses equality-only filters + in-memory sort by last_seen_at so no
 * composite index is required on the shared `scraper` DB.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const sourceId = url.searchParams.get("source_id");
  const site = url.searchParams.get("site");
  const status = url.searchParams.get("status");
  const limitRaw = parseInt(url.searchParams.get("limit") || "200", 10);
  const limit = Math.min(Math.max(1, Number.isNaN(limitRaw) ? 200 : limitRaw), 1000);

  let q: FirebaseFirestore.Query = carListingsCol().where(
    "owner_uid",
    "==",
    session.uid
  );
  if (sourceId) q = q.where("source_id", "==", sourceId);
  if (site) q = q.where("site", "==", site);
  if (status) q = q.where("status", "==", status);
  q = q.limit(FETCH_CAP);

  const snap = await q.get();
  const listings = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
    .sort((a, b) => millis(b.last_seen_at) - millis(a.last_seen_at))
    .slice(0, limit);
  return NextResponse.json({ listings });
}
