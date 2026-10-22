import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromBearer } from "@/lib/auth/session";
import { runPythonJson } from "@/lib/localRunner";
import { DatabaseIdSchema } from "@/lib/firestore/schema";

const Rule = z.object({
  tag: z.string().trim().min(1).max(40),
  criteria: z.string().trim().min(1).max(500),
});
const AiTagSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("plan"),
    criteria: z.string().trim().min(1).max(4000),
    database: DatabaseIdSchema.default("companies"),
  }),
  z.object({
    mode: z.literal("apply"),
    rules: z.array(Rule).min(1).max(12),
    ids: z.array(z.string().min(1).max(253)).min(1).max(200),
    replace: z.boolean().default(false),
    database: DatabaseIdSchema.default("companies"),
  }),
]);

/**
 * POST /api/resources/ai-tag
 *
 * AI tagging of the findings database (`ai_tag.py`), on the provider + key
 * from Settings:
 *   {mode: "plan", criteria}            → {rules: [{tag, criteria}], note, cost_usd}
 *   {mode: "apply", rules, ids, replace} → {tags: {id: [tags]}, counts, tagged,
 *                                          checked, skipped, errors, cost_usd}
 * The app sends apply in chunks of ids to show progress.
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
  const parsed = AiTagSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { mode, ...input } = parsed.data;
  try {
    const out = (await runPythonJson(["ai_tag.py", `--${mode}`], input, 600_000)) as { error?: string };
    if (out.error) return NextResponse.json({ error: out.error }, { status: 422 });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json(
      { error: `AI tagging failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
