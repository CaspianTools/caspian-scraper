import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import { GenericSourcePatchSchema } from "@/lib/firestore/schema";
import { genericSourcesCol } from "@/lib/firestore/collections";

async function loadOwned(
  sid: string,
  uid: string
): Promise<FirebaseFirestore.DocumentData | null> {
  const snap = await genericSourcesCol().doc(sid).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || data.owner_uid !== uid) return null;
  return data;
}

/** GET /api/generic/sources/[sid] */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/generic/sources/[sid]">
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
 * PATCH /api/generic/sources/[sid] — partial update. source_key is
 * mutable but enforces the per-owner uniqueness invariant.
 */
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/generic/sources/[sid]">
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

  const parsed = GenericSourcePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid patch", details: parsed.error.issues },
      { status: 400 }
    );
  }

  if (parsed.data.source_key && parsed.data.source_key !== existing.source_key) {
    const clashSnap = await genericSourcesCol()
      .where("owner_uid", "==", session.uid)
      .where("source_key", "==", parsed.data.source_key)
      .limit(1)
      .get();
    if (!clashSnap.empty) {
      return NextResponse.json(
        {
          error: "invalid patch",
          details: [
            {
              path: ["source_key"],
              message: `source_key '${parsed.data.source_key}' already used by another of your sources`,
            },
          ],
        },
        { status: 400 }
      );
    }
  }

  await genericSourcesCol()
    .doc(sid)
    .update({
      ...parsed.data,
      updated_at: FieldValue.serverTimestamp(),
    });

  const fresh = await genericSourcesCol().doc(sid).get();
  return NextResponse.json({ id: fresh.id, ...fresh.data() });
}

/**
 * DELETE /api/generic/sources/[sid] — deletes the source. Existing
 * records are left intact (history stays useful); only future scrapes
 * stop.
 */
export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/generic/sources/[sid]">
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
  await genericSourcesCol().doc(sid).delete();
  return NextResponse.json({ ok: true });
}
