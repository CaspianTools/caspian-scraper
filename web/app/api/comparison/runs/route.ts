import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { comparisonRunsCol } from "@/lib/firestore/collections";
import type { Query } from "@/lib/localdb";
import { pricesJobScope } from "../jobScope";

/**
 * GET /api/comparison/runs
 *
 * Recent runs for the signed-in user, newest first.
 *
 *   ?project_id=<id>  only runs of that prices job's sources
 *   ?source_id=<sid>   filter to one source
 *   ?limit=<n>         default 50, capped at 200
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get("project_id");
  const sourceId = url.searchParams.get("source_id");
  const limitRaw = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 50 : limitRaw), 200);

  let q: Query = comparisonRunsCol().where(
    "owner_uid",
    "==",
    session.uid
  );
  if (sourceId) q = q.where("source_id", "==", sourceId);
  q = q.orderBy("started_at", "desc");
  // Job filter runs in JS after the owner query, so apply the limit last.
  if (!projectId) q = q.limit(limit);
  const scope = projectId ? await pricesJobScope(session.uid, projectId) : null;

  const snap = await q.get();
  const runs = snap.docs
    .filter((d) => !scope || scope.hasRun(d.data()))
    .slice(0, limit)
    .map((d) => ({ id: d.id, ...d.data() }));
  return NextResponse.json({ runs });
}
