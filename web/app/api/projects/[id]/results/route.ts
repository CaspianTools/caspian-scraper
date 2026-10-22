import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { recordsPage } from "@/lib/databases";
import { isOwnJob } from "@/lib/jobs";
import { allRecords } from "@/lib/recordstore";

/**
 * GET /api/projects/[id]/results — one page of the job's results (every
 * engine's records, job_results.py), filtered and sorted on the server; the
 * same query and answer as /api/databases/[id]/records.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/projects/[id]/results">) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await isOwnJob(id, session.uid))) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(recordsPage(allRecords(`job:${id}`), "url", req.nextUrl.searchParams));
}
