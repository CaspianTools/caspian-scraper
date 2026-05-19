import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  SourceCreateSchema,
  SourceDocSchema,
  isValidKindAts,
  type SourceDoc,
} from "@/lib/firestore/schema";
import {
  projectDoc,
  sourcesCol,
} from "@/lib/firestore/collections";
import { canAddSource } from "@/lib/firestore/quotas";

async function checkProjectOwner(
  projectId: string,
  uid: string
): Promise<boolean> {
  const snap = await projectDoc(projectId).get();
  return snap.exists && snap.data()?.owner_uid === uid;
}

/**
 * GET /api/projects/[id]/sources
 *
 * List all sources for a project, newest first.
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/sources">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const snap = await sourcesCol(id).orderBy("created_at", "desc").get();
  const sources = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ sources });
}

/**
 * POST /api/projects/[id]/sources
 *
 * Add a new source to the project. Quota-gated.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/sources">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const quota = await canAddSource(session.uid, id);
  if (!quota.ok) {
    return NextResponse.json(
      {
        error: "source quota exceeded",
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

  const parsed = SourceCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid source", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const input = parsed.data;
  if (!isValidKindAts(input.item_kind, input.ats)) {
    return NextResponse.json(
      {
        error: "invalid source",
        details: [
          {
            path: ["ats"],
            message: `ats '${input.ats}' is not valid for item_kind '${input.item_kind}'`,
          },
        ],
      },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const doc: SourceDoc = {
    ...input,
    created_at: now,
    updated_at: now,
    last_run_summary: null,
  };

  const writeParsed = SourceDocSchema.safeParse(doc);
  if (!writeParsed.success) {
    return NextResponse.json(
      { error: "internal validation failed", details: writeParsed.error.issues },
      { status: 500 }
    );
  }

  const ref = await sourcesCol(id).add({
    ...writeParsed.data,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  return NextResponse.json(
    { id: ref.id, ...writeParsed.data },
    { status: 201 }
  );
}
