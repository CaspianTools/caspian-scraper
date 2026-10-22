"use client";

import { SidebarNav } from "@/components/shell/SidebarNav";
import { jobNav, type JobKind } from "@/lib/jobKinds";

/** A job's section nav, shown in the job layout's sidebar — by job type. */
export function ProjectNav({ projectId, kind }: { projectId: string; kind: JobKind }) {
  return <SidebarNav label="Job" items={jobNav(projectId, kind)} />;
}
