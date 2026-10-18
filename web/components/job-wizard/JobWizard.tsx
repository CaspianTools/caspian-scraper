"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/firebase/clientFetch";
import { humanizeCron } from "@/lib/cron/humanize";
import type { ResourceRow } from "@/lib/firestore/resources";
import { SchedulePicker } from "@/components/SchedulePicker";
import { ResourcePicker } from "@/components/resources/ResourcePicker";

export interface DestinationSourceJob {
  id: string;
  name: string;
  destinations: string[];
}

interface Props {
  resources: ResourceRow[];
  /** Existing jobs that have at least one destination to copy. */
  jobsWithDestinations: DestinationSourceJob[];
}

const STEPS = ["Basics", "Resources", "Destination", "Schedule", "Review"] as const;
type Step = 0 | 1 | 2 | 3 | 4;

// Which step owns each server-side field, so a 400 jumps to the right place.
const FIELD_STEP: Record<string, Step> = {
  name: 0,
  description: 0,
  resource_ids: 1,
  copy_destinations_from: 2,
  schedule_cron: 3,
};

// Mirrors CronExpressionSchema in lib/firestore/schema.ts: 5 fields and a
// fixed minute (≥1h granularity).
function cronError(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "A schedule needs 5 cron fields.";
  if (!/^\d{1,2}$/.test(parts[0]) || parseInt(parts[0], 10) > 59) {
    return "Runs at most once an hour — the minute must be a fixed number.";
  }
  return null;
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400";
const primaryBtn =
  "inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200";
const secondaryBtn =
  "inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50";

export function JobWizard({ resources: initialResources, jobsWithDestinations }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(0);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [library, setLibrary] = useState<ResourceRow[]>(initialResources);
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [destMode, setDestMode] = useState<"copy" | "later">(
    jobsWithDestinations.length > 0 ? "copy" : "later"
  );
  const [copyFrom, setCopyFrom] = useState(jobsWithDestinations[0]?.id ?? "");
  const [scheduleCron, setScheduleCron] = useState("0 */6 * * *");
  const [enabled, setEnabled] = useState(true);

  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Step, string>>>({});

  const copyJob = jobsWithDestinations.find((j) => j.id === copyFrom);
  const chosen = library.filter((r) => resourceIds.includes(r.id));

  /** Blocking problem on a step, or null when it's OK to continue. */
  function problem(s: Step): string | null {
    if (s === 0 && !name.trim()) return "Give the job a name.";
    if (s === 2 && destMode === "copy" && !copyJob) return "Pick a job to copy from.";
    if (s === 3) return cronError(scheduleCron);
    return null;
  }

  function goNext() {
    const p = problem(step);
    setErrors((e) => ({ ...e, [step]: p ?? undefined }));
    if (!p && step < 4) setStep((step + 1) as Step);
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
          schedule_cron: scheduleCron.trim(),
          enabled,
          hse_keywords: [],
          resource_ids: resourceIds,
          ...(destMode === "copy" && copyJob
            ? { copy_destinations_from: copyJob.id }
            : {}),
        }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (Array.isArray(b.details) && b.details.length > 0) {
          const first = b.details[0] as { path?: string[]; message: string };
          const target = FIELD_STEP[first.path?.[0] ?? ""] ?? 4;
          setErrors({ [target]: first.message });
          setStep(target);
        } else if (res.status === 429) {
          setErrors({ 4: `Job quota reached (${b.used}/${b.max}).` });
        } else {
          setErrors({ 4: b.error || `Request failed (${res.status})` });
        }
        return;
      }
      router.push(`/projects/${b.id}`);
      router.refresh();
    } catch (e) {
      setErrors({ 4: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <ol className="grid grid-cols-5 gap-2">
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
              hint="A job is one scraping pipeline: a set of websites, where to publish what it finds, and a schedule."
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
                placeholder="What does this job publish, and where?"
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
              onCreated={(row) => setLibrary((l) => [...l, row].sort((a, b) => a.name.localeCompare(b.name)))}
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
              title="Where should it publish?"
              hint="A destination is the API each new finding is POSTed to."
            />
            <div className="space-y-3">
              <Choice
                checked={destMode === "copy"}
                disabled={jobsWithDestinations.length === 0}
                onSelect={() => setDestMode("copy")}
                title="Copy from an existing job"
                hint={
                  jobsWithDestinations.length === 0
                    ? "No job has a destination yet."
                    : "Copies its destinations and the API keys they use, so this job can publish straight away."
                }
              >
                {destMode === "copy" && jobsWithDestinations.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <select
                      value={copyFrom}
                      onChange={(e) => setCopyFrom(e.target.value)}
                      className={inputCls}
                    >
                      {jobsWithDestinations.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.name}
                        </option>
                      ))}
                    </select>
                    {copyJob && (
                      <p className="text-xs text-zinc-500">
                        Will copy: {copyJob.destinations.join(", ")}
                      </p>
                    )}
                  </div>
                )}
              </Choice>
              <Choice
                checked={destMode === "later"}
                onSelect={() => setDestMode("later")}
                title="Set up later"
                hint="Add a destination from the job's Destinations tab. Runs report “no destinations configured” until you do."
              />
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <StepHeading
              title="When should it run?"
              hint="Times are UTC. Jobs run at most once an hour."
            />
            <SchedulePicker value={scheduleCron} onChange={setScheduleCron} />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="w-4 h-4"
              />
              Start running on this schedule right away
            </label>
          </>
        )}

        {step === 4 && (
          <>
            <StepHeading title="Review and create" />
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
              <ReviewRow label="Destination" onEdit={() => setStep(2)}>
                {destMode === "copy" && copyJob ? (
                  <>
                    Copied from {copyJob.name}
                    <span className="block text-zinc-500">
                      {copyJob.destinations.join(", ")}
                    </span>
                  </>
                ) : (
                  <span className="text-zinc-500">Set up later</span>
                )}
              </ReviewRow>
              <ReviewRow label="Schedule" onEdit={() => setStep(3)}>
                {humanizeCron(scheduleCron)}{" "}
                <span className="text-zinc-500">
                  ({enabled ? "enabled" : "paused"})
                </span>
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
        {step < 4 ? (
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

function Choice({
  checked,
  disabled,
  onSelect,
  title,
  hint,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={
        "rounded-xl border p-4 " +
        (checked
          ? "border-zinc-900 dark:border-zinc-100"
          : "border-zinc-200 dark:border-zinc-800") +
        (disabled ? " opacity-60" : "")
      }
    >
      <label className={"flex items-start gap-3 " + (disabled ? "cursor-not-allowed" : "cursor-pointer")}>
        <input
          type="radio"
          checked={checked}
          disabled={disabled}
          onChange={onSelect}
          className="w-4 h-4 mt-0.5"
        />
        <span>
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-zinc-500 mt-0.5">{hint}</span>
        </span>
      </label>
      {children}
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
