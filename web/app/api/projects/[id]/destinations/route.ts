import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  DestinationCreateSchema,
  DestinationDocSchema,
  type DestinationDoc,
} from "@/lib/firestore/schema";
import {
  projectDoc,
  destinationsCol,
} from "@/lib/firestore/collections";

async function checkProjectOwner(
  projectId: string,
  uid: string
): Promise<boolean> {
  const snap = await projectDoc(projectId).get();
  return snap.exists && snap.data()?.owner_uid === uid;
}

/**
 * GET /api/projects/[id]/destinations
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/destinations">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const snap = await destinationsCol(id).orderBy("created_at", "desc").get();
  const destinations = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ destinations });
}

/**
 * POST /api/projects/[id]/destinations
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/destinations">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = DestinationCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid destination", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const doc: DestinationDoc = {
    ...parsed.data,
    created_at: now,
    updated_at: now,
  };
  const writeParsed = DestinationDocSchema.safeParse(doc);
  if (!writeParsed.success) {
    return NextResponse.json(
      { error: "internal validation failed", details: writeParsed.error.issues },
      { status: 500 }
    );
  }

  const ref = await destinationsCol(id).add({
    ...writeParsed.data,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  return NextResponse.json(
    { id: ref.id, ...writeParsed.data },
    { status: 201 }
  );
}
