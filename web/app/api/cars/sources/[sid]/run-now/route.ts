import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "@/lib/localdb";
import { getSessionFromBearer } from "@/lib/auth/session";
import { carSourcesCol, runRequestsCol } from "@/lib/firestore/collections";
import { startScrape } from "@/lib/localRunner";

/**
 * POST /api/cars/sources/[sid]/run-now
 *
 * Record a run-request for this car source and start the scraper on this
 * computer for it (lib/localRunner.ts → run_car_source).
 * Mirrors /api/comparison/sources/[sid]/run-now.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/cars/sources/[sid]/run-now">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { sid } = await ctx.params;

  const srcSnap = await carSourcesCol().doc(sid).get();
  if (!srcSnap.exists || srcSnap.data()?.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const ref = await runRequestsCol().add({
    project_id: "",
    comparison_source_id: "",
    car_source_id: sid,
    requested_by_uid: session.uid,
    status: "pending",
    created_at: FieldValue.serverTimestamp(),
    picked_up_at: null,
    finished_at: null,
    run_id: "",
  });
  const run = startScrape({ carSourceId: sid, requestId: ref.id });
  return NextResponse.json(
    { id: ref.id, status: "pending", started: run.ok === true, error: run.error },
    { status: 201 }
  );
}
