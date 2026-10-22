"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm shadow-xs";

/** "New database": name, what a record is called, how records are keyed. */
export function NewDatabaseButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [singular, setSingular] = useState("");
  const [plural, setPlural] = useState("");
  const [key, setKey] = useState<"id" | "domain" | "url">("url");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/databases", {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          key,
          record_label: { singular: singular.trim() || "record", plural: plural.trim() || "records" },
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.details?.[0]?.message || b.error || `Failed (${res.status})`);
      router.push(`/databases/${b.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 dark:bg-brand-500 dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        New database
      </button>
    );
  }
  return (
    <form
      onSubmit={create}
      className="w-[min(32rem,90vw)] rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 space-y-3 shadow-card"
    >
      <p className="text-sm font-semibold tracking-tight">New database</p>
      <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Training centres" aria-label="Name" className={inputCls} />
      <input maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it holds (optional)" aria-label="Description" className={inputCls} />
      <div className="grid grid-cols-2 gap-2">
        <input maxLength={40} value={singular} onChange={(e) => setSingular(e.target.value)} placeholder="One record is a… (vacancy)" aria-label="Record name, singular" className={inputCls} />
        <input maxLength={40} value={plural} onChange={(e) => setPlural(e.target.value)} placeholder="Plural (vacancies)" aria-label="Record name, plural" className={inputCls} />
      </div>
      <label className="block text-sm">
        <span className="block text-xs text-zinc-500 mb-1">The same record is recognised by its…</span>
        <select value={key} onChange={(e) => setKey(e.target.value as typeof key)} className={inputCls}>
          <option value="url">Link (vacancies, listings, products)</option>
          <option value="domain">Website domain (companies)</option>
          <option value="id">Own id</option>
        </select>
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm">
          Cancel
        </button>
        <button type="submit" disabled={busy || !name.trim()} className="h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium disabled:opacity-50">
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}
