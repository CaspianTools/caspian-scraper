"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import type { ResourceRow } from "@/lib/firestore/resources";
import { ResourcePicker } from "@/components/resources/ResourcePicker";
import { FinderForm, FinderResults, useFinder } from "@/components/resources/finder";
import { SidebarHeader, SidebarLayout } from "@/components/shell/SidebarLayout";
import { clearDraft, loadDraft, saveDraft } from "./draft";
import { JobTemplatePicker } from "@/components/JobTemplatePicker";
import { JobSetupFields, cleanFields, type JobSetup } from "@/components/job-settings/JobSetupFields";
import { TEMPLATE_INFO, jobFirstStep, type JobTemplate } from "@/lib/jobTemplates";

interface Props {
  resources: ResourceRow[];
}

const STEPS = [
  { label: "Basics", hint: "Template, name, description" },
  { label: "What to collect", hint: "Record name, fields, modules" },
  { label: "Websites", hint: "Careers pages to scrape" },
  { label: "Review", hint: "Check and create" },
] as const;
type Step = 0 | 1 | 2 | 3;
const LAST: Step = 3;

// Which step owns each server-side field, so a 400 jumps to the right place.
const FIELD_STEP: Record<string, Step> = {
  name: 0,
  description: 0,
  template: 0,
  record_label: 1,
  fields: 1,
  modules: 1,
  resource_ids: 2,
};

/** What a template pre-fills. */
function setupOf(t: JobTemplate): JobSetup {
  const info = TEMPLATE_INFO[t];
  return { record_label: { ...info.record_label }, fields: info.fields.map((f) => ({ ...f })), modules: { ...info.modules } };
}

// Jobs run from Start.bat / "Run now" on this computer; there is no cron
// while the app runs locally. A schedule is still stored (the schema needs
// one) so the job is ready if a scheduled runner comes back — it can be
// changed under the job's Settings.
const DEFAULT_SCHEDULE = "0 */6 * * *";

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs";
const primaryBtn =
  "inline-flex items-center h-10 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20";
const secondaryBtn =
  "inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 bg-white dark:bg-zinc-900 shadow-xs font-medium";

/**
 * Step-by-step job creation in a SidebarLayout: start from a template (it only
 * pre-fills), say what one result is called, its fields and modules, then —
 * for a vacancy-style job — pick its careers pages (the sidebar holds the Find
 * websites search on that step; the main area the results and the shared
 * library, as tabs). Other sources (classifieds, shops, any website,
 * databases) are added on the job's Sources after creating. The unfinished
 * draft is kept in this browser (./draft.ts).
 */
