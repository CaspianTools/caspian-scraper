import { cookies } from "next/headers";
import type { DecodedIdToken } from "firebase-admin/auth";
import {
  verifySessionCookie,
  verifyIdToken,
  adminDb,
} from "@/lib/firebase/admin";
import { roleFor, resolveWorkspaceUid, type Role } from "@/lib/auth/roles";

export interface UserSession {
  /**
   * The *workspace* uid — what every `owner_uid` query filters on. For an
   * admin this is aliased to the super admin's uid, so they operate inside the
   * shared workspace. Use `actorUid` when you need who is actually signed in.
   */
  uid: string;
  /** Real email of the signed-in account. */
  email: string;
  name: string;
  /** Google avatar URL. May be empty if the user has no profile photo. */
  picture: string;
  role: Role;
  /** Real Firebase uid of the signed-in account (never aliased). */
  actorUid: string;
  /** True only for the workspace owner. Gates the AI-config LLM key. */
  isSuperAdmin: boolean;
}

/**
 * Fetch the profile fields stored alongside auth identity in
 * /users/{uid}. The session-login route writes these at sign-in
 * (email, name, picture). Returns {} if the doc is missing — fall
 * back to whatever the auth token carries.
 *
 * Always keyed by the *actor* uid, never the workspace uid: an admin must see
 * their own name and avatar in the header, not the owner's.
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
 * Turn a verified token into a session, or null if the account isn't on the
 * allowlist. Checked on *every* request rather than only at sign-in, so
 * removing someone from ADMIN_EMAILS takes effect immediately instead of
 * waiting out their 5-day session cookie.
 */
async function buildSession(
  decoded: DecodedIdToken,
  opts: { withProfile: boolean }
): Promise<UserSession | null> {
  const role = roleFor(decoded.email);
  if (!role) return null;
  const uid = await resolveWorkspaceUid(role, decoded.uid);
  if (!uid) return null;

  const profile = opts.withProfile ? await loadProfile(decoded.uid) : {};
  return {
    uid,
    actorUid: decoded.uid,
    email: profile.email ?? decoded.email ?? "",
    name: profile.name ?? "",
    picture: profile.picture ?? "",
    role,
    isSuperAdmin: role === "super_admin",
  };
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
  return buildSession(decoded, { withProfile: true });
}

/**
 * Resolve the authenticated user from an Authorization: Bearer header.
 * Use in mutating API routes — same-origin custom header is the CSRF
 * defence. Skips the Firestore profile read since API routes rarely
 * need name/picture; falls back to empty strings for those.
 *
 * The allowlist check matters most here: these routes verify a Google ID token
 * directly and never see the session cookie, so gating only sign-in would leave
 * every write endpoint reachable by a removed account holding a live token.
 */
export async function getSessionFromBearer(
  authHeader: string | null
): Promise<UserSession | null> {
  const decoded = await verifyIdToken(authHeader);
  if (!decoded) return null;
  return buildSession(decoded, { withProfile: false });
}
