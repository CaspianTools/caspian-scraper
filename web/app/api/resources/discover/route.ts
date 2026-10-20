import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromBearer } from "@/lib/auth/session";
import { listResources } from "@/lib/firestore/resources";
import { runPythonJson } from "@/lib/localRunner";

const DiscoverSchema = z.object({
  query: z.string().max(500).default(""),
  countries: z.array(z.string().max(80)).max(20).default([]),
  use_web: z.boolean().default(true),
  /** Ignore the search cache and search afresh. */
  refresh: z.boolean().default(false),
  /** List the whole findings database instead of searching. */
  browse: z.boolean().default(false),
});

/**
 * POST /api/resources/discover
 *
 * "Find websites": companies from Google Maps, Google Search / DuckDuckGo,
 * Wikidata, OpenStreetMap and the findings database (db/), via
 * `find_websites.py --json` — free, no AI, no keys. Everything found is saved
 * to the findings database; nothing is added to the resource library until
 * the user picks (POST /api/resources/enrich, then POST /api/resources).
 * Usually takes one to two and a half minutes; a repeat of a recent search
 * comes from the search cache instantly (refresh: true searches again), and
 * browse: true lists the whole database.
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
    }, 420_000);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: `search failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }
}
