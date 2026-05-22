import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import { ComparisonSourcePatchSchema } from "@/lib/firestore/schema";
import { comparisonSourcesCol } from "@/lib/firestore/collections";

async function loadOwned(
  sid: string,
  uid: string
): Promise<FirebaseFirestore.DocumentData | null> {
  const snap = await comparisonSourcesCol().doc(sid).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || data.owner_uid !== uid) return null;
  return data;
}

/**
 * GET /api/comparison/sources/[sid]
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/comparison/sources/[sid]">
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

/**
 * PATCH /api/comparison/sources/[sid]
 *
 * Partial update. retailer_id is mutable but enforces the per-owner
 * uniqueness invariant.
 */
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/comparison/sources/[sid]">
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

  const parsed = ComparisonSourcePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid patch", details: parsed.error.issues },
      { status: 400 }
    );
  }

  if (
    parsed.data.retailer_id &&
    parsed.data.retailer_id !== existing.retailer_id
  ) {
    const clashSnap = await comparisonSourcesCol()
      .where("owner_uid", "==", session.uid)
      .where("retailer_id", "==", parsed.data.retailer_id)
      .limit(1)
      .get();
    if (!clashSnap.empty) {
      return NextResponse.json(
        {
          error: "invalid patch",
          details: [
            {
              path: ["retailer_id"],
              message: `retailer_id '${parsed.data.retailer_id}' already used by another of your sources`,
            },
          ],
        },
        { status: 400 }
      );
    }
  }

  await comparisonSourcesCol()
    .doc(sid)
    .update({
      ...parsed.data,
      updated_at: FieldValue.serverTimestamp(),
    });

  const fresh = await comparisonSourcesCol().doc(sid).get();
  return NextResponse.json({ id: fresh.id, ...fresh.data() });
}

/**
 * DELETE /api/comparison/sources/[sid]
 *
 * Deletes the source. Existing listings and canonicals are left intact
 * (price history stays useful) — only the source's future scrapes stop.
 */
export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/comparison/sources/[sid]">
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
  await comparisonSourcesCol().doc(sid).delete();
  return NextResponse.json({ ok: true });
}
