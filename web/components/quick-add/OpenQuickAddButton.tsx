"use client";

import { useQuickAdd } from "./QuickAddProvider";
import type { QuickAddItemKind } from "./types";

interface Props {
  kind?: QuickAddItemKind;
  projectId?: string;
  /** "primary" matches the existing solid black/white CTA. "secondary"
   *  is the bordered/ghost button used for in-empty-state and small CTAs. */
  variant?: "primary" | "secondary";
  size?: "md" | "sm";
  children: React.ReactNode;
  className?: string;
}

export function OpenQuickAddButton({
  kind,
  projectId,
  variant = "primary",
  size = "md",
  children,
  className,
}: Props) {
  const { open } = useQuickAdd();

  const base =
    "inline-flex items-center rounded-lg text-sm font-medium transition-colors disabled:opacity-50";
  const sizing = size === "sm" ? "h-9 px-4" : "h-10 px-4";
  const variantClasses =
    variant === "primary"
      ? "bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      : "border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900";

  return (
    <button
      type="button"
      onClick={() => open({ kind, projectId })}
      className={[base, sizing, variantClasses, className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </button>
  );
}
