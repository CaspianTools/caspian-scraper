"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import type { ResourceRow } from "@/lib/firestore/resources";
import { ResourcePicker } from "./ResourcePicker";

interface Props {
  projectId: string;
  library: ResourceRow[];
  attachedIds: string[];
  /** This job's own (non-shared) sources — offered a move to the library. */
  ownSourcesCount: number;
}

const secondaryBtn =
  "inline-flex items-center h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 bg-white dark:bg-zinc-900 shadow-xs font-medium";
const primaryBtn =
  "inline-flex items-center h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20";

/**
 * The job's attached shared resources (projects/{id}.resource_ids), with an
 * attach/detach picker over the whole library.
 */
export function SharedResourcesPanel({
  projectId,
  library: serverLibrary,
  attachedIds,
  ownSourcesCount,
}: Props) {
  const router = useRouter();
  // Only resources created here live in state; the server list stays the
  // source of truth so router.refresh() (e.g. after a move) shows up.
  const [created, setCreated] = useState<ResourceRow[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(attachedIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const library = [
    ...serverLibrary,
    ...created.filter((c) => !serverLibrary.some((r) => r.id === c.id)),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const attached = library.filter((r) => attachedIds.includes(r.id));

  async function save(ids: string[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ resource_ids: ids }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.details?.[0]?.message || b.error || `Save failed (${res.status})`);
        return false;
      }
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function promote() {
    if (
      !confirm(
        `Move this job's ${ownSourcesCount} source${ownSourcesCount === 1 ? "" : "s"} into the shared library?\n\n` +
          "They stay attached to this job and keep their history, and become available to other jobs. " +
          "Editing one afterwards changes it for every job that uses it."
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/sources/promote`, {
        method: "POST",
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(b.error || `Move failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 space-y-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold tracking-tight">
            Shared resources{" "}
            <span className="text-zinc-500 font-normal">({attachedIds.length})</span>
          </h3>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Websites from the{" "}
            <Link href="/resources" className="underline">
              shared library
            </Link>{" "}
            that this job scrapes alongside its own sources.
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(attachedIds);
              setEditing(true);
            }}
            className={secondaryBtn}
          >
            Attach / detach…
          </button>
        )}
      </div>

      {ownSourcesCount > 0 && !editing && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm">
          <span>
            This job has {ownSourcesCount} source{ownSourcesCount === 1 ? "" : "s"} of
            its own that other jobs can&apos;t use.
          </span>
          <button type="button" onClick={promote} disabled={busy} className={secondaryBtn}>
            {busy ? "Moving…" : "Move to shared library"}
          </button>
        </div>
      )}

      {editing ? (
        <div className="space-y-3">
          <ResourcePicker
            resources={library}
            selected={draft}
            onChange={setDraft}
            onCreated={(row) => setCreated((c) => [...c, row])}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className={secondaryBtn}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                if (await save(draft)) setEditing(false);
              }}
              disabled={busy}
              className={primaryBtn}
            >
              {busy ? "Saving…" : `Save (${draft.length} attached)`}
            </button>
          </div>
        </div>
      ) : attached.length === 0 ? (
        <p className="text-sm text-zinc-500">No shared resources attached.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 max-h-96 overflow-y-auto">
          {attached.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <Link href={`/resources/${r.id}`} className="text-sm font-medium hover:underline">
                    {r.name}
                  </Link>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                    {r.ats}
                  </span>
                  {!r.active && (
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      inactive — skipped
                    </span>
                  )}
                  {r.used_by.length > 1 && (
                    <span className="text-xs text-zinc-500">
                      shared with {r.used_by.length - 1} other job
                      {r.used_by.length === 2 ? "" : "s"}
                    </span>
                  )}
                </span>
                <span className="block text-xs text-zinc-500 font-mono truncate">
                  {r.careers_url}
                </span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => save(attachedIds.filter((id) => id !== r.id))}
                className="text-xs px-2 h-7 rounded-md text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
              >
                Detach
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
