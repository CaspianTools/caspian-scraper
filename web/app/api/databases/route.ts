import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { databaseDoc, makeSlug } from "@/lib/firestore/collections";
import { DatabaseCreateSchema, DatabaseIdSchema } from "@/lib/firestore/schema";
import { listDatabases } from "@/lib/databases";

/** GET /api/databases — the session's databases with record counts. */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return NextResponse.json({ databases: await listDatabases(session.uid) });
}

/**
 * POST /api/databases — create one: {name, description?, record_label?, key?}.
 * Its id is a slug of the name; records go to db/<id>.jsonl as jobs save.
 */
export async function POST(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = DatabaseCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid database", details: parsed.error.issues }, { status: 400 });
  }
  const base = makeSlug(parsed.data.name).slice(0, 50);
  let id = DatabaseIdSchema.safeParse(base).success ? base : `db-${Math.random().toString(36).slice(2, 8)}`;
  for (let i = 0; i < 5 && (await databaseDoc(id).get()).exists; i++) {
    id = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  const now = new Date().toISOString();
  await databaseDoc(id).set({ ...parsed.data, owner_uid: session.uid, created_at: now, updated_at: now });
  return NextResponse.json({ id }, { status: 201 });
}
