import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "@/lib/localdb";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionFromBearer } from "@/lib/auth/session";
import { ProjectPatchSchema } from "@/lib/firestore/schema";
import { projectDoc } from "@/lib/firestore/collections";
import { invalidResourceIds } from "@/lib/firestore/resources";

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

  // Zod 4's .partial() still fills .default() values for absent keys, so a
  // settings save of {name, ...} would otherwise reset hse_keywords and
  // resource_ids to []. Apply only the keys the client actually sent.
  const sent = new Set(Object.keys(body as object));
  const patch = Object.fromEntries(
    Object.entries(parsed.data).filter(([k]) => sent.has(k))
  ) as typeof parsed.data;
  if (patch.resource_ids) {
    patch.resource_ids = Array.from(new Set(patch.resource_ids));
    const bad = await invalidResourceIds(session.uid, patch.resource_ids);
    if (bad.length > 0) {
      return NextResponse.json(
        {
          error: "unknown resources",
          details: [
            { path: ["resource_ids"], message: `not found: ${bad.join(", ")}` },
          ],
        },
        { status: 400 }
      );
    }
  }

  await projectDoc(id).update({
    ...patch,
    updated_at: FieldValue.serverTimestamp(),
  });

  const fresh = await projectDoc(id).get();
  return NextResponse.json({ id: fresh.id, ...fresh.data() });
}

/**
 * DELETE /api/projects/[id]
 *
 * Removes the project doc AND every subcollection
 * (sources, destinations, secrets, runs, lessons, published) via
 * Firestore's recursiveDelete. Irreversible.
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
  const ref = projectDoc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // recursiveDelete walks all subcollections + their docs in batches.
  // For the scale we expect (≤50 sources, modest runs/lessons), this
  // is fine in a single request.
  await adminDb.recursiveDelete(ref);
  return NextResponse.json({ ok: true });
}
