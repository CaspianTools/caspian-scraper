import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { comparisonRunsCol } from "@/lib/firestore/collections";

/**
 * GET /api/comparison/runs
 *
 * Recent runs for the signed-in user, newest first.
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
  const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 50 : limitRaw), 200);

  let q: FirebaseFirestore.Query = comparisonRunsCol().where(
    "owner_uid",
    "==",
    session.uid
  );
  if (sourceId) q = q.where("source_id", "==", sourceId);
  q = q.orderBy("started_at", "desc").limit(limit);

  const snap = await q.get();
  const runs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ runs });
}
