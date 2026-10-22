import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromBearer } from "@/lib/auth/session";
import { runPythonJson } from "@/lib/localRunner";
import { DatabaseIdSchema } from "@/lib/firestore/schema";

const DeleteSchema = z.object({
  database: DatabaseIdSchema.default("companies"),
  ids: z.array(z.string().min(1).max(253)).min(1).max(2000),
});

/**
 * POST /api/resources/delete
 *
 * Delete records from a database (`database`, default "companies"):
 * `find_websites.py --delete`. Returns {deleted}.
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
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", details: parsed.error.issues },
      { status: 400 }
    );
  }
  try {
    return NextResponse.json(await runPythonJson(["find_websites.py", "--delete"], parsed.data));
  } catch (e) {
    return NextResponse.json(
      { error: `couldn't delete from the database: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
