import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { databaseDoc } from "@/lib/firestore/collections";
import { DatabasePatchSchema } from "@/lib/firestore/schema";
import { getDatabase } from "@/lib/databases";
import { databaseFile } from "@/lib/recordstore";

/** The Companies database feeds Find websites; it can't be deleted. */
const PROTECTED = new Set(["companies"]);

export async function GET(req: NextRequest, ctx: RouteContext<"/api/databases/[id]">) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const db = await getDatabase(session.uid, id);
  if (!db) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(db);
}

/** PATCH — rename / describe / relabel (the key can't change). */
export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/databases/[id]">) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await getDatabase(session.uid, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = DatabasePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid database", details: parsed.error.issues }, { status: 400 });
  }
  await databaseDoc(id).update({ ...parsed.data, updated_at: new Date().toISOString() });
  return NextResponse.json({ ok: true });
}

/** DELETE — the database's config and its committed records file. */
export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/databases/[id]">) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (PROTECTED.has(id)) {
    return NextResponse.json(
      { error: "The Companies database is used by Find websites and can't be deleted." },
      { status: 400 }
    );
  }
  if (!(await getDatabase(session.uid, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  await databaseDoc(id).delete();
  fs.rmSync(databaseFile(id), { force: true });
  return NextResponse.json({ ok: true });
}
