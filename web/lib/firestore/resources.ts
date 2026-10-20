import type { DocumentSnapshot } from "@/lib/localdb";
import { adminDb } from "@/lib/firebase/admin";
import { projectsCol, resourceDoc, resourcesCol } from "./collections";

/**
 * Server-side helpers for the shared resource library (/resources/{rid}).
 * A resource is a website to scrape that any number of jobs (projects) can
 * attach through projects/{id}.resource_ids.
 */

/** Client-safe row (no Firestore Timestamps). */
export interface ResourceRow {
  id: string;
  name: string;
  kind: string;
  ats: string;
  careers_url: string;
  active: boolean;
  countries: string[];
  /** Jobs (projects) that currently use this resource. */
  used_by: { id: string; name: string }[];
}

export function toResourceRow(
  d: DocumentSnapshot,
  usedBy: { id: string; name: string }[] = []
): ResourceRow {
  const data = d.data() ?? {};
  return {
    id: d.id,
    name: data.name ?? "(unnamed)",
    kind: data.kind ?? "employer",
    ats: data.ats ?? "unknown",
    careers_url: data.careers_url ?? "",
    active: data.active !== false,
    countries: Array.isArray(data.countries) ? data.countries : [],
    used_by: usedBy,
  };
}

/**
 * resource id → jobs that list it. One query over the owner's projects;
 * fine at the scale of a single workspace.
 */
export async function resourceUsage(
  uid: string
): Promise<Map<string, { id: string; name: string }[]>> {
  const snap = await projectsCol()
    .where("owner_uid", "==", uid)
    .select("name", "resource_ids")
    .get();
  const usage = new Map<string, { id: string; name: string }[]>();
  for (const p of snap.docs) {
    const ids = p.get("resource_ids");
    if (!Array.isArray(ids)) continue;
    for (const rid of ids) {
      const list = usage.get(rid) ?? [];
      list.push({ id: p.id, name: p.get("name") ?? p.id });
      usage.set(rid, list);
    }
  }
  return usage;
}

/**
 * The owner's whole library with usage, sorted by name. Sorted in memory so
 * no composite (owner_uid, name) index is needed.
 */
export async function listResources(uid: string): Promise<ResourceRow[]> {
  const [snap, usage] = await Promise.all([
    resourcesCol().where("owner_uid", "==", uid).get(),
    resourceUsage(uid),
  ]);
  return snap.docs
    .map((d) => toResourceRow(d, usage.get(d.id) ?? []))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Of `ids`, the ones that don't exist or belong to someone else. A job may
 * only reference resources from its own workspace.
 */
export async function invalidResourceIds(
  uid: string,
  ids: string[]
): Promise<string[]> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return [];
  const snaps = await adminDb.getAll(...unique.map((id) => resourceDoc(id)));
  return snaps
    .filter((s) => !s.exists || s.get("owner_uid") !== uid)
    .map((s) => s.id);
}

/**
 * The resources a job has attached (projects/{id}.resource_ids), skipping
 * missing or foreign docs — the same rule load_sources applies in scrape.py.
 */
export async function attachedResources(
  uid: string,
  resourceIds: unknown,
  { activeOnly = false }: { activeOnly?: boolean } = {}
): Promise<DocumentSnapshot[]> {
  const ids = Array.isArray(resourceIds)
    ? Array.from(new Set(resourceIds.filter((r): r is string => typeof r === "string" && r !== "")))
    : [];
  if (ids.length === 0) return [];
  const snaps = await adminDb.getAll(...ids.map((id) => resourceDoc(id)));
  return snaps.filter(
    (s) =>
      s.exists &&
      s.get("owner_uid") === uid &&
      (!activeOnly || s.get("active") === true)
  );
}
