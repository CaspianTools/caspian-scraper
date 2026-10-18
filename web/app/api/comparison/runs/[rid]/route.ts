import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { comparisonRunsCol } from "@/lib/firestore/collections";

/**
 * GET /api/comparison/runs/[rid]
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/comparison/runs/[rid]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { rid } = await ctx.params;
  const snap = await comparisonRunsCol().doc(rid).get();
  if (!snap.exists || snap.data()?.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ id: snap.id, ...snap.data() });
}
