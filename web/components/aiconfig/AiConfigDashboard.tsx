"use client";

import { useState } from "react";
import { ConfigWizard } from "@/components/ConfigWizard";
import { GenericSourceList } from "@/components/aiconfig/GenericSourceList";
import { KeySettings } from "@/components/aiconfig/KeySettings";

type Tab = "new" | "sources" | "key";

const TABS: [Tab, string][] = [
  ["new", "New scrape"],
  ["sources", "My sources"],
  ["key", "API key"],
];

/**
 * AI-config hub. Client-side tab switcher over the three surfaces — the
 * existing ConfigWizard (unchanged), the workspace's generic sources, and the
 * write-only provider key settings. The parent page stays a server component
 * doing the auth guard; all interactivity lives here.
 *
 * `isSuperAdmin` comes from the server session. The API-key tab is still
 * rendered for admins so the restriction is discoverable rather than a missing
 * tab, but it shows an explanatory note instead of the form. Enforcement is in
 * the route (403), not here.
 */
export function AiConfigDashboard({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [tab, setTab] = useState<Tab>("new");

  return (
    <div className="space-y-6">
      <nav className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-2 flex flex-wrap gap-1">
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
      {tab === "key" && <KeySettings canManage={isSuperAdmin} />}
    </div>
  );
}
