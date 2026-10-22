import type { ReactNode } from "react";

interface Props {
  title: string;
  count: number;
  /** One or two sentences: what this kind of source is and what a run does with it. */
  blurb: ReactNode;
  /** The section's "Add" button or link. */
  action: ReactNode;
  /** No sources of this kind: render one compact row (title, blurb, action). */
  empty?: boolean;
  children?: ReactNode;
}

/**
 * One kind of source on the job's Sources page: a heading with a short
 * explanation and an Add action, then the sources. Empty sections collapse
 * to a single dashed row so a job with one engine isn't buried in blanks.
 * No hooks — usable from server and client components alike.
 */
export function SourceSection({ title, count, blurb, action, empty, children }: Props) {
  if (empty) {
    return (
      <section className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-white/60 dark:bg-zinc-950/40 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm min-w-0">
          <span className="font-semibold tracking-tight">{title}</span>{" "}
          <span className="text-zinc-600 dark:text-zinc-400">— {blurb}</span>
        </p>
        {action}
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="max-w-2xl">
          <h3 className="text-lg font-semibold tracking-tight">
            {title} <span className="text-zinc-500 font-normal">({count})</span>
          </h3>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">{blurb}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
