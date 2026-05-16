import { cookies } from "next/headers";
import { verifySessionCookie, verifyIdToken } from "@/lib/firebase/admin";

export interface UserSession {
  uid: string;
  email: string;
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
  return { uid: decoded.uid, email: decoded.email ?? "" };
}

/**
 * Resolve the authenticated user from an Authorization: Bearer header.
 * Use in mutating API routes — same-origin custom header is the CSRF
 * defence.
 */
export async function getSessionFromBearer(
  authHeader: string | null
): Promise<UserSession | null> {
  const decoded = await verifyIdToken(authHeader);
  if (!decoded) return null;
  return { uid: decoded.uid, email: decoded.email ?? "" };
}
