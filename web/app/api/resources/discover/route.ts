import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromBearer } from "@/lib/auth/session";
import { listResources } from "@/lib/firestore/resources";
import { runPythonJson } from "@/lib/localRunner";

const DiscoverSchema = z.object({
  query: z.string().max(500).default(""),
  countries: z.array(z.string().max(80)).max(20).default([]),
  use_web: z.boolean().default(true),
});

/**
 * POST /api/resources/discover
 *
 * "Find websites": careers-site suggestions from the built-in employer list
 * and (with an AI Setup key) the web, each fetched to check it opens and to
 * detect its careers platform. Runs `python -m aiconfig.discover`; nothing is
 * saved — the client adds the ones the user picks via POST /api/resources.
 * Can take up to a minute or two when web search is on.
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
  const parsed = DiscoverSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const library = await listResources(session.uid);
  try {
    const result = await runPythonJson(["-m", "aiconfig.discover"], {
      ...parsed.data,
      owner_uid: session.uid,
      exclude_urls: library.map((r) => r.careers_url),
      exclude_names: library.map((r) => r.name),
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: `search failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
