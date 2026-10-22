import { NextRequest, NextResponse } from "next/server";
import { FieldValue, type DocumentData } from "@/lib/localdb";
import { getSessionFromBearer } from "@/lib/auth/session";
import { CarSourcePatchSchema } from "@/lib/firestore/schema";
import { carSourcesCol } from "@/lib/firestore/collections";

async function loadOwned(
  sid: string,
  uid: string
): Promise<DocumentData | null> {
  const snap = await carSourcesCol().doc(sid).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || data.owner_uid !== uid) return null;
  return data;
}

/** GET /api/cars/sources/[sid] */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/cars/sources/[sid]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { sid } = await ctx.params;
  const data = await loadOwned(sid, session.uid);
  if (!data) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ id: sid, ...data });
}

/** PATCH /api/cars/sources/[sid] — partial update. The owning job
 *  (`project_id`) can't be changed here. */
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/cars/sources/[sid]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { sid } = await ctx.params;
  const existing = await loadOwned(sid, session.uid);
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = CarSourcePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid patch", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const patch = { ...parsed.data };
  delete patch.project_id;
  await carSourcesCol()
    .doc(sid)
    .update({
      ...patch,
      updated_at: FieldValue.serverTimestamp(),
    });

  const fresh = await carSourcesCol().doc(sid).get();
  return NextResponse.json({ id: fresh.id, ...fresh.data() });
}

/**
 * DELETE /api/cars/sources/[sid] — deletes the source; its job's runs stop
 * scraping it. The listing docs stay in car_listings but no longer show in
 * the job (its pages list listings by the job's source ids).
 */
export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/cars/sources/[sid]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { sid } = await ctx.params;
  const existing = await loadOwned(sid, session.uid);
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await carSourcesCol().doc(sid).delete();
  return NextResponse.json({ ok: true });
}
