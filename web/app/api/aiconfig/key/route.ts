import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import { SecretWriteSchema } from "@/lib/firestore/schema";
import { aiconfigKeyDoc } from "@/lib/firestore/collections";

/**
 * Per-user Anthropic API key used by the AI scraper-config agent.
 *
 * Stored write-only in /aiconfig_keys/{uid} (encrypted at rest by GCP), read
 * ONLY by the aiconfig Actions job (service account) at run time. It is never
 * returned to clients — GET reports only whether one is set plus a masked hint.
 * The collection has no client Firestore rules (default deny); all access goes
 * through this admin-SDK route, which enforces owner == session.uid.
 */

function maskKey(value: string): string {
  const v = String(value || "");
  if (v.length <= 8) return "••••";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/** GET — is a key configured? Returns a masked hint, never the value. */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const snap = await aiconfigKeyDoc(session.uid).get();
  if (!snap.exists || !snap.data()?.value) {
    return NextResponse.json({ configured: false });
  }
  const data = snap.data()!;
  return NextResponse.json({
    configured: true,
    hint: maskKey(String(data.value)),
    updated_at: data.updated_at ?? null,
  });
}

/** PUT — set or replace the caller's key. */
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
  const parsed = SecretWriteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid key", details: parsed.error.issues },
      { status: 400 }
    );
  }
  // Light sanity check so obvious mistakes fail fast (Anthropic keys are long
  // and start with "sk-"); not authoritative — the agent is the real check.
  const value = parsed.data.value.trim();
  if (!value.startsWith("sk-") || value.length < 20) {
    return NextResponse.json(
      { error: "that does not look like an Anthropic API key (expected 'sk-...')" },
      { status: 400 }
    );
  }

  const ref = aiconfigKeyDoc(session.uid);
  const existing = await ref.get();
  const now = FieldValue.serverTimestamp();
  await ref.set(
    {
      value,
      created_at: existing.exists ? existing.data()?.created_at : now,
      updated_at: now,
    },
    { merge: false }
  );
  return NextResponse.json({ configured: true, hint: maskKey(value) });
}

/** DELETE — remove the caller's key. */
export async function DELETE(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  await aiconfigKeyDoc(session.uid).delete();
  return NextResponse.json({ ok: true });
}
