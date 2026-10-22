"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { authedFetch } from "@/lib/firebase/clientFetch";

interface LastRunSummary {
  ts?: string;
  found?: number;
  extracted?: number;
  errors_count?: number;
}

export interface GenericSource {
  id: string;
  name?: string;
  source_key?: string;
  strategy?: {
    mode?: "config" | "adapter";
    adapter_key?: string;
    adapter_pr_url?: string;
  };
  start_urls?: string[];
  schedule_cron?: string;
  active?: boolean;
  last_run_at?: unknown;
  last_run_summary?: LastRunSummary | null;
}

/** Millis from a Firestore Timestamp / {_seconds} / ISO string / number / 0. */
function millis(v: unknown): number {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  const o = v as { toMillis?: () => number; _seconds?: number; seconds?: number };
  if (typeof o.toMillis === "function") return o.toMillis();
  if (typeof o._seconds === "number") return o._seconds * 1000;
  if (typeof o.seconds === "number") return o.seconds * 1000;
  return 0;
}

function fmtRelative(ms: number): string {
  if (!ms) return "never";
  const delta = Math.round((Date.now() - ms) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

interface Props {
  /** The "Website data" job whose sources are listed. */
  projectId: string;
  onNewScrape?: () => void;
}

/**
 * One "Website data" job's generic sources. Reads through
 * /api/generic/sources?project_id=…; the active toggle PATCHes the source. Adapter-mode
 * sources stay inactive until their generated Python module is merged, so the
 * toggle is disabled for them with an explanatory hint.
 */
export function GenericSourceList({ projectId, onNewScrape }: Props) {
  const base = `/projects/${projectId}/data`;
  const [rows, setRows] = useState<GenericSource[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(
          `/api/generic/sources?project_id=${encodeURIComponent(projectId)}`
        );
        const b = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setErr(b.error || `Request failed (${res.status})`);
          return;
        }
        setRows((b.sources ?? []) as GenericSource[]);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function toggleActive(s: GenericSource) {
    if (s.strategy?.mode === "adapter") return;
    setErr(null);
    setToggling(s.id);
    const next = !s.active;
    try {
      const res = await authedFetch(`/api/generic/sources/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: next }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(b.error || `Request failed (${res.status})`);
        return;
      }
      setRows((prev) =>
        (prev ?? []).map((r) => (r.id === s.id ? { ...r, active: next } : r))
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(null);
    }
  }

  if (err) {
    return (
      <div className="rounded-2xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
        {err}
      </div>
    );
  }

  if (rows === null) {
    return (
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 text-sm text-zinc-500 shadow-card">
        Loading…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center bg-white/60 dark:bg-zinc-950/40">
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4 max-w-md mx-auto">
          This job has no sources yet. Start a new scrape — describe a site and
          what to collect, and you get a scraper config to approve into a
          source.
        </p>
        {onNewScrape ? (
          <button
            type="button"
            onClick={onNewScrape}
            className="inline-flex items-center h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
          >
            New scrape
          </button>
        ) : (
          <Link
            href={base}
            className="inline-flex items-center h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
          >
            New scrape
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-500">
          {rows.length} source{rows.length === 1 ? "" : "s"}
        </p>
        {onNewScrape ? (
          <button
            type="button"
            onClick={onNewScrape}
            className="text-sm px-3 h-9 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 bg-white dark:bg-zinc-900 shadow-xs font-medium"
          >
            New scrape
          </button>
        ) : (
          <Link
            href={base}
            className="inline-flex items-center text-sm px-3 h-9 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 bg-white dark:bg-zinc-900 shadow-xs font-medium"
          >
            New scrape
          </Link>
        )}
      </div>

      <div className="space-y-3">
        {rows.map((s) => {
          const mode = s.strategy?.mode ?? "config";
          const isAdapter = mode === "adapter";
          const summary = s.last_run_summary;
          const lastRunMs = millis(s.last_run_at);
          return (
            <div
              key={s.id}
              className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 flex items-start gap-4 flex-wrap shadow-card"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    href={`${base}/sources/${s.id}`}
                    className="font-medium hover:underline line-clamp-1"
                  >
                    {s.name || s.source_key || s.id}
                  </Link>
                  <span
                    className={
                      "text-xs font-medium px-2 py-0.5 rounded-full " +
                      (isAdapter
                        ? "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-600/20 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-400/25"
                        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300")
                    }
                  >
                    {mode}
                  </span>
                  <span
                    className={
                      "text-xs font-medium px-2 py-0.5 rounded-full " +
                      (s.active
                        ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25"
                        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300")
                    }
                  >
                    {s.active ? "active" : "inactive"}
                  </span>
                </div>
                <div className="text-xs text-zinc-500 flex flex-wrap gap-x-3 gap-y-0.5">
                  {s.schedule_cron && (
                    <span className="font-mono">{s.schedule_cron}</span>
                  )}
                  <span>last run {fmtRelative(lastRunMs)}</span>
                  {summary && (
                    <span className="tabular-nums">
                      {summary.found ?? 0} found · {summary.extracted ?? 0}{" "}
                      extracted · {summary.errors_count ?? 0} errors
                    </span>
                  )}
                </div>
                {isAdapter && !s.active && (
                  <p className="text-xs text-blue-700 dark:text-blue-300">
                    Custom adapter — stays inactive until the generated module is
                    merged to main.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => toggleActive(s)}
                  disabled={isAdapter || toggling === s.id}
                  title={
                    isAdapter
                      ? "Adapter sources activate after their module is merged to main"
                      : undefined
                  }
                  className="text-sm px-3 h-9 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 bg-white dark:bg-zinc-900 shadow-xs font-medium"
                >
                  {toggling === s.id
                    ? "Saving…"
                    : s.active
                      ? "Deactivate"
                      : "Activate"}
                </button>
                <Link
                  href={`${base}/sources/${s.id}`}
                  className="text-sm px-3 h-9 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 inline-flex items-center bg-white dark:bg-zinc-900 shadow-xs font-medium"
                >
                  Open
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
