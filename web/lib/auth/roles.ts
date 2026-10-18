import { adminAuth } from "@/lib/firebase/admin";

/**
 * Who is allowed into this workspace, and as what.
 *
 * The app is a single shared workspace, not a multi-tenant SaaS. Every doc in
 * Firestore carries an `owner_uid` and ~90 call sites filter on
 * `owner_uid == session.uid`. Rather than teach all of them about roles, an
 * admin's session `uid` is *aliased* to the super admin's uid — so the existing
 * ownership queries return the shared workspace unchanged. The real signed-in
 * identity is carried alongside as `actorUid` (see lib/auth/session.ts).
 *
 * Config (see web/apphosting.yaml for production values):
 *   SUPER_ADMIN_EMAIL — the workspace owner. Owns the AI-config LLM key.
 *   ADMIN_EMAILS      — comma-separated. Full access, minus the LLM key.
 *
 * Fail-closed: with SUPER_ADMIN_EMAIL unset, nobody gets a session. An empty
 * allowlist must lock the app down, never open it up.
 */

export type Role = "super_admin" | "admin";

/** Trim + lowercase, so casing never causes a spurious rejection. */
export function normalizeEmail(email: string | undefined | null): string {
  return String(email ?? "")
    .trim()
    .toLowerCase();
}

function superAdminEmail(): string {
  return normalizeEmail(process.env.SUPER_ADMIN_EMAIL);
}

function adminEmails(): string[] {
  return String(process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
}

/**
 * The role for a signed-in email, or null if the account isn't allowed in.
 * Read from env on every call so there is no stale-cache path — the cost is a
 * couple of string splits, and it means an allowlist change takes effect on the
 * next request rather than the next cold start.
 */
export function roleFor(email: string | undefined | null): Role | null {
  const owner = superAdminEmail();
  if (!owner) return null;
  const e = normalizeEmail(email);
  if (!e) return null;
  if (e === owner) return "super_admin";
  return adminEmails().includes(e) ? "admin" : null;
}

// A Firebase uid never changes for a given account, so this is safe to cache
// for the life of the instance and saves an Auth round-trip per admin request.
let _cachedOwnerUid: string | null = null;

/**
 * The uid that owns the shared workspace — i.e. the uid stamped on every
 * existing `owner_uid`. Returns null if SUPER_ADMIN_EMAIL is unset or has no
 * Firebase Auth account yet (the owner has never signed in), which callers
 * must treat as "deny", not "allow".
 */
async function superAdminUid(): Promise<string | null> {
  if (_cachedOwnerUid) return _cachedOwnerUid;
  const owner = superAdminEmail();
  if (!owner) return null;
  try {
    const user = await adminAuth.getUserByEmail(owner);
    _cachedOwnerUid = user.uid;
    return _cachedOwnerUid;
  } catch {
    return null;
  }
}

/**
 * Map a signed-in user onto the workspace they operate in. The super admin
 * uses their own uid; an admin is aliased onto the super admin's, which is what
 * makes them see the shared data.
 */
export async function resolveWorkspaceUid(
  role: Role,
  actorUid: string
): Promise<string | null> {
  return role === "super_admin" ? actorUid : superAdminUid();
}
