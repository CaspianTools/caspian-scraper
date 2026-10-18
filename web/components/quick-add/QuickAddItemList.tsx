"use client";

import { useQuickAdd } from "./QuickAddProvider";
import type { QuickAddItemKind } from "./types";

interface Item {
  kind: QuickAddItemKind;
  title: string;
  hint: string;
}

const ITEMS: ReadonlyArray<Item> = [
  {
    kind: "project",
    title: "Project",
    hint: "A scraping pipeline: sources, destinations, and a schedule.",
  },
  {
    kind: "source",
    title: "Source",
    hint: "A website or feed to scrape for new findings.",
  },
  {
    kind: "destination",
    title: "Destination",
    hint: "An API to POST findings to. Configures URL, auth, and secret.",
  },
  {
    kind: "secret",
    title: "Secret",
    hint: "An API key or token. Destinations reference these by name.",
  },
];

export function QuickAddItemList() {
  const { selectKind } = useQuickAdd();
  return (
    <ul className="space-y-2">
      {ITEMS.map((item) => (
        <li key={item.kind}>
          <button
            type="button"
            onClick={() => selectKind(item.kind)}
            className="w-full text-left rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600 bg-white dark:bg-zinc-950 px-4 py-3 transition-colors"
          >
            <div className="text-sm font-medium tracking-tight">
              {item.title}
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {item.hint}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
