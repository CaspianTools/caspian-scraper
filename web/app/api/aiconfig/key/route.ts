import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import { AiKeyWriteSchema } from "@/lib/firestore/schema";
import { aiconfigKeyDoc } from "@/lib/firestore/collections";

/**
 * The workspace's LLM provider key used by the AI scraper-config agent.
 *
 * Stored write-only in /aiconfig_keys/{uid} (encrypted at rest by GCP), read
 * ONLY by the aiconfig Actions job (service account) at run time. It is never
 * returned to clients — GET reports only whether one is set plus a masked hint.
 * The collection has no client Firestore rules (default deny); all access goes
 * through this admin-SDK route.
 *
 * SUPER ADMIN ONLY. This is the one thing an admin can't touch: it's the key
 * that gets billed, so replacing or deleting it stays with the workspace owner.
 *
 * The doc is keyed by `session.uid` — the *workspace* uid, not the actor's.
 * That is load-bearing: aiconfig/cli.py looks the key up by the `owner_uid`
 * stamped on the job, so a key stored under any other uid would be missed and
 * the agent would silently fall back to the shared org key.
 */

const NOT_OWNER =
  "only the workspace owner can manage the AI provider key";

function maskKey(value: string): string {
  // Reveal at most the last 4 chars, and only for a comfortably long key, so a
  // short secret is never mostly exposed by the hint.
  const v = String(value || "");
  if (v.length <= 12) return "••••";
  return `••••${v.slice(-4)}`;
}

/** GET — is a key configured? Returns a masked hint, never the value. */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!session.isSuperAdmin) {
    return NextResponse.json({ error: NOT_OWNER }, { status: 403 });
  }
  const snap = await aiconfigKeyDoc(session.uid).get();
  if (!snap.exists || !snap.data()?.value) {
    return NextResponse.json({ configured: false });
  }
  const data = snap.data()!;
  return NextResponse.json({
    configured: true,
    provider: data.provider ?? "anthropic",
    model: data.model ?? "",
    base_url: data.base_url ?? "",
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
  if (!session.isSuperAdmin) {
    return NextResponse.json({ error: NOT_OWNER }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = AiKeyWriteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid key", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const value = parsed.data.value.trim();
  if (value.length < 8) {
    return NextResponse.json(
      { error: "that key looks too short", details: [{ path: ["value"], message: "too short" }] },
      { status: 400 }
    );
  }

  const ref = aiconfigKeyDoc(session.uid);
  const existing = await ref.get();
  const now = FieldValue.serverTimestamp();
  await ref.set(
    {
      provider: parsed.data.provider,
      model: parsed.data.model.trim(),
      base_url: parsed.data.base_url.trim(),
      value,
      created_at: existing.exists ? existing.data()?.created_at : now,
      updated_at: now,
    },
    { merge: false }
  );
  return NextResponse.json({
    configured: true,
    provider: parsed.data.provider,
    model: parsed.data.model.trim(),
    base_url: parsed.data.base_url.trim(),
    hint: maskKey(value),
  });
}

/** DELETE — remove the caller's key. */
export async function DELETE(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!session.isSuperAdmin) {
    return NextResponse.json({ error: NOT_OWNER }, { status: 403 });
  }
  await aiconfigKeyDoc(session.uid).delete();
  return NextResponse.json({ ok: true });
}
