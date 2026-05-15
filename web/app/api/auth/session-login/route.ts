import { NextRequest, NextResponse } from "next/server";
import { mintSessionCookie } from "@/lib/firebase/admin";

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Trade a fresh Firebase ID token for a httpOnly session cookie.
 *
 *   POST /api/auth/session-login
 *   body: { idToken: "..." }
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

  let sessionCookie: string;
  try {
    sessionCookie = await mintSessionCookie(idToken, FIVE_DAYS_MS);
  } catch {
    return NextResponse.json({ error: "invalid idToken" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: "__session",
    value: sessionCookie,
    maxAge: Math.floor(FIVE_DAYS_MS / 1000),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // lax — allows the GitHub install redirect to land authed
    path: "/",
  });
  return res;
}
