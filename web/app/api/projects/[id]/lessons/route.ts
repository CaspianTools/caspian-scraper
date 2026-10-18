import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { projectDoc, lessonsCol } from "@/lib/firestore/collections";

async function checkProjectOwner(
  projectId: string,
  uid: string
): Promise<boolean> {
  const snap = await projectDoc(projectId).get();
  return snap.exists && snap.data()?.owner_uid === uid;
}

/**
 * GET /api/projects/[id]/lessons
 *
 * List lessons for a project, newest first. Optional query params:
 *   ?verdict=ok|errors|zero_found|no_new   filter by verdict
 *   ?source_id=<id>                        filter by source
 *   ?limit=<n>                             max rows (default 50, cap 200)
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/lessons">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const verdict = url.searchParams.get("verdict");
  const sourceId = url.searchParams.get("source_id");
  const limitRaw = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 50 : limitRaw), 200);

  let q: FirebaseFirestore.Query = lessonsCol(id);
  if (verdict) q = q.where("verdict", "==", verdict);
  if (sourceId) q = q.where("source_id", "==", sourceId);
  q = q.orderBy("ts", "desc").limit(limit);

  const snap = await q.get();
  const lessons = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ lessons });
}
