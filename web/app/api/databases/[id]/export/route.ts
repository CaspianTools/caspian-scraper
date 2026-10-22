import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { asFinding, databaseRecords, getDatabase, toCsv } from "@/lib/databases";
import { filtersFromQuery, matches } from "@/lib/findings";

/**
 * GET /api/databases/[id]/export — CSV of the records matching the same
 * filters as /records (ids=a,b,… limits it to a selection instead).
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/databases/[id]/export">) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const db = await getDatabase(session.uid, id);
  if (!db) return NextResponse.json({ error: "not found" }, { status: 404 });
  const q = req.nextUrl.searchParams;
  const state = filtersFromQuery(q);
  const only = q.get("ids") ? new Set(q.get("ids")!.split(",")) : null;
  const rows = databaseRecords(id).filter((r) => {
    const f = asFinding(r, db.key);
    if (only) return only.has(f.id);
    return (q.get("hidden") === "1" || !f.hidden) && matches(f, state);
  });
  return new NextResponse(toCsv(rows, db.key), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${id}-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
