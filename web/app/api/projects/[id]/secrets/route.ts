import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { projectDoc, secretsCol } from "@/lib/firestore/collections";

async function checkProjectOwner(
  projectId: string,
  uid: string
): Promise<boolean> {
  const snap = await projectDoc(projectId).get();
  return snap.exists && snap.data()?.owner_uid === uid;
}

/**
 * GET /api/projects/[id]/secrets
 *
 * Returns the LIST OF SECRET NAMES only — never the values. The scraper
 * service account reads values via the Admin SDK at scrape time.
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/secrets">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const snap = await secretsCol(id).get();
  const secrets = snap.docs.map((d) => ({
    name: d.id,
    created_at: d.data().created_at,
    updated_at: d.data().updated_at,
  }));
  return NextResponse.json({ secrets });
}
