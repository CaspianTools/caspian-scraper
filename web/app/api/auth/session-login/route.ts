import { NextRequest, NextResponse } from "next/server";
import { mintSessionCookie, verifyIdToken, adminDb } from "@/lib/firebase/admin";
import { roleFor } from "@/lib/auth/roles";

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Trade a fresh Firebase ID token for a httpOnly session cookie.
 *
 *   POST /api/auth/session-login
 *   body: { idToken: "..." }
 *
 * The user signed in with Google via Firebase Auth on the client. We
 * verify their ID token, check them against the allowlist, upsert their
 * /users/{uid} doc, and set a session cookie that subsequent server routes
 * use to identify them.
 *
 * A valid Google token is NOT enough — the account must be named in
 * SUPER_ADMIN_EMAIL or ADMIN_EMAILS. Without this gate anyone who finds the
 * URL gets a working account.
 */
export async function POST(req: NextRequest) {
  let body: { idToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const idToken = body.idToken?.trim();
  if (!idToken) {
    return NextResponse.json({ error: "missing idToken" }, { status: 400 });
  }

  const decoded = await verifyIdToken(`Bearer ${idToken}`);
  if (!decoded) {
    return NextResponse.json({ error: "invalid idToken" }, { status: 401 });
  }

  // Allowlist check, before we write anything or mint a cookie. Reject with a
  // distinct 403 (not 401) so the sign-in page can tell "not authorized" apart
  // from "bad token" and show the right message.
  const role = roleFor(decoded.email);
  if (!role) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  // Upsert a profile doc — displayed in the header, and makes the roster
  // visible in the Firestore console. Keyed by the real uid, never the
  // aliased workspace uid.
  await adminDb.collection("users").doc(decoded.uid).set(
    {
      email: decoded.email ?? "",
      name: decoded.name ?? "",
      picture: decoded.picture ?? "",
      role,
      last_signed_in_at: new Date().toISOString(),
    },
    { merge: true }
  );

  let sessionCookie: string;
  try {
    sessionCookie = await mintSessionCookie(idToken, FIVE_DAYS_MS);
  } catch {
    return NextResponse.json(
      { error: "failed to mint session cookie" },
      { status: 401 }
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: "__session",
    value: sessionCookie,
    maxAge: Math.floor(FIVE_DAYS_MS / 1000),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
  return res;
}
