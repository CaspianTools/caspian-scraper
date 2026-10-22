import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "@/lib/localdb";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  ConfigJobCreateSchema,
  ConfigJobDocSchema,
  type ConfigJobDoc,
} from "@/lib/firestore/schema";
import { configJobsCol } from "@/lib/firestore/collections";
import { startAiconfig } from "@/lib/localRunner";
import { isOwnedDataJob } from "@/app/api/generic/dataJob";

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
 * newest first; `?project_id=` keeps one job's. Equality-only query +
 * in-memory sort so no composite index is required.
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const snap = await configJobsCol()
    .where("owner_uid", "==", session.uid)
    .get();
  const projectId = req.nextUrl.searchParams.get("project_id");
  const jobs = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
    .filter((j) => !projectId || j.project_id === projectId)
    .sort((a, b) => millis(b.created_at) - millis(a.created_at));
  return NextResponse.json({ jobs });
}

/**
 * POST /api/aiconfig/jobs
 *
 * Create a config job owned by the signed-in user (status:"queued",
 * empty transcript) for one of their "Website data" jobs (`project_id` —
 * the approved source joins it) and start the Python agent on this
 * computer for it.
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
  if (!(await isOwnedDataJob(parsed.data.project_id, session.uid))) {
    return NextResponse.json(
      {
        error: "invalid job",
        details: [{ path: ["project_id"], message: "not one of your Website data jobs" }],
      },
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

  // Start the runner on this computer. Nothing else would ever pick the job
  // up, so if it can't start the job would sit at "queued" forever — fail it
  // with an actionable message instead.
  const dispatch = startAiconfig(ref.id);
  let status = writeParsed.data.status;
  if (dispatch.attempted && dispatch.ok) {
    await ref.update({
      dispatched_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });
  } else {
    status = "failed";
    const error =
      `The AI agent couldn't be started on this computer (${dispatch.error ?? "unknown error"}). ` +
      "Check that the Python environment exists (.venv — Start.bat creates it).";
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
