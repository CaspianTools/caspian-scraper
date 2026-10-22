"use client";

import { useState } from "react";
import { ConfigWizard } from "@/components/ConfigWizard";
import { GenericSourceList } from "@/components/aiconfig/GenericSourceList";

export type DashboardTab = "new" | "sources";

const TABS: [DashboardTab, string][] = [
  ["sources", "Sources"],
  ["new", "New scrape"],
];

interface Props {
  /** The "Website data" job whose sources are listed and created. */
  projectId: string;
  initialTab?: DashboardTab;
}

/**
 * A "Website data" job's sources hub (/projects/[id]/data). Client-side tab
 * switcher over the job's generic sources and the ConfigWizard (describe a
 * site, approve the proposed config into a source of this job). The AI
 * provider key lives in Settings.
 */
export function AiConfigDashboard({ projectId, initialTab = "new" }: Props) {
  const [tab, setTab] = useState<DashboardTab>(initialTab);

  return (
    <div className="space-y-6">
      <nav className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-2 flex flex-wrap gap-1 shadow-card">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={
              "text-sm px-3 py-1.5 rounded-lg transition-colors " +
              (tab === value
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900")
            }
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "new" && <ConfigWizard projectId={projectId} />}
      {tab === "sources" && (
        <GenericSourceList
          projectId={projectId}
          onNewScrape={() => setTab("new")}
        />
      )}
    </div>
  );
}
