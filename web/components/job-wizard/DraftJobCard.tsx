"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { clearDraft, loadDraft, type JobDraft } from "./draft";
import { TEMPLATE_INFO } from "@/lib/jobTemplates";

const STEP_LABEL = ["Basics", "What to collect", "Websites", "Review"];

/** On the Jobs page: the unfinished New-job draft, if there is one. */
export function DraftJobCard() {
  const [draft, setDraft] = useState<JobDraft | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the browser-kept draft once
    setDraft(loadDraft());
  }, []);
  if (!draft) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-brand-200 dark:border-brand-400/30 bg-brand-50/60 dark:bg-brand-500/5 px-5 py-4 shadow-card">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
          Unfinished job{draft.name.trim() ? `: ${draft.name.trim()}` : ""}
        </p>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          {TEMPLATE_INFO[draft.template].label} · not created yet · stopped at {STEP_LABEL[draft.step]}
          {draft.resourceIds.length > 0 &&
            ` · ${draft.resourceIds.length} website${draft.resourceIds.length === 1 ? "" : "s"} picked`}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          clearDraft();
          setDraft(null);
        }}
        className="text-xs text-zinc-500 hover:text-red-600 hover:underline"
      >
        Discard
      </button>
      <Link
        href="/projects/new"
        className="inline-flex items-center h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 dark:bg-brand-500 dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
      >
        Continue →
      </Link>
    </div>
  );
}
