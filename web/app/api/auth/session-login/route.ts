import { NextRequest, NextResponse } from "next/server";
import { mintSessionCookie, verifyIdToken, adminDb } from "@/lib/firebase/admin";

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Trade a fresh Firebase ID token for a httpOnly session cookie.
 *
 *   POST /api/auth/session-login
 *   body: { idToken: "..." }
 *
 * The user signed in with Google via Firebase Auth on the client. We
 * verify their ID token, upsert their /users/{uid} doc, and set a
 * session cookie that subsequent server routes use to identify them.
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

  // Upsert a profile doc. Useful for displaying user info + a hook for
  // a future allowlist of authorized emails.
  await adminDb.collection("users").doc(decoded.uid).set(
    {
      email: decoded.email ?? "",
      name: decoded.name ?? "",
      picture: decoded.picture ?? "",
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
