"use client";

import { useRouter } from "next/navigation";
import { useQuickAdd } from "./QuickAddProvider";
import type { QuickAddItemKind } from "./types";

type Item = { title: string; hint: string } & (
  | { kind: QuickAddItemKind; href?: never }
  | { href: string; kind?: never }
);

const ITEMS: ReadonlyArray<Item> = [
  {
    kind: "project",
    title: "Job",
    hint: "A scraping pipeline: the websites to scrape and what it finds.",
  },
  {
    kind: "source",
    title: "Source",
    hint: "A website or feed to scrape for new findings.",
  },
  {
    href: "/aiconfig",
    title: "Scrape any website",
    hint: "Describe what to collect from a listing page; Use AI is optional.",
  },
  {
    href: "/resources",
    title: "Find websites",
    hint: "Search maps, the web and directories for companies to add.",
  },
];

export function QuickAddItemList() {
  const { selectKind, close } = useQuickAdd();
  const router = useRouter();
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {ITEMS.map((item) => (
        <li key={item.title}>
          <button
            type="button"
            onClick={() => {
              if (item.kind) {
                selectKind(item.kind);
              } else {
                close();
                router.push(item.href);
              }
            }}
            className="w-full h-full text-left rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600 bg-white dark:bg-zinc-950 px-4 py-3 transition-colors"
          >
            <div className="text-sm font-medium tracking-tight">
              {item.title}
              {item.href && <span className="text-zinc-400"> →</span>}
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
