import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "@/lib/localdb";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  ProjectCreateRequestSchema,
  ProjectDocSchema,
  type ProjectDoc,
} from "@/lib/firestore/schema";
import {
  destinationsCol,
  makeSlug,
  projectsCol,
  projectDoc,
  secretsCol,
} from "@/lib/firestore/collections";
import { canCreateProject } from "@/lib/firestore/quotas";
import { invalidResourceIds } from "@/lib/firestore/resources";

// Static routes under /projects that a project id must never shadow.
const RESERVED_IDS = new Set(["new"]);

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
 * Create a project owned by the signed-in user. Optional extras:
 *   resource_ids            shared /resources to attach (must be the user's)
 *   copy_destinations_from  another of the user's projects whose
 *                           destinations + referenced secrets are copied in
 * Everything is written in one batch, so a failed create leaves nothing.
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

  const parsed = ProjectCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid project", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const input = parsed.data;

  const badResources = await invalidResourceIds(session.uid, input.resource_ids);
  if (badResources.length > 0) {
    return NextResponse.json(
      {
        error: "unknown resources",
        details: [
          {
            path: ["resource_ids"],
            message: `not found: ${badResources.join(", ")}`,
          },
        ],
      },
      { status: 400 }
    );
  }

  let copyFrom: string | null = null;
  if (input.copy_destinations_from) {
    const src = await projectDoc(input.copy_destinations_from).get();
    if (!src.exists || src.get("owner_uid") !== session.uid) {
      return NextResponse.json(
        { error: "unknown job to copy destinations from" },
        { status: 400 }
      );
    }
    copyFrom = src.id;
  }

  // Build a unique doc ID from the slug. If the user's chosen name slugs
  // to something already taken, append a short suffix until it's unique.
  const baseSlug = makeSlug(input.name);
  let projectId = baseSlug;
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await projectDoc(projectId).get();
    if (!existing.exists && !RESERVED_IDS.has(projectId)) break;
    projectId = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  const now = new Date().toISOString();
  const doc: ProjectDoc = {
    owner_uid: session.uid,
    slug: projectId,
    name: input.name,
    kind: input.kind,
    description: input.description,
    schedule_cron: input.schedule_cron,
    enabled: input.enabled,
    hse_keywords: input.hse_keywords,
    resource_ids: Array.from(new Set(input.resource_ids)),
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

  const batch = adminDb.batch();
  batch.create(projectDoc(projectId), {
    ...writeParsed.data,
    // Use server time for created_at so it's authoritative.
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  let copiedDestinations = 0;
  if (copyFrom) {
    const [dests, secrets] = await Promise.all([
      destinationsCol(copyFrom).get(),
      secretsCol(copyFrom).get(),
    ]);
    const needed = new Set(dests.docs.map((d) => String(d.get("secret_ref") ?? "")));
    for (const d of dests.docs) {
      batch.create(destinationsCol(projectId).doc(d.id), {
        ...d.data(),
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
    }
    for (const s of secrets.docs) {
      if (!needed.has(s.id)) continue;
      batch.create(secretsCol(projectId).doc(s.id), {
        value: s.get("value"),
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });
    }
    copiedDestinations = dests.size;
  }

  await batch.commit();

  return NextResponse.json(
    { id: projectId, ...writeParsed.data, copied_destinations: copiedDestinations },
    { status: 201 }
  );
}
