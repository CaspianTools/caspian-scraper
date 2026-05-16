import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  ProjectCreateSchema,
  ProjectDocSchema,
  type ProjectDoc,
} from "@/lib/firestore/schema";
import {
  makeSlug,
  projectsCol,
  projectDoc,
} from "@/lib/firestore/collections";
import { canCreateProject } from "@/lib/firestore/quotas";

/**
 * GET /api/projects
 *
 * List the signed-in user's projects, newest first.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const snap = await projectsCol()
    .where("owner_uid", "==", session.uid)
    .orderBy("created_at", "desc")
    .limit(100)
    .get();

  const projects = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ projects });
}

/**
 * POST /api/projects
 *
 * Create a project owned by the signed-in user.
 */
export async function POST(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Quota check first — fail fast.
  const quota = await canCreateProject(session.uid);
  if (!quota.ok) {
    return NextResponse.json(
      {
        error: "project quota exceeded",
        used: quota.used,
        max: quota.max,
      },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = ProjectCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid project", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const input = parsed.data;

  // Build a unique doc ID from the slug. If the user's chosen name slugs
  // to something already taken, append a short suffix until it's unique.
  let baseSlug = makeSlug(input.name);
  let projectId = baseSlug;
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await projectDoc(projectId).get();
    if (!existing.exists) break;
    projectId = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  const now = new Date().toISOString();
  const doc: ProjectDoc = {
    owner_uid: session.uid,
    slug: projectId,
    name: input.name,
    description: input.description,
    schedule_cron: input.schedule_cron,
    enabled: input.enabled,
    hse_keywords: input.hse_keywords,
    last_run_at: null,
    created_at: now,
    updated_at: now,
  };

  // Final schema validation before write (defence in depth).
  const writeParsed = ProjectDocSchema.safeParse(doc);
  if (!writeParsed.success) {
    return NextResponse.json(
      { error: "internal validation failed", details: writeParsed.error.issues },
      { status: 500 }
    );
  }

  await projectDoc(projectId).create({
    ...writeParsed.data,
    // Use server time for created_at so it's authoritative.
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ id: projectId, ...writeParsed.data }, { status: 201 });
}
