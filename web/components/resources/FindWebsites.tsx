"use client";

import type { ResourceRow } from "@/lib/firestore/resources";
import { FinderForm, FinderResults, useFinder } from "./finder";

interface Props {
  /** Prefill for "what are you looking for" (e.g. the job's name). */
  defaultQuery?: string;
  /** Called with the resources saved to the library. */
  onAdded: (rows: ResourceRow[]) => void;
  onClose: () => void;
}

/**
 * Inline "Find websites" panel — form and results stacked in one box, for
 * places without a sidebar (a job's Sources tab). The New-job wizard and the
 * Resources page put <FinderForm> in the sidebar and <FinderResults> in the
 * main area instead.
 */
export function FindWebsites({ defaultQuery = "", onAdded, onClose }: Props) {
  const finder = useFinder({ defaultQuery });
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 p-4 space-y-5">
      <div className="flex justify-end -mb-3">
        <button type="button" onClick={onClose} className="text-xs text-zinc-500 hover:underline">
          Close
        </button>
      </div>
      <div className="max-w-xl">
        <FinderForm finder={finder} />
      </div>
      {(finder.result || finder.busy === "search") && (
        <FinderResults finder={finder} onAdded={onAdded} />
      )}
    </div>
  );
}
