import { NextRequest, NextResponse } from "next/server";
import { mintSessionCookie, verifyIdToken, adminDb } from "@/lib/firebase/admin";

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Trade a fresh Firebase ID token for a httpOnly session cookie, AND
 * stash the user's GitHub OAuth access token in their Firestore doc.
 *
 *   POST /api/auth/session-login
 *   body: { idToken: "...", ghToken: "..." }
 *
 * The ghToken is only available at sign-in time (Firebase doesn't return
 * it again later), so the client MUST send it here. Server-side API
 * routes will read it back from Firestore on subsequent requests.
 */
export async function POST(req: NextRequest) {
  let body: { idToken?: string; ghToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const idToken = body.idToken?.trim();
  const ghToken = body.ghToken?.trim();
  if (!idToken) {
    return NextResponse.json({ error: "missing idToken" }, { status: 400 });
  }
  if (!ghToken) {
    return NextResponse.json({ error: "missing ghToken" }, { status: 400 });
  }

  const decoded = await verifyIdToken(`Bearer ${idToken}`);
  if (!decoded) {
    return NextResponse.json({ error: "invalid idToken" }, { status: 401 });
  }

  // Store the GitHub user access token against the Firebase UID.
  // Firestore is encrypted at rest; access is locked to the admin SDK
  // (firestore.rules denies direct client access to this field).
  await adminDb.collection("users").doc(decoded.uid).set(
    {
      email: decoded.email ?? "",
      github_token: ghToken,
      github_token_updated_at: new Date().toISOString(),
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
