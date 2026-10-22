import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { asFinding, databaseRecords, getDatabase } from "@/lib/databases";
import { allTagsOf, facetCounts, filtersFromQuery, matches, sortFindings, type Sort } from "@/lib/findings";

/**
 * GET /api/databases/[id]/records — one page of a database, filtered and
 * sorted on the server.
 *
 *   q, f.<facet> (repeatable), tagMode=all   filters (lib/findings.ts)
 *   hidden=1                                 include hidden records
 *   sort=relevance|name|sources, page (1-based), size (≤200)
 *   select=1                                 instead: every matching {id, tags, hidden}
 *
 * → {total, totalAll, hiddenCount, page, size, items: [{finding, record}],
 *    facets, allTags}
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/databases/[id]/records">) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const db = await getDatabase(session.uid, id);
  if (!db) return NextResponse.json({ error: "not found" }, { status: 404 });

  const q = req.nextUrl.searchParams;
  const state = filtersFromQuery(q);
  const showHidden = q.get("hidden") === "1";
  const rows = databaseRecords(id).map((r) => ({ r, f: asFinding(r, db.key) }));
  const base = rows.filter((x) => showHidden || !x.f.hidden);
  const matching = base.filter((x) => matches(x.f, state));

  if (q.get("select") === "1") {
    return NextResponse.json({ items: matching.map((x) => ({ id: x.f.id, tags: x.f.tags ?? [], hidden: x.f.hidden })) });
  }

  const sortParam = q.get("sort") ?? "";
  const sort: Sort = sortParam === "relevance" || sortParam === "sources" ? sortParam : "name";
  const byId = new Map(matching.map((x) => [x.f.id, x.r]));
  const sorted = sortFindings(matching.map((x) => x.f), sort);
  const size = Math.min(200, Math.max(1, Number(q.get("size")) || 60));
  const page = Math.max(1, Number(q.get("page")) || 1);
  const slice = sorted.slice((page - 1) * size, page * size);
  return NextResponse.json({
    total: sorted.length,
    totalAll: base.length,
    hiddenCount: rows.filter((x) => x.f.hidden).length,
    page,
    size,
    items: slice.map((f) => ({ finding: f, record: byId.get(f.id) })),
    facets: facetCounts(base.map((x) => x.f), state),
    allTags: allTagsOf(rows.map((x) => x.f)),
  });
}
