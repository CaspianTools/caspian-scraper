import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  genericSourcesCol,
  runRequestsCol,
} from "@/lib/firestore/collections";

/**
 * POST /api/generic/sources/[sid]/run-now
 *
 * Queue an ad-hoc run-request for this generic source. The Python
 * scraper's cron tick picks it up (find_due_work) and dispatches
 * run_generic_source. Mirrors /api/comparison/sources/[sid]/run-now.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/generic/sources/[sid]/run-now">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { sid } = await ctx.params;

  const srcSnap = await genericSourcesCol().doc(sid).get();
  const src = srcSnap.data();
  if (!srcSnap.exists || src?.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Adapter-strategy sources can't run until their generated Python module is
  // merged to main — queuing a run would just produce a guaranteed-error run.
  if (src?.strategy?.mode === "adapter") {
    return NextResponse.json(
      {
        error:
          "this source uses a generated adapter that must be merged to main before it can run",
      },
      { status: 409 }
    );
  }

  const ref = await runRequestsCol().add({
    project_id: "",
    comparison_source_id: "",
    car_source_id: "",
    generic_source_id: sid,
    requested_by_uid: session.uid,
    status: "pending",
    created_at: FieldValue.serverTimestamp(),
    picked_up_at: null,
    finished_at: null,
    run_id: "",
  });
  return NextResponse.json({ id: ref.id, status: "pending" }, { status: 201 });
}
