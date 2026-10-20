import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { FieldValue } from "@/lib/localdb";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionFromBearer } from "@/lib/auth/session";

/**
 * The Brave Search API key used by "Find websites" (find_websites.py).
 * Stored in /search_settings/<uid> — a local-data/ collection, so it stays on
 * this computer and is never committed. The value is never returned.
 */
const keyDoc = (uid: string) => adminDb.collection("search_settings").doc(uid);

const KeyWriteSchema = z.object({ value: z.string().trim().min(10).max(200) });

export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const snap = await keyDoc(session.uid).get();
  return NextResponse.json({ provider: "brave", set: snap.exists && !!snap.get("value") });
}

export async function PUT(req: NextRequest) {
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
  const parsed = KeyWriteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "That doesn't look like a Brave Search API key." },
      { status: 400 }
    );
  }
  await keyDoc(session.uid).set({
    provider: "brave",
    value: parsed.data.value,
    updated_at: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ provider: "brave", set: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  await keyDoc(session.uid).delete();
  return NextResponse.json({ provider: "brave", set: false });
}
