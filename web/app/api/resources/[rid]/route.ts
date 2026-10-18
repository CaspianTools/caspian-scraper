import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionFromBearer } from "@/lib/auth/session";
import { ResourcePatchSchema } from "@/lib/firestore/schema";
import { projectsCol, resourceDoc } from "@/lib/firestore/collections";

async function loadOwned(rid: string, uid: string) {
  const snap = await resourceDoc(rid).get();
  return snap.exists && snap.get("owner_uid") === uid ? snap : null;
}

/**
 * GET /api/resources/[rid]
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/resources/[rid]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { rid } = await ctx.params;
  const snap = await loadOwned(rid, session.uid);
  if (!snap) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ id: snap.id, ...snap.data() });
}

/**
 * PATCH /api/resources/[rid]
 *
 * Edits apply to every job that uses the resource.
 */
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/resources/[rid]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { rid } = await ctx.params;
  if (!(await loadOwned(rid, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = ResourcePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid patch", details: parsed.error.issues },
      { status: 400 }
    );
  }

  await resourceDoc(rid).update({
    ...parsed.data,
    updated_at: FieldValue.serverTimestamp(),
  });
  const fresh = await resourceDoc(rid).get();
  return NextResponse.json({ id: fresh.id, ...fresh.data() });
}

/**
 * DELETE /api/resources/[rid]
 *
 * Removes the resource and detaches it from every job that listed it, in
 * one batch so no job is left pointing at a missing doc.
 */
export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/resources/[rid]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { rid } = await ctx.params;
  if (!(await loadOwned(rid, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Filtered in memory: owner_uid == + array-contains would need a
  // composite index, and one workspace's job list is small.
  const projects = await projectsCol()
    .where("owner_uid", "==", session.uid)
    .select("resource_ids")
    .get();
  const users = projects.docs.filter((p) => {
    const ids = p.get("resource_ids");
    return Array.isArray(ids) && ids.includes(rid);
  });

  const batch = adminDb.batch();
  for (const p of users) {
    batch.update(p.ref, {
      resource_ids: FieldValue.arrayRemove(rid),
      updated_at: FieldValue.serverTimestamp(),
    });
  }
  batch.delete(resourceDoc(rid));
  await batch.commit();

  return NextResponse.json({ ok: true, detached_from: users.length });
}
