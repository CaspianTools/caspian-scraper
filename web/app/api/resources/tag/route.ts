import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromBearer } from "@/lib/auth/session";
import { runPythonJson } from "@/lib/localRunner";
import { DatabaseIdSchema } from "@/lib/firestore/schema";

const tag = z.string().trim().min(1).max(40);
const TagSchema = z
  .object({
    database: DatabaseIdSchema.default("companies"),
    ids: z.array(z.string().min(1).max(253)).min(1).max(2000),
    add: z.array(tag).max(20).default([]),
    remove: z.array(tag).max(200).default([]),
  })
  .refine((b) => b.add.length + b.remove.length > 0, { message: "nothing to add or remove" });

/**
 * POST /api/resources/tag
 *
 * Add and/or remove tags on records of a database (`database`, default
 * "companies" — db/<id>.jsonl): `find_websites.py --tag`. Tags match
 * case-insensitively. Returns {updated, tags: {id: [tags]}}.
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
  const parsed = TagSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", details: parsed.error.issues },
      { status: 400 }
    );
  }
  try {
    return NextResponse.json(await runPythonJson(["find_websites.py", "--tag"], parsed.data));
  } catch (e) {
    return NextResponse.json(
      { error: `couldn't update the findings database: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
