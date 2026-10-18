import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  ConfigJobCreateSchema,
  ConfigJobDocSchema,
  type ConfigJobDoc,
} from "@/lib/firestore/schema";
import { configJobsCol } from "@/lib/firestore/collections";
import { dispatchAiconfigWorkflow } from "@/lib/github/dispatch";

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
 * GET /api/aiconfig/jobs — the signed-in user's recent config jobs,
 * newest first. Equality-only query + in-memory sort so no composite
 * index is required.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const snap = await configJobsCol()
    .where("owner_uid", "==", session.uid)
    .get();
  const jobs = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
    .sort((a, b) => millis(b.created_at) - millis(a.created_at));
  return NextResponse.json({ jobs });
}

/**
 * POST /api/aiconfig/jobs
 *
 * Create a config job owned by the signed-in user (status:"queued",
 * empty transcript) and fire the aiconfig workflow so the Python agent
 * picks it up. Dispatch is fire-and-forget — the cron/manual dispatch is
 * the fallback.
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

  const parsed = ConfigJobCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid job", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const doc: ConfigJobDoc = {
    ...parsed.data,
    owner_uid: session.uid,
    status: "queued",
    path: null,
    turns: [],
    proposed_config: null,
    sample_records: [],
    diagnostics: {},
    adapter: null,
    created_at: now,
    updated_at: now,
    dispatched_at: null,
    finished_at: null,
    error: "",
  };

  const writeParsed = ConfigJobDocSchema.safeParse(doc);
  if (!writeParsed.success) {
    return NextResponse.json(
      { error: "internal validation failed", details: writeParsed.error.issues },
      { status: 500 }
    );
  }

  const ref = await configJobsCol().add({
    ...writeParsed.data,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  // Start the runner. Unlike scrape-due, aiconfig.yml has NO cron fallback — it
  // only runs via this dispatch — so if we can't dispatch, the job would sit at
  // "queued" forever. Fail it with an actionable message instead.
  const dispatch = await dispatchAiconfigWorkflow({ jobId: ref.id });
  let status = writeParsed.data.status;
  if (dispatch.attempted && dispatch.ok) {
    await ref.update({
      dispatched_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });
  } else {
    status = "failed";
    const error = !dispatch.attempted
      ? "The AI agent couldn't be started: automatic dispatch isn't configured " +
        "(GH_DISPATCH_TOKEN is unset). An admin can set that token, or run the " +
        "'aiconfig' GitHub Actions workflow manually with this job id."
      : `The AI agent couldn't be started (GitHub dispatch failed: ${dispatch.status ?? ""} ${dispatch.error ?? ""}).`;
    await ref.update({
      status,
      error,
      finished_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });
    return NextResponse.json(
      { id: ref.id, ...writeParsed.data, status, error },
      { status: 201 }
    );
  }

  return NextResponse.json(
    { id: ref.id, ...writeParsed.data, status },
    { status: 201 }
  );
}
