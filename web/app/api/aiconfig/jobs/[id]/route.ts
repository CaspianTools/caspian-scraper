import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { configJobsCol } from "@/lib/firestore/collections";

/**
 * GET /api/aiconfig/jobs/[id] — a single config job, owner-guarded.
 * The wizard mostly reads the doc live via onSnapshot; this route exists
 * for server-side reads / non-realtime polling.
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/aiconfig/jobs/[id]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;

  const snap = await configJobsCol().doc(id).get();
  if (!snap.exists || snap.data()?.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ id: snap.id, ...snap.data() });
}
