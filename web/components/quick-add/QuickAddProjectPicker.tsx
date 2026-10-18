"use client";

import { useEffect, useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";
import { useQuickAdd } from "./QuickAddProvider";

interface ProjectLite {
  id: string;
  name: string;
  enabled?: boolean;
}

export function QuickAddProjectPicker() {
  const { selectProject, selectKind, state } = useQuickAdd();
  const [projects, setProjects] = useState<ProjectLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch("/api/projects");
        if (!res.ok) {
          setError(`Failed to load projects (${res.status})`);
          return;
        }
        const body = (await res.json()) as { projects?: ProjectLite[] };
        if (cancelled) return;
        setProjects(body.projects ?? []);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }
  if (projects === null) {
    return <p className="text-sm text-zinc-500">Loading projects…</p>;
  }
  if (projects.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center">
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
          You don&apos;t have any projects yet. Create one first to add a{" "}
          {state.kind}.
        </p>
        <button
          type="button"
          onClick={() => selectKind("project")}
          className="inline-flex items-center h-9 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          Create a project
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Which project should this {state.kind} belong to?
      </p>
      <ul className="space-y-2">
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => selectProject(p.id)}
              className="w-full text-left rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600 bg-white dark:bg-zinc-950 px-4 py-3 transition-colors flex items-center justify-between gap-3"
            >
              <span className="text-sm font-medium truncate">{p.name}</span>
              {p.enabled === false && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 shrink-0">
                  disabled
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
