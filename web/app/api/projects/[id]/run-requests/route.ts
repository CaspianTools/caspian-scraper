import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "@/lib/localdb";
import { getSessionFromBearer } from "@/lib/auth/session";
import { projectDoc, runRequestsCol } from "@/lib/firestore/collections";
import { startScrape } from "@/lib/localRunner";

async function checkProjectOwner(
  projectId: string,
  uid: string
): Promise<boolean> {
  const snap = await projectDoc(projectId).get();
  return snap.exists && snap.data()?.owner_uid === uid;
}

/**
 * GET /api/projects/[id]/run-requests
 *
 * List recent run requests for this project. Used to surface a
 * "Pending request — will run on the next tick" banner in the Runs UI.
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/run-requests">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const snap = await runRequestsCol()
    .where("project_id", "==", id)
    .orderBy("created_at", "desc")
    .limit(20)
    .get();
  const requests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ requests });
}

/**
 * POST /api/projects/[id]/run-requests
 *
 * Queue an ad-hoc scrape. Writes a doc to /run_requests with
 * status=pending. The scraper workflow picks it up on its next tick
 * (every 15 min once Phase 3 ships) and updates the doc's status.
 *
 * Multi-tenant: writes the requesting user's uid into requested_by_uid
 * so the Firestore rule on /run_requests can scope reads to the owner.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/run-requests">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // If there's already a pending request for this project, return it
  // instead of creating a duplicate — and start a run for it, which kicks
  // a request whose earlier run never picked it up.
  const existing = await runRequestsCol()
    .where("project_id", "==", id)
    .where("requested_by_uid", "==", session.uid)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  if (!existing.empty) {
    const doc = existing.docs[0];
    const dispatch = startScrape({ projectId: id, requestId: doc.id });
    return NextResponse.json({
      id: doc.id,
      ...doc.data(),
      reused: true,
      dispatched: dispatch.attempted && dispatch.ok === true,
      dispatch_error:
        dispatch.attempted && !dispatch.ok ? dispatch.error : undefined,
    });
  }

  const ref = await runRequestsCol().add({
    project_id: id,
    requested_by_uid: session.uid,
    status: "pending",
    created_at: FieldValue.serverTimestamp(),
    picked_up_at: null,
    finished_at: null,
    run_id: "",
  });

  // Start the scraper on this computer right away. requestId is passed so
  // the run marks THIS /run_requests doc running → done at finish.
  const dispatch = startScrape({ projectId: id, requestId: ref.id });

  return NextResponse.json(
    {
      id: ref.id,
      status: "pending",
      dispatched: dispatch.attempted && dispatch.ok === true,
      dispatch_error:
        dispatch.attempted && !dispatch.ok ? dispatch.error : undefined,
    },
    { status: 201 }
  );
}
