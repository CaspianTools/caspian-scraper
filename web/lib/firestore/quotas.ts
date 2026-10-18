import { projectsCol, sourcesCol, userDoc } from "./collections";
import type { Quota } from "./schema";

// Effectively unlimited. The platform is single-tenant in practice and
// the original 50/3 caps were getting in the way (the HSE project alone
// has 176 sources from the legacy import). Per-user quota stored in
// /users/{uid}.quota still wins if set, so an admin can re-tighten on
// a specific account.
const NO_LIMIT = 1_000_000;
const DEFAULT_QUOTA: Quota = {
  projects_max: NO_LIMIT,
  sources_max_per_project: NO_LIMIT,
  runs_per_day_max: NO_LIMIT,
};

/**
 * Resolve a user's quota. Reads `/users/{uid}.quota` if present; falls
 * back to the platform defaults.
 */
export async function getUserQuota(uid: string): Promise<Quota> {
  const snap = await userDoc(uid).get();
  const q = snap.data()?.quota as Partial<Quota> | undefined;
  return { ...DEFAULT_QUOTA, ...(q ?? {}) };
}

/**
 * How many projects does this user already own?
 */
export async function countUserProjects(uid: string): Promise<number> {
  const snap = await projectsCol()
    .where("owner_uid", "==", uid)
    .count()
    .get();
  return snap.data().count;
}

/**
 * Check whether a user can create another project right now.
 */
export async function canCreateProject(uid: string): Promise<{
  ok: boolean;
  used: number;
  max: number;
}> {
  const [quota, used] = await Promise.all([
    getUserQuota(uid),
    countUserProjects(uid),
  ]);
  return { ok: used < quota.projects_max, used, max: quota.projects_max };
}

/**
 * How many sources does this project have?
 */
export async function countProjectSources(projectId: string): Promise<number> {
  const snap = await sourcesCol(projectId).count().get();
  return snap.data().count;
}

/**
 * Check whether a project can take another source right now.
 */
export async function canAddSource(
  uid: string,
  projectId: string
): Promise<{ ok: boolean; used: number; max: number }> {
  const [quota, used] = await Promise.all([
    getUserQuota(uid),
    countProjectSources(projectId),
  ]);
  return {
    ok: used < quota.sources_max_per_project,
    used,
    max: quota.sources_max_per_project,
  };
}
