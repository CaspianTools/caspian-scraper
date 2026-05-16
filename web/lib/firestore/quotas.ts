import { projectsCol, sourcesCol, userDoc } from "./collections";
import type { Quota } from "./schema";

const DEFAULT_QUOTA: Quota = {
  projects_max: 3,
  sources_max_per_project: 50,
  runs_per_day_max: 50,
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
