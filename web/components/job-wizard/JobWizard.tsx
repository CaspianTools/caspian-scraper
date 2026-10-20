"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/firebase/clientFetch";
import type { ResourceRow } from "@/lib/firestore/resources";
import { ResourcePicker } from "@/components/resources/ResourcePicker";

interface Props {
  resources: ResourceRow[];
}

const STEPS = ["Basics", "Resources", "Review"] as const;
type Step = 0 | 1 | 2;
const LAST: Step = 2;

// Which step owns each server-side field, so a 400 jumps to the right place.
const FIELD_STEP: Record<string, Step> = {
  name: 0,
  description: 0,
  resource_ids: 1,
};

// Jobs run from Start.bat / "Run now" on this computer; there is no cron
// while the app runs locally. A schedule is still stored (the schema needs
// one) so the job is ready if a scheduled runner comes back — it can be
// changed under the job's Settings.
const DEFAULT_SCHEDULE = "0 */6 * * *";

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400";
const primaryBtn =
  "inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200";
const secondaryBtn =
  "inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50";

export function JobWizard({ resources: initialResources }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(0);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [library, setLibrary] = useState<ResourceRow[]>(initialResources);
  const [resourceIds, setResourceIds] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Step, string>>>({});

  const chosen = library.filter((r) => resourceIds.includes(r.id));

  /** Blocking problem on a step, or null when it's OK to continue. */
  function problem(s: Step): string | null {
    if (s === 0 && !name.trim()) return "Give the job a name.";
    return null;
  }

  function goNext() {
    const p = problem(step);
    setErrors((e) => ({ ...e, [step]: p ?? undefined }));
    if (!p && step < LAST) setStep((step + 1) as Step);
  }

  /** Steps are clickable once everything before them is valid. */
  function canReach(target: Step): boolean {
    for (let s = 0; s < target; s++) if (problem(s as Step)) return false;
    return true;
  }

  async function create() {
    setBusy(true);
    setErrors({});
    try {
      const res = await authedFetch("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          schedule_cron: DEFAULT_SCHEDULE,
          enabled: true,
          hse_keywords: [],
          resource_ids: resourceIds,
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (Array.isArray(b.details) && b.details.length > 0) {
          const first = b.details[0] as { path?: string[]; message: string };
          const target = FIELD_STEP[first.path?.[0] ?? ""] ?? LAST;
          setErrors({ [target]: first.message });
          setStep(target);
        } else if (res.status === 429) {
          setErrors({ [LAST]: `Job quota reached (${b.used}/${b.max}).` });
        } else {
          setErrors({ [LAST]: b.error || `Request failed (${res.status})` });
        }
        return;
      }
      router.push(`/projects/${b.id}`);
      router.refresh();
    } catch (e) {
      setErrors({ [LAST]: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <ol className="grid grid-cols-3 gap-2">
        {STEPS.map((label, i) => {
          const s = i as Step;
          const state = s === step ? "current" : s < step ? "done" : "todo";
          return (
            <li key={label}>
              <button
                type="button"
                disabled={!canReach(s) || busy}
                onClick={() => setStep(s)}
                className="w-full text-left group disabled:cursor-not-allowed"
              >
                <span
                  className={
                    "block h-1 rounded-full mb-2 " +
                    (state === "todo"
                      ? "bg-zinc-200 dark:bg-zinc-800"
                      : "bg-zinc-900 dark:bg-zinc-100")
                  }
                />
                <span
                  className={
                    "text-xs sm:text-sm " +
                    (state === "current"
                      ? "font-semibold text-zinc-900 dark:text-zinc-100"
                      : "text-zinc-500 group-enabled:group-hover:text-zinc-800 dark:group-enabled:group-hover:text-zinc-200")
                  }
                >
                  <span className="hidden sm:inline">{i + 1}. </span>
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-5">
        {step === 0 && (
          <>
            <StepHeading
              title="What is this job?"
              hint="A job is one scraping pipeline: a set of websites to scrape. Everything it finds is listed under the job's Findings for you to review."
            />
            <div>
              <label className="block text-sm font-medium mb-1">Name</label>
              <input
                type="text"
                autoFocus
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && goNext()}
                placeholder="HSE Jobs Middle East"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                Description <span className="text-zinc-500 font-normal">(optional)</span>
              </label>
              <textarea
                rows={3}
                maxLength={500}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this job looking for?"
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              />
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <StepHeading
              title="Which websites should it scrape?"
              hint="Pick from the shared library — a resource can belong to any number of jobs, and edits to it apply everywhere. Add new ones here and they join the library too."
            />
            <ResourcePicker
              resources={library}
              selected={resourceIds}
              onChange={setResourceIds}
              suggestQuery={[name.trim(), description.trim()].filter(Boolean).join(" — ")}
              onCreated={(row) =>
                setLibrary((l) => [...l, row].sort((a, b) => a.name.localeCompare(b.name)))
              }
            />
            {resourceIds.length === 0 && (
              <p className="text-xs text-zinc-500">
                You can continue with none and attach resources later from the
                job&apos;s Sources tab.
              </p>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <StepHeading
              title="Review and create"
              hint="After creating it, start a run from the job's Runs tab (or Start.bat) and review the results under Findings."
            />
            <dl className="divide-y divide-zinc-100 dark:divide-zinc-800 text-sm">
              <ReviewRow label="Name" onEdit={() => setStep(0)}>
                {name.trim()}
                {description.trim() && (
                  <span className="block text-zinc-500">{description.trim()}</span>
                )}
              </ReviewRow>
              <ReviewRow label="Resources" onEdit={() => setStep(1)}>
                {chosen.length === 0 ? (
                  <span className="text-zinc-500">None yet</span>
                ) : (
                  <>
                    {chosen.length} website{chosen.length === 1 ? "" : "s"}
                    <span className="block text-zinc-500">
                      {chosen.slice(0, 8).map((r) => r.name).join(", ")}
                      {chosen.length > 8 && `, +${chosen.length - 8} more`}
                    </span>
                  </>
                )}
              </ReviewRow>
            </dl>
          </>
        )}

        {errors[step] && <p className="text-sm text-red-600">{errors[step]}</p>}
      </section>

      <div className="flex items-center justify-between">
        {step === 0 ? (
          <Link href="/" className={secondaryBtn}>
            Cancel
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => setStep((step - 1) as Step)}
            disabled={busy}
            className={secondaryBtn}
          >
            ← Back
          </button>
        )}
        {step < LAST ? (
          <button type="button" onClick={goNext} className={primaryBtn}>
            Next →
          </button>
        ) : (
          <button type="button" onClick={create} disabled={busy} className={primaryBtn}>
            {busy ? "Creating…" : "Create job"}
          </button>
        )}
      </div>
    </div>
  );
}

function StepHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      {hint && <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">{hint}</p>}
    </div>
  );
}

function ReviewRow({
  label,
  onEdit,
  children,
}: {
  label: string;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="w-28 shrink-0 text-zinc-500">{label}</dt>
      <dd className="flex-1 min-w-0">{children}</dd>
      <button
        type="button"
        onClick={onEdit}
        className="text-xs text-zinc-600 dark:text-zinc-400 hover:underline shrink-0"
      >
        Edit
      </button>
    </div>
  );
}
