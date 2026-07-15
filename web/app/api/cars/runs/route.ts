import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { carRunsCol } from "@/lib/firestore/collections";

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

const FETCH_CAP = 1000;

/**
 * GET /api/cars/runs — recent car-scrape runs for the signed-in user,
 * newest first. Equality-only filter + in-memory sort (no composite index).
 *
 *   ?source_id=<sid>   filter to one source
 *   ?limit=<n>         default 50, capped at 200
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const sourceId = url.searchParams.get("source_id");
  const limitRaw = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Math.min(Math.max(1, Number.isNaN(limitRaw) ? 50 : limitRaw), 200);

  let q: FirebaseFirestore.Query = carRunsCol().where(
    "owner_uid",
    "==",
    session.uid
  );
  if (sourceId) q = q.where("source_id", "==", sourceId);
  q = q.limit(FETCH_CAP);

  const snap = await q.get();
  const runs = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
    .sort((a, b) => millis(b.started_at) - millis(a.started_at))
    .slice(0, limit);
  return NextResponse.json({ runs });
}
