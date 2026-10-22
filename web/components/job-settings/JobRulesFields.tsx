"use client";

import type { RelevanceRules, SaveTarget } from "@/lib/jobTemplates";

const inputCls =
  "w-full h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm shadow-xs";

const words = (s: string) =>
  s
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter(Boolean);

export interface JobRules {
  saves_to: SaveTarget[];
  relevance: RelevanceRules;
  use_ai: boolean;
  ai_spend_cap: number;
}

/**
 * A job's relevance rules, the databases it saves into, and its AI switch —
 * on the job's Settings.
 */
export function JobRulesFields({
  value,
  onChange,
  databases,
}: {
  value: JobRules;
  onChange: (v: JobRules) => void;
  databases: { id: string; name: string }[];
}) {
  const set = (patch: Partial<JobRules>) => onChange({ ...value, ...patch });
  const rel = value.relevance;
  const setRel = (patch: Partial<RelevanceRules>) => set({ relevance: { ...rel, ...patch } });
  const unused = databases.filter((d) => !value.saves_to.some((t) => t.database === d.id));
  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Relevance</legend>
        <p className="text-xs text-zinc-500 -mt-1">
          Each result gets a score from 0 to 100 against these words (title, company, description, every
          field). Results below the cutoff are hidden in Results — not deleted.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="block text-xs text-zinc-500 mb-1">Relevant if it mentions any of (comma-separated)</span>
            <textarea
              rows={3}
              defaultValue={rel.include.join(", ")}
              onBlur={(e) => setRel({ include: words(e.target.value) })}
              placeholder="NEBOSH, IOSH, HSE, safety officer, ISO 45001"
              className={inputCls + " h-auto py-2"}
            />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-zinc-500 mb-1">Not relevant if it mentions any of</span>
            <textarea
              rows={3}
              defaultValue={rel.exclude.join(", ")}
              onBlur={(e) => setRel({ exclude: words(e.target.value) })}
              placeholder="driving school, cooking, martial arts"
              className={inputCls + " h-auto py-2"}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            Hide below
            <input
              type="number"
              min={0}
              max={100}
              value={rel.cutoff}
              onChange={(e) => setRel({ cutoff: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
              className="w-20 h-9 px-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
            />
            <span className="text-xs text-zinc-500">(0 = show everything)</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={rel.use_ai} onChange={(e) => setRel({ use_ai: e.target.checked })} />
            Ask the AI about borderline results
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Saves into databases</legend>
        <p className="text-xs text-zinc-500 -mt-1">
          After each run, new and changed results go into these databases (committed to git, shared by every job
          that reads them).
        </p>
        {value.saves_to.map((t, i) => (
          <div key={t.database} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2 text-sm">
            <span className="font-medium min-w-32">{databases.find((d) => d.id === t.database)?.name ?? t.database}</span>
            <label className="flex items-center gap-1.5 text-xs text-zinc-500">
              only tagged
              <input
                defaultValue={(t.only_tags ?? []).join(", ")}
                onBlur={(e) =>
                  set({ saves_to: value.saves_to.map((x, j) => (j === i ? { ...x, only_tags: words(e.target.value) } : x)) })
                }
                placeholder="any"
                className="h-8 w-40 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-zinc-500">
              relevance ≥
              <input
                type="number"
                min={0}
                max={100}
                defaultValue={t.min_relevance ?? ""}
                onBlur={(e) =>
                  set({
                    saves_to: value.saves_to.map((x, j) =>
                      j === i ? { ...x, min_relevance: e.target.value === "" ? undefined : Number(e.target.value) } : x
                    ),
                  })
                }
                className="h-8 w-16 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
              />
            </label>
            <button
              type="button"
              onClick={() => set({ saves_to: value.saves_to.filter((_, j) => j !== i) })}
              className="ml-auto text-xs text-zinc-500 hover:text-red-600"
            >
              Remove
            </button>
          </div>
        ))}
        {unused.length > 0 ? (
          <select
            aria-label="Add a database to save into"
            value=""
            onChange={(e) => e.target.value && set({ saves_to: [...value.saves_to, { database: e.target.value }] })}
            className="h-9 px-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
          >
            <option value="">+ Save into a database…</option>
            {unused.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        ) : (
          value.saves_to.length === 0 && <p className="text-xs text-zinc-500">Create a database under Databases first.</p>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">AI</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={value.use_ai} onChange={(e) => set({ use_ai: e.target.checked })} />
          <span>
            Use AI in this job
            <span className="block text-xs text-zinc-500">
              Off by default. Used for borderline relevance and AI tagging, on the key in Settings.
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          Spend at most $
          <input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={value.ai_spend_cap}
            onChange={(e) => set({ ai_spend_cap: Math.max(0, Number(e.target.value) || 0) })}
            className="w-24 h-9 px-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
          />
          per run <span className="text-xs text-zinc-500">(0 = no cap)</span>
        </label>
      </fieldset>
    </div>
  );
}
