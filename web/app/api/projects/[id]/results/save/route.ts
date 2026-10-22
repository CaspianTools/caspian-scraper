import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromBearer } from "@/lib/auth/session";
import { isOwnJob } from "@/lib/jobs";
import { runPythonJson } from "@/lib/localRunner";

const SaveSchema = z.object({
  database: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
  ids: z.array(z.string().min(1).max(500)).min(1).max(5000),
});

/**
 * POST /api/projects/[id]/results/save — copy chosen results into a
 * database (`job_results.py --save`; the job's newer copy wins on content,
 * tags are merged). → {saved}
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/projects/[id]/results/save">) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await isOwnJob(id, session.uid))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = SaveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request", details: parsed.error.issues }, { status: 400 });
  }
  try {
    const out = (await runPythonJson(["job_results.py", "--save"], { project: id, ...parsed.data })) as {
      error?: string;
    };
    if (out.error) return NextResponse.json({ error: out.error }, { status: 400 });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: `Couldn't save: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
