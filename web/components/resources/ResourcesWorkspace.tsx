"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ResourceRow } from "@/lib/firestore/resources";
import { SidebarHeader, SidebarLayout } from "@/components/shell/SidebarLayout";
import { FinderForm, FinderResults, useFinder } from "./finder";
import { ResourceLibrary } from "./ResourceLibrary";

/**
 * /resources: Find websites in the sidebar; the main area switches between
 * the shared library and the latest search results (list or cards).
 */
export function ResourcesWorkspace({ resources }: { resources: ResourceRow[] }) {
  const router = useRouter();
  const finder = useFinder();
  const [tab, setTab] = useState<"library" | "results">(resources.length > 0 ? "library" : "results");

  return (
    <SidebarLayout
      sidebar={
        <>
          <SidebarHeader
            title="Resources"
            subtitle={`Websites to scrape, shared across jobs.${
              resources.length > 0 ? ` ${resources.length} in the library.` : ""
            }`}
          />
          <div className="border-t border-zinc-200 dark:border-zinc-800 pt-5">
            <FinderForm finder={finder} onSearch={() => setTab("results")} />
          </div>
        </>
      }
    >
      <div className="inline-flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
        {(
          [
            ["library", `Library (${resources.length})`],
            ["results", `Search results${finder.result ? ` (${finder.all.length})` : ""}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
            className={
              "h-8 px-3 text-sm rounded-md " +
              (tab === key
                ? "bg-white dark:bg-zinc-800 shadow-sm font-medium"
                : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "library" ? (
        <ResourceLibrary resources={resources} hideFind />
      ) : (
        <FinderResults
          finder={finder}
          onAdded={() => router.refresh()}
          allowAddToJob
          emptyHint="Describe what you're looking for in the sidebar and press Search. Results appear here as cards or a list."
        />
      )}
    </SidebarLayout>
  );
}
