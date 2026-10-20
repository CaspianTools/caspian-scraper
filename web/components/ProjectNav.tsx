"use client";

import { SidebarNav } from "@/components/shell/SidebarNav";

/** A job's section nav, shown in the job layout's sidebar. */
export function ProjectNav({ projectId }: { projectId: string }) {
  const base = `/projects/${projectId}`;
  return (
    <SidebarNav
      label="Job"
      items={[
        { href: base, label: "Overview", exact: true },
        { href: `${base}/sources`, label: "Sources" },
        { href: `${base}/runs`, label: "Runs" },
        { href: `${base}/findings`, label: "Findings" },
        { href: `${base}/lessons`, label: "Lessons" },
        { href: `${base}/settings`, label: "Settings" },
      ]}
    />
  );
}
