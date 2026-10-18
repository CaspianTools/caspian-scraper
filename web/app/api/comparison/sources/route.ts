import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  ComparisonSourceCreateSchema,
  ComparisonSourceDocSchema,
  type ComparisonSourceDoc,
} from "@/lib/firestore/schema";
import { comparisonSourcesCol } from "@/lib/firestore/collections";

/**
 * GET /api/comparison/sources
 *
 * List the signed-in user's comparison sources, newest first.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const snap = await comparisonSourcesCol()
    .where("owner_uid", "==", session.uid)
    .orderBy("created_at", "desc")
    .get();
  const sources = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ sources });
}

/**
 * POST /api/comparison/sources
 *
 * Create a comparison source owned by the signed-in user. retailer_id
 * must be unique per user — used as the column key in the side-by-side
 * comparison table.
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

  const parsed = ComparisonSourceCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid source", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const input = parsed.data;

  // retailer_id uniqueness per owner — prevents two sources clashing in
  // the comparison table column key.
  const clashSnap = await comparisonSourcesCol()
    .where("owner_uid", "==", session.uid)
    .where("retailer_id", "==", input.retailer_id)
    .limit(1)
    .get();
  if (!clashSnap.empty) {
    return NextResponse.json(
      {
        error: "invalid source",
        details: [
          {
            path: ["retailer_id"],
            message: `retailer_id '${input.retailer_id}' already used by another of your sources`,
          },
        ],
      },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const doc: ComparisonSourceDoc = {
    ...input,
    owner_uid: session.uid,
    created_at: now,
    updated_at: now,
    last_run_at: null,
    last_run_summary: null,
  };

  const writeParsed = ComparisonSourceDocSchema.safeParse(doc);
  if (!writeParsed.success) {
    return NextResponse.json(
      {
        error: "internal validation failed",
        details: writeParsed.error.issues,
      },
      { status: 500 }
    );
  }

  const ref = await comparisonSourcesCol().add({
    ...writeParsed.data,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  return NextResponse.json(
    { id: ref.id, ...writeParsed.data },
    { status: 201 }
  );
}
