import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromBearer } from "@/lib/auth/session";
import { runPythonJson } from "@/lib/localRunner";
import { DatabaseIdSchema } from "@/lib/firestore/schema";

const MarkSchema = z.object({
  database: DatabaseIdSchema.default("companies"),
  ids: z.array(z.string().min(1).max(253)).min(1).max(2000),
  hidden: z.boolean(),
});

/**
 * POST /api/resources/mark
 *
 * Hide (or unhide) companies in the findings database — "not relevant", so
 * Find websites leaves them out by default: `find_websites.py --mark`.
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
  const parsed = MarkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", details: parsed.error.issues },
      { status: 400 }
    );
  }
  try {
    return NextResponse.json(await runPythonJson(["find_websites.py", "--mark"], parsed.data));
  } catch (e) {
    return NextResponse.json(
      { error: `couldn't update the findings database: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
