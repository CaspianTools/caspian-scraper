"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { FinderResults, useFinder } from "@/components/resources/finder";

/**
 * /db — the whole findings database (db/companies.jsonl): every company Find
 * websites has saved, with the same filters, sort, views and bulk actions as
 * search results (country / category / source / careers-page status, text
 * search, show hidden). Loaded fresh on every visit, not kept in the browser.
 */
export function FindingsDatabase() {
  const finder = useFinder({ persist: false });
  const router = useRouter();
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    finder.browse();
  }, [finder]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Findings database</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Every company Find websites has saved, in <code className="text-xs">db/companies.jsonl</code>.
            Commit <code className="text-xs">db/</code>{" "}to share it.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => finder.browse()}
            disabled={finder.busy !== null}
            className="h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50"
          >
            Reload
          </button>
          <Link
            href="/resources"
            className="inline-flex items-center h-9 px-3 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Find more websites
          </Link>
        </div>
      </div>

      {!finder.result && finder.error && <p className="text-sm text-red-600">{finder.error}</p>}

      <FinderResults
        finder={finder}
        onAdded={() => router.refresh()}
        allowAddToJob
        emptyHint="Loading the findings database…"
      />
    </div>
  );
}
