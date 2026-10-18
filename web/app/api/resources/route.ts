import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  ResourceCreateSchema,
  ResourceDocSchema,
  type ResourceDoc,
} from "@/lib/firestore/schema";
import { resourcesCol } from "@/lib/firestore/collections";
import { listResources } from "@/lib/firestore/resources";

/**
 * GET /api/resources
 *
 * The workspace's shared resource library, sorted by name, each with the
 * jobs that use it.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const resources = await listResources(session.uid);
  return NextResponse.json({ resources });
}

/**
 * POST /api/resources
 *
 * Add a website to the shared library. It isn't scraped until a job
 * attaches it (projects/{id}.resource_ids).
 */
export async function POST(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = ResourceCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid resource", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const doc: ResourceDoc = {
    ...parsed.data,
    owner_uid: session.uid,
    created_at: now,
    updated_at: now,
    last_run_summary: null,
  };

  const writeParsed = ResourceDocSchema.safeParse(doc);
  if (!writeParsed.success) {
    return NextResponse.json(
      { error: "internal validation failed", details: writeParsed.error.issues },
      { status: 500 }
    );
  }

  const ref = await resourcesCol().add({
    ...writeParsed.data,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ id: ref.id, ...writeParsed.data }, { status: 201 });
}
