import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { isOwnJob } from "@/lib/jobs";
import { runPythonJson } from "@/lib/localRunner";

/**
 * POST /api/projects/[id]/results/collect — refresh the job's results from
 * what its runs have found so far, without running anything
 * (`job_results.py --collect`: gather, score relevance, save into the job's
 * databases). → counts per status
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/projects/[id]/results/collect">) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await isOwnJob(id, session.uid))) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const out = (await runPythonJson(["job_results.py", "--collect"], { project: id }, 600_000)) as {
      error?: string;
    };
    if (out.error) return NextResponse.json({ error: out.error }, { status: 400 });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: `Couldn't refresh: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
