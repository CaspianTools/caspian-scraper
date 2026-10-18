import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  genericRunsCol,
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
 * GET /api/generic/sources/[sid]/runs — the source's run history, newest
 * first. Equality-only query + in-memory sort, capped.
 */
export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/generic/sources/[sid]/runs">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { sid } = await ctx.params;
  if (!(await ownsSource(sid, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Equality-only (no composite index). Don't pre-limit: without an orderBy,
  // limit() would select runs by random auto-ID order and could hide the newest
  // ones. Fetch all for the source, sort by start time, cap for display.
  const snap = await genericRunsCol()
    .where("source_id", "==", sid)
    .get();
  const runs = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>)
    .sort((a, b) => millis(b.started_at) - millis(a.started_at))
    .slice(0, 50);
  return NextResponse.json({ runs });
}
