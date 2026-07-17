import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  genericRecordsCol,
  genericSourcesCol,
} from "@/lib/firestore/collections";

/** Millis from a Firestore Timestamp / ISO string / 0. */
function millis(v: unknown): number {
  if (v && typeof (v as { toMillis?: () => number }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

async function ownsSource(sid: string, uid: string): Promise<boolean> {
  const snap = await genericSourcesCol().doc(sid).get();
  return snap.exists && snap.data()?.owner_uid === uid;
}

/**
 * GET /api/generic/sources/[sid]/records — the source's scraped records,
 * newest-seen first. Equality-only query + in-memory sort (no composite index),
 * capped so the response stays small.
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/generic/sources/[sid]/records">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { sid } = await ctx.params;
  if (!(await ownsSource(sid, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Equality-only (no orderBy) so no composite index is required — the repo
  // convention. We must NOT pre-limit: without an orderBy, limit() returns docs
  // in doc-ID (hash) order, which would drop the genuinely newest records before
  // the sort. Fetch all for the source, then sort by recency and cap for display.
  const snap = await genericRecordsCol()
    .where("source_id", "==", sid)
    .get();
  const records = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
    .sort((a, b) => millis(b.last_seen_at) - millis(a.last_seen_at))
    .slice(0, 200);
  return NextResponse.json({ records });
}
