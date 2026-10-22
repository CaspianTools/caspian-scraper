"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ResourceRow } from "@/lib/firestore/resources";
import { FinderForm, FinderResults, useFinder } from "@/components/resources/finder";
import { SharedResourcesPanel } from "@/components/resources/SharedResourcesPanel";

interface Props {
  job: { id: string; name: string; resource_ids: string[] };
  /** Prefill for the search (the job's description). */
  defaultQuery: string;
  /** The whole shared library (for the job's websites and attach / detach). */
  library: ResourceRow[];
}

/**
 * A job's Discover page: two tabs in the main area (the job layout has the
 * sidebar). "Find websites" stacks the search form and its results; the main
 * bulk action is "Add to this job" (careers pages found, saved to the
 * library, attached to this job). "This job's websites" lists the library
 * websites attached to it, with attach / detach.
 */
export function DiscoverWorkspace({ job, defaultQuery, library }: Props) {
  const router = useRouter();
  const finder = useFinder({ defaultQuery });
  const [tab, setTab] = useState<"find" | "job">("find");

  return (
    <div className="space-y-5">
      <div className="inline-flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
        {(
          [
            ["find", `Find websites${finder.result ? ` (${finder.all.length})` : ""}`],
            ["job", `This job's websites (${job.resource_ids.length})`],
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

      {tab === "find" ? (
        <>
          <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 shadow-card">
            <div className="max-w-xl">
              <FinderForm finder={finder} />
            </div>
          </section>
          <FinderResults
            finder={finder}
            job={job}
            onAdded={() => router.refresh()}
            emptyHint="Describe the companies or websites you're looking for and press Search. Pick the ones you want and use Add to this job."
          />
        </>
      ) : (
        <SharedResourcesPanel projectId={job.id} library={library} attachedIds={job.resource_ids} ownSourcesCount={0} />
      )}
    </div>
  );
}
