"use client";

import { useState } from "react";
import { ConfigWizard } from "@/components/ConfigWizard";
import { GenericSourceList } from "@/components/aiconfig/GenericSourceList";

type Tab = "new" | "sources";

const TABS: [Tab, string][] = [
  ["new", "New scrape"],
  ["sources", "My sources"],
];

/**
 * Scrape-any-website hub. Client-side tab switcher over the ConfigWizard
 * (describe a site, approve the proposed config into a generic source) and
 * the workspace's generic sources. The AI provider key lives in Settings.
 */
export function AiConfigDashboard() {
  const [tab, setTab] = useState<Tab>("new");

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

      {tab === "new" && <ConfigWizard />}
      {tab === "sources" && (
        <GenericSourceList onNewScrape={() => setTab("new")} />
      )}
    </div>
  );
}
