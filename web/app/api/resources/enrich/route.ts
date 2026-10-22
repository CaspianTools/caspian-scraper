import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromBearer } from "@/lib/auth/session";
import { runPythonJson } from "@/lib/localRunner";
import { DatabaseIdSchema } from "@/lib/firestore/schema";

const EnrichSchema = z.object({
  database: DatabaseIdSchema.default("companies"),
  ids: z.array(z.string().min(1).max(253)).min(1).max(200),
});

/**
 * POST /api/resources/enrich
 *
 * Find + check careers pages for companies in the findings database
 * (db/companies.jsonl) by id (their website domain): `find_websites.py
 * --enrich`. Updates the database and returns the companies. Takes a few
 * seconds per company, several in parallel.
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
  const parsed = EnrichSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", details: parsed.error.issues },
      { status: 400 }
    );
  }
  try {
    const result = await runPythonJson(["find_websites.py", "--enrich"], parsed.data, 600_000);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: `careers-page lookup failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
