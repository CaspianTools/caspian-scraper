import { cookies } from "next/headers";
import {
  verifySessionCookie,
  verifyIdToken,
  adminDb,
} from "@/lib/firebase/admin";

export interface UserSession {
  uid: string;
  email: string;
  ghToken: string;
  fork?: { owner: string; repo: string; full_name: string };
}

/**
 * Resolve the authenticated user from the __session cookie (server
 * components) and pull their stored GitHub token from Firestore.
 *
 * Returns null if not signed in or the Firestore doc is missing.
 */
export async function getSessionFromCookie(): Promise<UserSession | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("__session")?.value;
  const decoded = await verifySessionCookie(sessionCookie);
  if (!decoded) return null;

  const snap = await adminDb.collection("users").doc(decoded.uid).get();
  const data = snap.data();
  const ghToken = data?.github_token as string | undefined;
  if (!ghToken) return null;

  return {
    uid: decoded.uid,
    email: decoded.email ?? "",
    ghToken,
    fork: data?.fork as UserSession["fork"],
  };
}

/**
 * Resolve the authenticated user from an Authorization: Bearer header
 * (API routes). Cheaper for mutating endpoints — no cookie parse, no
 * CSRF surface.
 */
export async function getSessionFromBearer(
  authHeader: string | null
): Promise<UserSession | null> {
  const decoded = await verifyIdToken(authHeader);
  if (!decoded) return null;
  const snap = await adminDb.collection("users").doc(decoded.uid).get();
  const data = snap.data();
  const ghToken = data?.github_token as string | undefined;
  if (!ghToken) return null;
  return {
    uid: decoded.uid,
    email: decoded.email ?? "",
    ghToken,
    fork: data?.fork as UserSession["fork"],
  };
}
