import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { projectDoc, findingsCol } from "@/lib/firestore/collections";

async function checkProjectOwner(
  projectId: string,
  uid: string
): Promise<boolean> {
  const snap = await projectDoc(projectId).get();
  return snap.exists && snap.data()?.owner_uid === uid;
}

/**
 * GET /api/projects/[id]/findings
 *
 * List findings (per-role scrape outcomes) for a project, newest-seen
 * first. Optional query params:
 *   ?status=published|duplicate|failed
 *   ?source_id=<id>
 *   ?limit=<n>     default 100, capped at 500
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/findings">
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
  const status = url.searchParams.get("status");
  const sourceId = url.searchParams.get("source_id");
  const limitRaw = parseInt(url.searchParams.get("limit") || "100", 10);
  const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 100 : limitRaw), 500);

  let q: FirebaseFirestore.Query = findingsCol(id);
  if (status) q = q.where("status", "==", status);
  if (sourceId) q = q.where("source_id", "==", sourceId);
  q = q.orderBy("last_seen_at", "desc").limit(limit);

  const snap = await q.get();
  const findings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ findings });
}
