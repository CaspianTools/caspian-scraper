import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import { exportRows, toCsv } from "@/lib/databases";
import { isOwnJob } from "@/lib/jobs";
import { allRecords } from "@/lib/recordstore";

/** Bookkeeping fields left out of an export. */
const NOT_EXPORTED = new Set(["fingerprint", "source_id"]);

/** GET /api/projects/[id]/results/export — CSV of the job's (filtered or selected) results. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/projects/[id]/results/export">) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!(await isOwnJob(id, session.uid))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const rows = exportRows(allRecords(`job:${id}`), "url", req.nextUrl.searchParams).map((r) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => !NOT_EXPORTED.has(k)))
  );
  return new NextResponse(toCsv(rows, "url"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${id}-results-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
