import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "@/lib/localdb";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  projectDoc,
  resourceDoc,
  sourcesCol,
} from "@/lib/firestore/collections";

// Each source costs 2 batch ops (create resource + delete source), plus one
// project update per chunk — well under Firestore's 500-op batch cap.
const CHUNK = 200;

/**
 * POST /api/projects/[id]/sources/promote
 *
 * Move every one of this job's own sources into the shared resource library
 * and attach them back to the job, so other jobs can reuse them. Doc ids are
 * kept (resources/{same id}), so lesson / published history that references
 * source_id still lines up. Each chunk is one atomic batch that creates the
 * resources, attaches them, and deletes the originals — a failure part-way
 * leaves every source either fully moved or untouched.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/sources/promote">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const project = await projectDoc(id).get();
  if (!project.exists || project.get("owner_uid") !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const sources = (await sourcesCol(id).get()).docs;
  if (sources.length === 0) {
    return NextResponse.json({ moved: 0, skipped: [] });
  }

  // A resource id that's already taken (vanishingly unlikely with auto-ids)
  // is left as a job-only source rather than overwritten.
  const existing = await adminDb.getAll(
    ...sources.map((s) => resourceDoc(s.id))
  );
  const taken = new Set(existing.filter((s) => s.exists).map((s) => s.id));
  const movable = sources.filter((s) => !taken.has(s.id));

  for (let i = 0; i < movable.length; i += CHUNK) {
    const chunk = movable.slice(i, i + CHUNK);
    const batch = adminDb.batch();
    for (const s of chunk) {
      batch.create(resourceDoc(s.id), {
        ...s.data(),
        owner_uid: session.uid,
        updated_at: FieldValue.serverTimestamp(),
      });
      batch.delete(s.ref);
    }
    batch.update(projectDoc(id), {
      resource_ids: FieldValue.arrayUnion(...chunk.map((s) => s.id)),
      updated_at: FieldValue.serverTimestamp(),
    });
    await batch.commit();
  }

  return NextResponse.json({
    moved: movable.length,
    skipped: Array.from(taken),
  });
}
