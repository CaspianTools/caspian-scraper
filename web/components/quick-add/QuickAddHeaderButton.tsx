"use client";

import { OpenQuickAddButton } from "./OpenQuickAddButton";

export function QuickAddHeaderButton() {
  return (
    <OpenQuickAddButton size="sm" className="px-3">
      <span aria-hidden className="mr-1">+</span>New
    </OpenQuickAddButton>
  );
}
