import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { isOwnJob } from "@/lib/jobs";
import { runPythonJson } from "@/lib/localRunner";

/**
 * POST /api/projects/[id]/relevance — score the job's results again against
 * its relevance rules (`relevance.py`; borderline ones by AI when the job
 * allows it, within its spend cap). → {scored, changed, ai_checked, cost_usd, errors}
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/projects/[id]/relevance">) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await isOwnJob(id, session.uid))) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const out = (await runPythonJson(["relevance.py"], { project: id }, 600_000)) as { error?: string };
    if (out.error) return NextResponse.json({ error: out.error }, { status: 400 });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: `Couldn't score: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
