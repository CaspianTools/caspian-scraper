"use client";

import { JOB_TEMPLATES, TEMPLATE_INFO, type JobTemplate } from "@/lib/jobTemplates";

const ICONS: Record<JobTemplate, React.ReactNode> = {
  vacancies: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18" />
    </>
  ),
  cars: (
    <>
      <path d="M5 16V11l2-5h10l2 5v5M5 16h14M5 16v2M19 16v2M3 11h18" />
      <circle cx="8" cy="13.5" r=".5" />
      <circle cx="16" cy="13.5" r=".5" />
    </>
  ),
  prices: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  blank: (
    <path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z" />
  ),
};

export function JobTemplateIcon({ template, className = "w-5 h-5" }: { template: JobTemplate; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[template]}
    </svg>
  );
}

/** "Start from" — one card per template (it only pre-fills the job). */
export function JobTemplatePicker({
  value,
  onChange,
  compact = false,
}: {
  value: JobTemplate;
  onChange: (t: JobTemplate) => void;
  /** Two columns, no blurbs (for popups). */
  compact?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Start from a template" className={"grid gap-2 " + (compact ? "grid-cols-2" : "sm:grid-cols-2")}>
      {JOB_TEMPLATES.map((k) => {
        const on = value === k;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(k)}
            className={
              "flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors " +
              (on
                ? "border-brand-500 ring-1 ring-brand-500 bg-brand-50/50 dark:bg-brand-500/10"
                : "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 hover:border-zinc-300 dark:hover:border-zinc-700")
            }
          >
            <span
              className={
                "w-8 h-8 shrink-0 rounded-lg flex items-center justify-center " +
                (on ? "bg-brand-600 text-white dark:bg-brand-500" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400")
              }
            >
              <JobTemplateIcon template={k} className="w-4 h-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{TEMPLATE_INFO[k].label}</span>
              {!compact && <span className="block text-xs text-zinc-500">{TEMPLATE_INFO[k].blurb}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
