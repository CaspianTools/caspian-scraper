import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import { ProjectPatchSchema } from "@/lib/firestore/schema";
import { projectDoc } from "@/lib/firestore/collections";

/**
 * GET /api/projects/[id]
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const snap = await projectDoc(id).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const data = snap.data();
  if (data?.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ id: snap.id, ...data });
}

/**
 * PATCH /api/projects/[id]
 */
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const snap = await projectDoc(id).get();
  if (!snap.exists || snap.data()?.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = ProjectPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid patch", details: parsed.error.issues },
      { status: 400 }
    );
  }

  await projectDoc(id).update({
    ...parsed.data,
    updated_at: FieldValue.serverTimestamp(),
  });

  const fresh = await projectDoc(id).get();
  return NextResponse.json({ id: fresh.id, ...fresh.data() });
}

/**
 * DELETE /api/projects/[id]
 *
 * Soft-delete preview: for now we hard-delete the project doc only.
 * Subcollections (sources, runs, lessons, …) are left as orphans — a
 * follow-up commit will add proper cascading via a Cloud Function or
 * recursive batched delete in the API route.
 */
export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const snap = await projectDoc(id).get();
  if (!snap.exists || snap.data()?.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  await projectDoc(id).delete();
  return NextResponse.json({ ok: true });
}
