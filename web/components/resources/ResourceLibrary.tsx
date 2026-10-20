"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ResourceRow } from "@/lib/firestore/resources";
import { NewResourceForm } from "./NewResourceForm";
import { FindWebsites } from "./FindWebsites";

/** Searchable list of the shared library with per-resource job usage. */
export function ResourceLibrary({
  resources,
  hideFind = false,
}: {
  resources: ResourceRow[];
  /** Hide the inline Find websites button (when a sidebar has the search). */
  hideFind?: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [unused, setUnused] = useState(false);
  const [adding, setAdding] = useState(false);
  const [finding, setFinding] = useState(false);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return resources.filter((r) => {
      if (unused && r.used_by.length > 0) return false;
      if (!needle) return true;
      return `${r.name} ${r.careers_url} ${r.countries.join(" ")} ${r.used_by.map((u) => u.name).join(" ")}`
        .toLowerCase()
        .includes(needle);
    });
  }, [resources, q, unused]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, URL, country or job…"
          className="flex-1 min-w-48 h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
        <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={unused}
            onChange={(e) => setUnused(e.target.checked)}
            className="w-4 h-4"
          />
          Unused only
        </label>
        {!finding && !hideFind && (
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setFinding(true);
            }}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Find websites
          </button>
        )}
        {!adding && (
          <button
            type="button"
            onClick={() => {
              setFinding(false);
              setAdding(true);
            }}
            className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            + New resource
          </button>
        )}
      </div>

      {finding && (
        <FindWebsites
          onClose={() => setFinding(false)}
          onAdded={() => {
            setFinding(false);
            router.refresh();
          }}
        />
      )}

      {adding && (
        <NewResourceForm
          onCancel={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      )}

      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">ATS</th>
              <th className="px-4 py-2.5 font-medium">Used by</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-zinc-500">
                  {resources.length === 0
                    ? "The library is empty. Use Find websites for suggestions, add a resource yourself, or move a job's sources in from its Sources tab."
                    : "Nothing matches."}
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="px-4 py-2.5 max-w-sm">
                    <Link href={`/resources/${r.id}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                    <span className="block text-xs text-zinc-500 font-mono truncate">
                      {r.careers_url}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{r.ats}</td>
                  <td className="px-4 py-2.5">
                    {r.used_by.length === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      r.used_by.map((u, i) => (
                        <span key={u.id}>
                          {i > 0 && ", "}
                          <Link href={`/projects/${u.id}/sources`} className="hover:underline">
                            {u.name}
                          </Link>
                        </span>
                      ))
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={
                        "text-xs px-2 py-0.5 rounded-full " +
                        (r.active
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400")
                      }
                    >
                      {r.active ? "active" : "inactive"}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
