import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import { SecretWriteSchema } from "@/lib/firestore/schema";
import { projectDoc, secretsCol } from "@/lib/firestore/collections";

async function checkProjectOwner(
  projectId: string,
  uid: string
): Promise<boolean> {
  const snap = await projectDoc(projectId).get();
  return snap.exists && snap.data()?.owner_uid === uid;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * PUT /api/projects/[id]/secrets/[name]
 *
 * Set or update a secret's value. The value is stored in Firestore
 * (encrypted at rest by GCP). It is never returned by GET endpoints.
 */
export async function PUT(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/secrets/[name]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id, name } = await ctx.params;
  if (!NAME_RE.test(name)) {
    return NextResponse.json(
      {
        error:
          "secret name must be 1-80 chars of letters / digits / underscore / dash",
      },
      { status: 400 }
    );
  }
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
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
      { error: "invalid secret", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const ref = secretsCol(id).doc(name);
  const existing = await ref.get();
  const now = FieldValue.serverTimestamp();
  await ref.set(
    {
      value: parsed.data.value,
      created_at: existing.exists ? existing.data()?.created_at : now,
      updated_at: now,
    },
    { merge: false }
  );

  return NextResponse.json({ name, updated: true });
}

/**
 * DELETE /api/projects/[id]/secrets/[name]
 */
export async function DELETE(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/secrets/[name]">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id, name } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await secretsCol(id).doc(name).delete();
  return NextResponse.json({ ok: true });
}
