"use client";

import { useMemo, useState } from "react";
import type { ResourceRow } from "@/lib/firestore/resources";
import { NewResourceForm } from "./NewResourceForm";

interface Props {
  /** The whole shared library. */
  resources: ResourceRow[];
  selected: string[];
  onChange: (ids: string[]) => void;
  /** A resource was just added to the library (it is also auto-selected). */
  onCreated: (row: ResourceRow) => void;
}

/**
 * Searchable checklist over the shared resource library, with an inline
 * "add new" form. Pure selection UI — the caller decides what to save.
 */
export function ResourcePicker({ resources, selected, onChange, onCreated }: Props) {
  const [q, setQ] = useState("");
  const [ats, setAts] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [adding, setAdding] = useState(false);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const atsOptions = useMemo(
    () => Array.from(new Set(resources.map((r) => r.ats))).sort(),
    [resources]
  );

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return resources.filter((r) => {
      if (onlySelected && !selectedSet.has(r.id)) return false;
      if (ats && r.ats !== ats) return false;
      if (!needle) return true;
      return `${r.name} ${r.careers_url} ${r.countries.join(" ")}`
        .toLowerCase()
        .includes(needle);
    });
  }, [resources, q, ats, onlySelected, selectedSet]);

  function toggle(id: string) {
    onChange(
      selectedSet.has(id) ? selected.filter((s) => s !== id) : [...selected, id]
    );
  }

  const allVisibleSelected =
    visible.length > 0 && visible.every((r) => selectedSet.has(r.id));

  function toggleAllVisible() {
    if (allVisibleSelected) {
      const drop = new Set(visible.map((r) => r.id));
      onChange(selected.filter((id) => !drop.has(id)));
    } else {
      onChange(Array.from(new Set([...selected, ...visible.map((r) => r.id)])));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, URL or country…"
          className="flex-1 min-w-48 h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
        <select
          value={ats}
          onChange={(e) => setAts(e.target.value)}
          className="h-9 px-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
        >
          <option value="">All ATS types</option>
          {atsOptions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          <input
            type="checkbox"
            checked={onlySelected}
            onChange={(e) => setOnlySelected(e.target.checked)}
            className="w-4 h-4"
          />
          Selected only
        </label>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            + New resource
          </button>
        )}
      </div>

      {adding && (
        <NewResourceForm
          onCancel={() => setAdding(false)}
          onCreated={(row) => {
            setAdding(false);
            onCreated(row);
            onChange([...selected, row.id]);
          }}
        />
      )}

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-3 py-2 bg-zinc-50 dark:bg-zinc-900/60 border-b border-zinc-200 dark:border-zinc-800 text-xs text-zinc-600 dark:text-zinc-400">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleAllVisible}
              disabled={visible.length === 0}
              className="w-4 h-4"
            />
            Select all shown ({visible.length})
          </label>
          <span>
            {selected.length} of {resources.length} selected
          </span>
        </div>
        {resources.length === 0 ? (
          <p className="px-3 py-8 text-sm text-center text-zinc-500">
            The shared library is empty. Add the first resource with{" "}
            <span className="font-medium">+ New resource</span>.
          </p>
        ) : visible.length === 0 ? (
          <p className="px-3 py-8 text-sm text-center text-zinc-500">
            Nothing matches the filters.
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
            {visible.map((r) => (
              <li key={r.id}>
                <label className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(r.id)}
                    onChange={() => toggle(r.id)}
                    className="w-4 h-4 mt-0.5 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{r.name}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                        {r.ats}
                      </span>
                      {!r.active && (
                        <span className="text-xs text-amber-700 dark:text-amber-400">
                          inactive
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-zinc-500 font-mono truncate">
                      {r.careers_url}
                    </span>
                    {r.used_by.length > 0 && (
                      <span className="block text-xs text-zinc-500 mt-0.5">
                        used by {r.used_by.map((u) => u.name).join(", ")}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
