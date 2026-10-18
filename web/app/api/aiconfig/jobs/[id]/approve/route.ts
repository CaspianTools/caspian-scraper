import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  GenericSourceCreateSchema,
  GenericSourceDocSchema,
  ConfigJobAdapterSchema,
  type GenericSourceDoc,
} from "@/lib/firestore/schema";
import {
  configJobsCol,
  genericSourcesCol,
} from "@/lib/firestore/collections";

/**
 * POST /api/aiconfig/jobs/[id]/approve
 *
 * Materialise a proposed config job into a real /generic_sources/{sid}
 * doc. Requires the job to be owned by the caller and in status
 * "proposed". The agent's `proposed_config` is re-validated with
 * GenericSourceCreateSchema before it's written.
 *
 *   path "config"   -> active:true; goes live on the next cron tick.
 *   path "adapter"  -> active:false; the generated Python adapter must be
 *                      merged first. The response carries the PR url so the
 *                      UI can link to it ("merge then activate").
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/aiconfig/jobs/[id]/approve">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;

  const snap = await configJobsCol().doc(id).get();
  if (!snap.exists || snap.data()?.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const job = snap.data()!;

  if (job.status !== "proposed") {
    return NextResponse.json(
      { error: `job is not ready to approve (status: ${job.status})` },
      { status: 409 }
    );
  }

  const configParsed = GenericSourceCreateSchema.safeParse(job.proposed_config);
  if (!configParsed.success) {
    return NextResponse.json(
      {
        error: "proposed config is invalid",
        details: configParsed.error.issues,
      },
      { status: 422 }
    );
  }

  // source_key must be unique per user (it's the record-uid prefix — collisions
  // would clash records across sources). The raw POST route enforces this; the
  // approve path must too, since slugify(intent) can repeat across wizard runs.
  const clashSnap = await genericSourcesCol()
    .where("owner_uid", "==", session.uid)
    .where("source_key", "==", configParsed.data.source_key)
    .limit(1)
    .get();
  if (!clashSnap.empty) {
    return NextResponse.json(
      {
        error: "source_key already in use",
        details: [
          {
            path: ["source_key"],
            message: `source_key '${configParsed.data.source_key}' already used by another of your sources`,
          },
        ],
      },
      { status: 409 }
    );
  }

  // Adapter-path sources reference a generated Python module that must be
  // merged to main before the source can run — created inactive.
  const isAdapter = job.path === "adapter";
  const active = !isAdapter;

  const now = new Date().toISOString();
  const doc: GenericSourceDoc = {
    ...configParsed.data,
    owner_uid: session.uid,
    created_at: now,
    updated_at: now,
    last_run_at: null,
    last_run_summary: null,
    origin: { via: "wizard", config_job_id: id },
  };
  // Override the proposed active flag: adapter-path sources stay inactive
  // until their generated Python module is merged to main.
  doc.active = active;

  const writeParsed = GenericSourceDocSchema.safeParse(doc);
  if (!writeParsed.success) {
    return NextResponse.json(
      { error: "internal validation failed", details: writeParsed.error.issues },
      { status: 500 }
    );
  }

  const ref = await genericSourcesCol().add({
    ...writeParsed.data,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  await configJobsCol().doc(id).update({
    status: "approved",
    updated_at: FieldValue.serverTimestamp(),
    finished_at: FieldValue.serverTimestamp(),
  });

  const adapter = ConfigJobAdapterSchema.safeParse(job.adapter);
  const pr_url = isAdapter && adapter.success ? adapter.data.pr_url : undefined;

  return NextResponse.json(
    {
      id: ref.id,
      ...writeParsed.data,
      ...(pr_url ? { adapter_pr_url: pr_url } : {}),
    },
    { status: 201 }
  );
}
