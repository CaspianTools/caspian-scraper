/**
 * Sign-in is disabled: the app runs on the operator's own computer, and
 * anyone who can run it already has the repo. Every request gets the same
 * local session, so the existing `owner_uid == session.uid` filters keep
 * working and all data is owned by LOCAL_UID.
 */

export type Role = "super_admin" | "admin";

export interface UserSession {
  /** Workspace uid — what every `owner_uid` query filters on. */
  uid: string;
  email: string;
  name: string;
  picture: string;
  role: Role;
  /** Real uid of the person signed in; the same as `uid` locally. */
  actorUid: string;
  /** Gates the AI-config LLM key — always true locally. */
  isSuperAdmin: boolean;
}

export const LOCAL_UID = "local";

const LOCAL_SESSION: UserSession = {
  uid: LOCAL_UID,
  actorUid: LOCAL_UID,
  email: "",
  name: "Local",
  picture: "",
  role: "super_admin",
  isSuperAdmin: true,
};

/** Server components / pages. */
export async function getSessionFromCookie(): Promise<UserSession | null> {
  return LOCAL_SESSION;
}

/** API routes. The header is ignored — there are no tokens locally. */
export async function getSessionFromBearer(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _authHeader?: string | null
): Promise<UserSession | null> {
  return LOCAL_SESSION;
}
