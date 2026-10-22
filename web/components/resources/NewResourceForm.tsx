"use client";

import { useState } from "react";
import { CountrySelect } from "@/components/CountrySelect";
import { apiFetch } from "@/lib/api";
import type { ResourceRow } from "@/lib/firestore/resources";
import { emptySourceFormInitial } from "@/components/sourceFormDefaults";

interface Props {
  /** Called with the saved resource (already in the shared library). */
  onCreated: (row: ResourceRow) => void;
  onCancel: () => void;
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs";

/**
 * Compact "add a website to the shared library" form — the essentials only.
 * Extra details (HQ, LinkedIn, notes) can be filled in later from
 * Resources → edit.
 */
export function NewResourceForm({ onCreated, onCancel }: Props) {
  const [form, setForm] = useState(emptySourceFormInitial());
  const [countries, setCountries] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch("/api/resources", {
        method: "POST",
        body: JSON.stringify({ ...form, name: form.name.trim(), countries }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          Array.isArray(b.details)
            ? b.details
                .map((d: { path?: string[]; message: string }) =>
                  `${d.path?.join(".") ?? ""} ${d.message}`.trim()
                )
                .join("; ")
            : b.error || `Request failed (${res.status})`
        );
        return;
      }
      onCreated({
        id: b.id,
        name: b.name,
        kind: b.kind,
        ats: b.ats,
        careers_url: b.careers_url,
        active: b.active !== false,
        countries: b.countries ?? [],
        used_by: [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Not a <form>: callers may already sit inside one, and nested forms are
  // invalid HTML. Enter in a field saves via onKeyDown instead.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (form.name.trim() && form.careers_url.trim() && !busy) save();
    }
  };

  return (
    <div
      onKeyDown={onKeyDown}
      className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 p-4 space-y-4"
    >
      <p className="text-sm font-medium">Add a new resource</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="block font-medium mb-1">Name</span>
          <input
            type="text"
            maxLength={120}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Saudi Aramco"
            className={inputCls}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium mb-1">Careers URL</span>
          <input
            type="url"
            value={form.careers_url}
            onChange={(e) => setForm({ ...form, careers_url: e.target.value })}
            placeholder="https://careers.aramco.com/search/?q=hse"
            className={inputCls + " font-mono"}
          />
        </label>
        <label className="block text-sm">
          <span className="block font-medium mb-1">ATS / parser type</span>
          <select
            value={form.ats}
            onChange={(e) =>
              setForm({ ...form, ats: e.target.value as typeof form.ats })
            }
            className={inputCls}
          >
            <option value="successfactors">SAP SuccessFactors</option>
            <option value="jibe">Jibe / iCIMS</option>
            <option value="unknown">Unknown (won&apos;t be scraped yet)</option>
          </select>
        </label>
        <div className="block text-sm">
          <span className="block font-medium mb-1">
            Countries <span className="text-zinc-500 font-normal">(optional)</span>
          </span>
          <CountrySelect value={countries} onChange={setCountries} />
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center h-9 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 bg-white dark:bg-zinc-900 shadow-xs font-medium"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy || !form.name.trim() || !form.careers_url.trim()}
          className="inline-flex items-center h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
        >
          {busy ? "Saving…" : "Save to library"}
        </button>
      </div>
    </div>
  );
}
