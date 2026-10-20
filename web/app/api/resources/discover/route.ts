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
 * "Find websites": careers-site suggestions from the built-in employer list,
 * companies in the chosen countries (Wikidata) and DuckDuckGo/Google searches
 * in a browser — free, no AI, no keys — each opened to check it works and to
 * detect its careers platform. Runs `find_websites.py --json`; nothing is
 * saved — the client adds the ones the
 * user picks via POST /api/resources. Usually takes about a minute.
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
    const result = await runPythonJson(["find_websites.py", "--json"], {
      ...parsed.data,
      owner_uid: session.uid,
      exclude_urls: library.map((r) => r.careers_url),
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: `search failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
