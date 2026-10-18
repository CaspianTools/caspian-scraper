import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  CarSourceCreateSchema,
  CarSourceDocSchema,
  type CarSourceDoc,
} from "@/lib/firestore/schema";
import { carSourcesCol } from "@/lib/firestore/collections";

/** Millis from a Firestore Timestamp, ISO string, or 0. */
function millis(v: unknown): number {
  if (v && typeof (v as { toMillis?: () => number }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

/**
 * GET /api/cars/sources — the signed-in user's car sources, newest first.
 * Equality-only query + in-memory sort so no composite index is required.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const snap = await carSourcesCol()
    .where("owner_uid", "==", session.uid)
    .get();
  const sources = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
    .sort((a, b) => millis(b.created_at) - millis(a.created_at));
  return NextResponse.json({ sources });
}

/**
 * POST /api/cars/sources — create a car source owned by the signed-in user.
 * No extraction config: the site adapter (OpenSooq/…) is purpose-built.
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

  const parsed = CarSourceCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid source", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const doc: CarSourceDoc = {
    ...parsed.data,
    owner_uid: session.uid,
    created_at: now,
    updated_at: now,
    last_run_at: null,
    last_run_summary: null,
  };

  const writeParsed = CarSourceDocSchema.safeParse(doc);
  if (!writeParsed.success) {
    return NextResponse.json(
      { error: "internal validation failed", details: writeParsed.error.issues },
      { status: 500 }
    );
  }

  const ref = await carSourcesCol().add({
    ...writeParsed.data,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ id: ref.id, ...writeParsed.data }, { status: 201 });
}
