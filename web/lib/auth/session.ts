import { cookies } from "next/headers";
import {
  verifySessionCookie,
  verifyIdToken,
  adminDb,
} from "@/lib/firebase/admin";

export interface UserSession {
  uid: string;
  email: string;
  name: string;
  /** Google avatar URL. May be empty if the user has no profile photo. */
  picture: string;
}

/**
 * Fetch the profile fields stored alongside auth identity in
 * /users/{uid}. The session-login route writes these at sign-in
 * (email, name, picture). Returns {} if the doc is missing — fall
 * back to whatever the auth token carries.
 */
async function loadProfile(
  uid: string
): Promise<{ name?: string; picture?: string; email?: string }> {
  try {
    const snap = await adminDb.collection("users").doc(uid).get();
    const data = snap.data();
    if (!data) return {};
    return {
      name: typeof data.name === "string" ? data.name : undefined,
      picture: typeof data.picture === "string" ? data.picture : undefined,
      email: typeof data.email === "string" ? data.email : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Resolve the authenticated user from the __session cookie. Use in
 * server components and page renders.
 */
export async function getSessionFromCookie(): Promise<UserSession | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("__session")?.value;
  const decoded = await verifySessionCookie(sessionCookie);
  if (!decoded) return null;
  const profile = await loadProfile(decoded.uid);
  return {
    uid: decoded.uid,
    email: profile.email ?? decoded.email ?? "",
    name: profile.name ?? "",
    picture: profile.picture ?? "",
  };
}

/**
 * Resolve the authenticated user from an Authorization: Bearer header.
 * Use in mutating API routes — same-origin custom header is the CSRF
 * defence. Skips the Firestore profile read since API routes rarely
 * need name/picture; falls back to empty strings for those.
 */
export async function getSessionFromBearer(
  authHeader: string | null
): Promise<UserSession | null> {
  const decoded = await verifyIdToken(authHeader);
  if (!decoded) return null;
  return {
    uid: decoded.uid,
    email: decoded.email ?? "",
    name: "",
    picture: "",
  };
}
