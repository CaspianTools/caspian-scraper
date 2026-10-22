/**
 * The New-job wizard's unfinished draft, kept in this browser so leaving the
 * page (or reloading) doesn't lose it. Cleared when the job is created or the
 * wizard is cancelled. The wizard's search results are kept separately by
 * useFinder (components/resources/finder.tsx).
 */

import { jobKind, type JobKind } from "@/lib/jobKinds";

export const DRAFT_KEY = "caspian.jobwizard.draft";

export interface JobDraft {
  kind: JobKind;
  step: 0 | 1 | 2;
  name: string;
  description: string;
  resourceIds: string[];
  tab: "results" | "library";
}

export function loadDraft(): JobDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (typeof d !== "object" || d === null) return null;
    return {
      kind: jobKind(d.kind),
      step: d.step === 1 || d.step === 2 ? d.step : 0,
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
