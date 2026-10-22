"use client";

import type { JobField, JobModules } from "@/lib/jobTemplates";

const inputCls =
  "w-full h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm shadow-xs focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500";

export interface JobSetup {
  record_label: { singular: string; plural: string };
  fields: JobField[];
  modules: JobModules;
}

const MODULES: { key: keyof JobModules; label: string; hint: string }[] = [
  { key: "discovery", label: "Discover", hint: "Find websites (maps, web, directories) to add as sources." },
  { key: "follow_up", label: "Follow-up pages", hint: "Visit each result's own page — a company's careers page, a listing's details." },
  { key: "compare", label: "Compare", hint: "Match the same item across sources, by product code or name." },
];

/** "a field_key" from a label: "Posted date" → "posted_date". */
function keyOf(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

/**
 * What a job collects: its record name (used in every label), the fields its
 * records have (the Results columns) and its optional modules. Shared by the
 * New-job wizard and the job's Settings.
 */
export function JobSetupFields({ value, onChange }: { value: JobSetup; onChange: (v: JobSetup) => void }) {
  const set = (patch: Partial<JobSetup>) => onChange({ ...value, ...patch });
  const fields = value.fields;
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium mb-1">What is one result called?</p>
        <p className="text-xs text-zinc-500 mb-2">Used in every label — “42 vacancies found”, “5 new listings”.</p>
        <div className="grid grid-cols-2 gap-2 max-w-md">
          <input
            aria-label="One result is a…"
            maxLength={40}
            value={value.record_label.singular}
            onChange={(e) => set({ record_label: { ...value.record_label, singular: e.target.value } })}
            placeholder="vacancy"
            className={inputCls}
          />
          <input
            aria-label="Several are…"
            maxLength={40}
            value={value.record_label.plural}
            onChange={(e) => set({ record_label: { ...value.record_label, plural: e.target.value } })}
            placeholder="vacancies"
            className={inputCls}
          />
        </div>
      </div>

      <div>
        <p className="text-sm font-medium mb-1">Fields</p>
        <p className="text-xs text-zinc-500 mb-2">
          The columns of its results. Sources fill the fields they know (a careers page: title, company,
          location…); for “any website” sources you name the fields to collect.
        </p>
        <ul className="space-y-1.5 max-w-xl">
          {fields.map((f, i) => (
            <li key={i} className="flex items-center gap-2">
              <input
                aria-label={`Field ${i + 1}`}
                value={f.label}
                maxLength={60}
                onChange={(e) =>
                  set({
                    // A field keeps its key when renamed (it maps to what the
                    // sources fill); a new one gets its key from its label on save.
                    fields: fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                  })
                }
                className={inputCls}
              />
              <code className="w-36 shrink-0 text-[11px] text-zinc-400 truncate" title="Stored as">
                {f.key || keyOf(f.label) || "—"}
              </code>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => set({ fields: fields.map((x, j) => (j === i - 1 ? fields[i] : j === i ? fields[i - 1] : x)) })}
                aria-label="Move up"
                className="h-8 w-8 rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => set({ fields: fields.filter((_, j) => j !== i) })}
                aria-label={`Remove ${f.label}`}
                className="h-8 w-8 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => set({ fields: [...fields, { key: "", label: "" }] })}
          className="mt-2 text-sm font-medium text-brand-600 dark:text-brand-400 hover:underline"
        >
          + Add field
        </button>
      </div>

      <fieldset>
        <legend className="text-sm font-medium mb-2">Modules</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {MODULES.map((m) => (
            <label
              key={m.key}
              className={
                "flex items-start gap-2 rounded-xl border p-3 cursor-pointer " +
                (value.modules[m.key]
                  ? "border-brand-500 ring-1 ring-brand-500 bg-brand-50/40 dark:bg-brand-500/10"
                  : "border-zinc-200 dark:border-zinc-800")
              }
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={value.modules[m.key]}
                onChange={(e) => set({ modules: { ...value.modules, [m.key]: e.target.checked } })}
              />
              <span>
                <span className="block text-sm font-medium">{m.label}</span>
                <span className="block text-xs text-zinc-500">{m.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/** Fields with a usable key and label (blank rows dropped, keys unique). */
export function cleanFields(fields: JobField[]): JobField[] {
  const seen = new Set<string>();
  return fields
    .map((f) => ({ key: f.key || keyOf(f.label), label: f.label.trim() }))
    .filter((f) => f.key && f.label && !seen.has(f.key) && seen.add(f.key));
}
