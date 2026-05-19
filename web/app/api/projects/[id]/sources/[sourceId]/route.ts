import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  SourcePatchSchema,
  isValidKindAts,
  type AtsType,
  type ItemKind,
} from "@/lib/firestore/schema";
import { projectDoc, sourcesCol } from "@/lib/firestore/collections";

async function checkProjectOwner(
  projectId: string,
  uid: string
): Promise<boolean> {
  const snap = await projectDoc(projectId).get();
  return snap.exists && snap.data()?.owner_uid === uid;
}

/**
 * GET /api/projects/[id]/sources/[sourceId]
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/sources/[sourceId]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id, sourceId } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const snap = await sourcesCol(id).doc(sourceId).get();
  if (!snap.exists) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ id: snap.id, ...snap.data() });
}

/**
 * PATCH /api/projects/[id]/sources/[sourceId]
 */
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/sources/[sourceId]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id, sourceId } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = SourcePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid patch", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const ref = sourcesCol(id).doc(sourceId);
  const existing = await ref.get();
  if (!existing.exists) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Validate the (item_kind, ats) combo against the merged result. Either
  // field may be in the patch; missing fields fall back to the existing doc.
  const existingData = existing.data() ?? {};
  const mergedKind: ItemKind =
    (parsed.data.item_kind as ItemKind | undefined) ??
    ((existingData.item_kind as ItemKind | undefined) ?? "job");
  const mergedAts: AtsType =
    (parsed.data.ats as AtsType | undefined) ??
    (existingData.ats as AtsType);
  if (mergedAts && !isValidKindAts(mergedKind, mergedAts)) {
    return NextResponse.json(
      {
        error: "invalid patch",
        details: [
          {
            path: ["ats"],
            message: `ats '${mergedAts}' is not valid for item_kind '${mergedKind}'`,
          },
        ],
      },
      { status: 400 }
    );
  }

  await ref.update({
    ...parsed.data,
    updated_at: FieldValue.serverTimestamp(),
  });

  const fresh = await ref.get();
  return NextResponse.json({ id: fresh.id, ...fresh.data() });
}

/**
 * DELETE /api/projects/[id]/sources/[sourceId]
 */
export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/sources/[sourceId]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id, sourceId } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await sourcesCol(id).doc(sourceId).delete();
  return NextResponse.json({ ok: true });
}
