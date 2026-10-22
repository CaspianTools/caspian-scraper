import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { databaseRecords, getDatabase, recordsPage } from "@/lib/databases";

/**
 * GET /api/databases/[id]/records — one page of a database, filtered and
 * sorted on the server (query: see recordsPage in lib/databases.ts).
 *
 * → {total, totalAll, hiddenCount, page, size, items: [{finding, record}],
 *    facets, allTags}, or with select=1 {items: [{id, tags, hidden}]}
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/databases/[id]/records">) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const db = await getDatabase(session.uid, id);
  if (!db) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(recordsPage(databaseRecords(id), db.key, req.nextUrl.searchParams));
}
