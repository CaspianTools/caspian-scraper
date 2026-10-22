/**
 * The New-job wizard's unfinished draft, kept in this browser so leaving the
 * page (or reloading) doesn't lose it. Cleared when the job is created or the
 * wizard is cancelled. The wizard's search results are kept separately by
 * useFinder (components/resources/finder.tsx).
 */

import { jobTemplate, type JobTemplate } from "@/lib/jobTemplates";
import type { JobSetup } from "@/components/job-settings/JobSetupFields";

export const DRAFT_KEY = "caspian.jobwizard.draft";

export interface JobDraft {
  template: JobTemplate;
  /** What it collects (null in drafts from before this step existed). */
  setup: JobSetup | null;
  step: 0 | 1 | 2 | 3;
  name: string;
  description: string;
  resourceIds: string[];
  tab: "results" | "library";
}

const OLD_KIND: Record<string, JobTemplate> = { cars: "cars", prices: "prices", data: "blank" };

export function loadDraft(): JobDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (typeof d !== "object" || d === null) return null;
    const setup = d.setup && typeof d.setup === "object" && Array.isArray(d.setup.fields) ? (d.setup as JobSetup) : null;
    return {
      template: d.template ? jobTemplate(d.template) : (OLD_KIND[d.kind] ?? "vacancies"),
      setup,
      step: [1, 2, 3].includes(d.step) ? d.step : 0,
      name: typeof d.name === "string" ? d.name : "",
      description: typeof d.description === "string" ? d.description : "",
      resourceIds: Array.isArray(d.resourceIds) ? d.resourceIds.filter((x: unknown) => typeof x === "string") : [],
      tab: d.tab === "library" ? "library" : "results",
    };
  } catch {
    return null;
  }
}

/** Saves the draft, or clears it when there's nothing in it yet. */
export function saveDraft(d: JobDraft) {
  try {
    if (!d.name.trim() && !d.description.trim() && d.resourceIds.length === 0 && d.step === 0) {
      localStorage.removeItem(DRAFT_KEY);
    } else {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    }
  } catch {
    /* storage unavailable — the draft just isn't kept */
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
