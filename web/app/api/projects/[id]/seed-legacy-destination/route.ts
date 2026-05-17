import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getSessionFromBearer } from "@/lib/auth/session";
import { projectDoc, destinationsCol } from "@/lib/firestore/collections";

/**
 * POST /api/projects/[id]/seed-legacy-destination
 *
 * One-off helper: pre-create the entirelysafe.com destination that the
 * old scrape.py used to POST to. Idempotent — if a destination with
 * the same base_url already exists, returns it instead of creating a
 * second one. The user still needs to add an ENTIRELYSAFE_API_KEY
 * secret separately (the destination just references the name).
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/seed-legacy-destination">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;

  const psnap = await projectDoc(id).get();
  if (!psnap.exists || psnap.data()?.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const LEGACY = {
    name: "entirelysafe.com API",
    base_url: "https://entirelysafe.com/api/v1",
    list_path: "/vacancies",
    post_path: "/vacancies",
    auth_header_name: "X-API-Key",
    auth_header_format: "{secret}",
    secret_ref: "ENTIRELYSAFE_API_KEY",
    field_map: {},
  };

  // Idempotency: skip if a destination with the same base_url already
  // exists in this project.
  const existing = await destinationsCol(id)
    .where("base_url", "==", LEGACY.base_url)
    .limit(1)
    .get();
  if (!existing.empty) {
    const doc = existing.docs[0];
    return NextResponse.json({
      ok: true,
      created: false,
      id: doc.id,
      message: "destination with this base_url already exists",
    });
  }

  const ref = await destinationsCol(id).add({
    ...LEGACY,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });

  return NextResponse.json({
    ok: true,
    created: true,
    id: ref.id,
    secret_ref: LEGACY.secret_ref,
  });
}
