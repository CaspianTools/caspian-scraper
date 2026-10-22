"use client";

import { SidebarNav } from "@/components/shell/SidebarNav";
import type { JobNavItem } from "@/lib/jobTemplates";

/** A job's section nav (lib/jobTemplates.ts jobNav), in the job layout's sidebar. */
export function ProjectNav({ items }: { items: JobNavItem[] }) {
  return <SidebarNav label="Job" items={items} />;
}
