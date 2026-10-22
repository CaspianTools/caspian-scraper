import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { databaseRecords, exportRows, getDatabase, toCsv } from "@/lib/databases";

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
  const rows = exportRows(databaseRecords(id), db.key, req.nextUrl.searchParams);
  return new NextResponse(toCsv(rows, db.key), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${id}-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