export function JobWizard({ resources: initialResources }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(0);
  const [template, setTemplate] = useState<JobTemplate>("vacancies");
  const [setup, setSetup] = useState<JobSetup>(() => setupOf("vacancies"));
  // Careers pages are picked here for a vacancy-style job; every other kind
  // of source is added on the job's Sources after creating.
  const steps: Step[] = template === "vacancies" ? [0, 1, 2, 3] : [0, 1, 3];
  const nextStep = (s: Step) => steps[steps.indexOf(s) + 1] as Step | undefined;
  const prevStep = (s: Step) => steps[steps.indexOf(s) - 1] as Step | undefined;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [library, setLibrary] = useState<ResourceRow[]>(initialResources);
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [tab, setTab] = useState<"results" | "library">(initialResources.length > 0 ? "library" : "results");

  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Step, string>>>({});

  const finder = useFinder({ defaultQuery: "" });

  // Restore the unfinished draft, then keep it saved as it changes (not
  // before the restore has landed, and not once the job is created/cancelled).
  const [ready, setReady] = useState(false);
  const leaving = useRef(false);
  useEffect(() => {
    const d = loadDraft();
    if (d) {
      /* eslint-disable react-hooks/set-state-in-effect -- one-time restore of the saved draft */
      setTemplate(d.template);
      setSetup(d.setup ?? setupOf(d.template));
      setName(d.name);
      setDescription(d.description);
      setResourceIds(d.resourceIds);
      setTab(d.tab);
      setStep(d.name.trim() && (d.template === "vacancies" || d.step !== 2) ? d.step : 0);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready && !leaving.current) saveDraft({ template, setup, step, name, description, resourceIds, tab });
  }, [ready, template, setup, step, name, description, resourceIds, tab]);
  const chosen = library.filter((r) => resourceIds.includes(r.id));

  /** Blocking problem on a step, or null when it's OK to continue. */
  function problem(s: Step): string | null {
    if (s === 0 && !name.trim()) return "Give the job a name.";
    if (s === 1 && (!setup.record_label.singular.trim() || !setup.record_label.plural.trim()))
      return "Say what one result is called (and several).";
    if (s === 1 && cleanFields(setup.fields).length === 0) return "Give it at least one field.";
    return null;
  }

  function goTo(target: Step) {
    if (target === 2 && step < 2 && !finder.query) {
      // Prefill the search with what the job is about.
      finder.setQuery([name.trim(), description.trim()].filter(Boolean).join(" — "));
    }
    setStep(target);
  }

  function goNext() {
    const p = problem(step);
    setErrors((e) => ({ ...e, [step]: p ?? undefined }));
    const n = nextStep(step);
    if (!p && n !== undefined) goTo(n);
  }

  /** Steps are clickable once everything before them is valid. */
  function canReach(target: Step): boolean {
    for (let s = 0; s < target; s++) if (problem(s as Step)) return false;
    return true;
  }

  function addToLibrary(rows: ResourceRow[]) {
    setLibrary((l) => [...l, ...rows].sort((a, b) => a.name.localeCompare(b.name)));
    setResourceIds((ids) => Array.from(new Set([...ids, ...rows.map((r) => r.id)])));
  }

  async function create() {
    setBusy(true);
    setErrors({});
    try {
      const res = await apiFetch("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          template,
          record_label: { singular: setup.record_label.singular.trim(), plural: setup.record_label.plural.trim() },
          fields: cleanFields(setup.fields),
          modules: setup.modules,
          description: description.trim(),
          schedule_cron: DEFAULT_SCHEDULE,
          enabled: true,
          hse_keywords: [],
          resource_ids: template === "vacancies" ? resourceIds : [],
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
      leaving.current = true; // don't re-save the draft on the way out
      clearDraft();
      router.push(template === "vacancies" && resourceIds.length > 0 ? `/projects/${b.id}` : jobFirstStep(b.id, template));
      router.refresh();
    } catch (e) {
      setErrors({ [LAST]: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const sidebar = (
    <>
      <SidebarHeader back={{ href: "/", label: "Jobs" }} title="New job" />
      <ol className="space-y-1">
        {steps.map((s, i) => {
          const st = STEPS[s];
          const state = s === step ? "current" : s < step ? "done" : "todo";
          return (
            <li key={st.label}>
              <button
                type="button"
                disabled={!canReach(s) || busy}
                onClick={() => goTo(s)}
                aria-current={state === "current" ? "step" : undefined}
                className={
                  "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left disabled:cursor-not-allowed " +
                  (state === "current" ? "bg-brand-50 dark:bg-brand-500/10" : "hover:bg-zinc-50 dark:hover:bg-zinc-900")
                }
              >
                <span
                  className={
                    "w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-xs font-medium " +
                    (state === "todo"
                      ? "border border-zinc-300 dark:border-zinc-700 text-zinc-500"
                      : "bg-brand-600 text-white shadow-sm shadow-brand-600/30 dark:bg-brand-500")
                  }
                >
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={"block text-sm " + (state === "current" ? "font-medium" : "")}>{st.label}</span>
                  <span className="block text-xs text-zinc-500">{st.hint}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {step === 2 && (
        <>
          <div className="rounded-lg bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-sm">
            <span className="font-medium">{resourceIds.length}</span> website
            {resourceIds.length === 1 ? "" : "s"} selected for this job
          </div>
          <div className="border-t border-zinc-200 dark:border-zinc-800 pt-5">
            <FinderForm finder={finder} onSearch={() => setTab("results")} />
          </div>
        </>
      )}
    </>
  );

  return (
    <SidebarLayout sidebar={sidebar}>
      {step === 0 && (
        <section className="max-w-2xl space-y-5">
          <StepHeading
            title="What is this job?"
            hint="A job is its own scraping project: what it collects and the websites it collects from. Everything it finds is listed in the job for you to review."
          />
          <div>
            <span className="block text-sm font-medium mb-1">Start from</span>
            <span className="block text-xs text-zinc-500 mb-2">A template only fills in the next step; you can change everything.</span>
            <JobTemplatePicker
              value={template}
              onChange={(t) => {
                setTemplate(t);
                setSetup(setupOf(t));
                if (!description.trim()) setDescription(TEMPLATE_INFO[t].description);
              }}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              autoFocus
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && goNext()}
              placeholder={TEMPLATE_INFO[template].example}
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
              placeholder="What is this job collecting, in plain words?"
              className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
            />
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="max-w-3xl space-y-5">
          <StepHeading
            title="What does it collect?"
            hint="Its results get these names and columns. Pre-filled from the template — change anything."
          />
          <JobSetupFields value={setup} onChange={setSetup} />
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <StepHeading
              title="Which websites should it scrape?"
              hint="Search with Find websites in the sidebar, or pick from the shared library. A resource can belong to any number of jobs."
            />
            <div className="inline-flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              {(
                [
                  ["results", `Search results${finder.result ? ` (${finder.all.length})` : ""}`],
                  ["library", `Library (${library.length})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={tab === key}
                  onClick={() => setTab(key)}
                  className={
                    "h-8 px-3 text-sm rounded-md " +
                    (tab === key
                      ? "bg-white dark:bg-zinc-800 shadow-sm font-medium"
                      : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {tab === "results" ? (
            <FinderResults
              finder={finder}
              onAdded={addToLibrary}
              emptyHint="Describe what you're looking for in the sidebar and press Search. Results appear here as cards or a list."
            />
          ) : (
            <ResourcePicker
              resources={library}
              selected={resourceIds}
              onChange={setResourceIds}
              hideFind
              onCreated={(row) => addToLibrary([row])}
            />
          )}
          {resourceIds.length === 0 && (
            <p className="text-xs text-zinc-500">
              You can continue with none and attach resources later from the job&apos;s Sources tab.
            </p>
          )}
        </section>
      )}

      {step === 3 && (
        <section className="max-w-3xl space-y-5">
          <StepHeading
            title="Review and create"
            hint={`After creating it, add or check its sources, press Run now, and review the ${setup.record_label.plural || "results"} it finds under Results.`}
          />
          <dl className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-5 divide-y divide-zinc-100 dark:divide-zinc-800 text-sm shadow-card">
            <ReviewRow label="Template" onEdit={() => goTo(0)}>
              {TEMPLATE_INFO[template].label}
            </ReviewRow>
            <ReviewRow label="Name" onEdit={() => goTo(0)}>
              {name.trim()}
              {description.trim() && <span className="block text-zinc-500">{description.trim()}</span>}
            </ReviewRow>
            <ReviewRow label="Collects" onEdit={() => goTo(1)}>
              {setup.record_label.plural}
              <span className="block text-zinc-500">
                {cleanFields(setup.fields).map((f) => f.label).join(", ")}
                {Object.entries(setup.modules).some(([, on]) => on) &&
                  ` · modules: ${Object.entries(setup.modules)
                    .filter(([, on]) => on)
                    .map(([k]) => ({ discovery: "Discover", follow_up: "Follow-up pages", compare: "Compare" })[k])
                    .join(", ")}`}
              </span>
            </ReviewRow>
            {template === "vacancies" && (
            <ReviewRow label="Websites" onEdit={() => goTo(2)}>
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
            )}
          </dl>
        </section>
      )}

      {errors[step] && <p className="text-sm text-red-600">{errors[step]}</p>}

      <div className="flex items-center justify-between border-t border-zinc-200 dark:border-zinc-800 pt-4">
        {step === 0 ? (
          <Link
            href="/"
            onClick={() => {
              leaving.current = true;
              clearDraft();
            }}
            className={secondaryBtn}
          >
            Cancel
          </Link>
        ) : (
          <button type="button" onClick={() => goTo(prevStep(step) ?? 0)} disabled={busy} className={secondaryBtn}>
            ← Back
          </button>
        )}
        {nextStep(step) !== undefined ? (
          <button type="button" onClick={goNext} className={primaryBtn}>
            Next →
          </button>
        ) : (
          <button type="button" onClick={create} disabled={busy} className={primaryBtn}>
            {busy ? "Creating…" : "Create job"}
          </button>
        )}
      </div>
    </SidebarLayout>
  );
}

function StepHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {hint && <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-3xl">{hint}</p>}
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
      <button type="button" onClick={onEdit} className="text-xs text-zinc-600 dark:text-zinc-400 hover:underline shrink-0">
        Edit
      </button>
    </div>
  );
}
