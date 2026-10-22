"use client";

import { useState, type ReactNode } from "react";
import { SourceSection } from "./SourceSection";
import { addButtonClasses } from "./format";

/**
 * An empty section that stays one compact row until asked: besides its Add
 * action it offers a second button (e.g. "Attach from library…") that opens
 * the full section with `children` (rendered by the server page).
 */
export function ExpandableEmptySection({
  title,
  blurb,
  action,
  expandLabel,
  children,
}: {
  title: string;
  blurb: ReactNode;
  action: ReactNode;
  expandLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <SourceSection
        title={title}
        count={0}
        blurb={blurb}
        empty
        action={
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setOpen(true)} className={addButtonClasses}>
              {expandLabel}
            </button>
            {action}
          </div>
        }
      />
    );
  }
  return (
    <SourceSection title={title} count={0} blurb={blurb} action={action}>
      {children}
    </SourceSection>
  );
}
