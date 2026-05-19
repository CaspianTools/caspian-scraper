"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export interface FindingRow {
  id: string; // slug
  title: string;
  employer: string;
  location: string;
  country: string;
  ats: string;
  source_id: string;
  source_name: string;
  source_url: string;
  status: "published" | "duplicate" | "failed" | string;
  first_seen_at: string;
  last_seen_at: string;
  attempts: number;
  destination_id: string;
  destination_response_id: string;
  published_at: string;
  error: string;
}

interface Props {
  projectId: string;
  findings: FindingRow[];
}

type View = "list" | "cards";
type StatusFilter = "all" | "published" | "duplicate" | "failed";

const STATUSES: StatusFilter[] = ["all", "published", "duplicate", "failed"];

function statusClasses(s: string): string {
  switch (s) {
    case "published":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "duplicate":
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
    case "failed":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

function fmtRelative(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Math.round((Date.now() - t) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

export function FindingsView({ projectId, findings }: Props) {
  const [view, setView] = useState<View>("list");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [q, setQ] = useState("");

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: findings.length };
    for (const f of findings) c[f.status] = (c[f.status] ?? 0) + 1;
    return c;
  }, [findings]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return findings.filter((f) => {
      if (status !== "all" && f.status !== status) return false;
      if (needle) {
        const hay =
          `${f.title} ${f.employer} ${f.location} ${f.country} ${f.source_name}`
            .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [findings, status, q]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {STATUSES.map((s) => {
              const n = counts[s] ?? 0;
              const active = status === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={
                    "text-xs px-2.5 py-1.5 rounded-full border transition-colors " +
                    (active
                      ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
                      : "border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900")
                  }
                >
                  {s === "all" ? "All" : s} <span className="opacity-60">· {n}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search title / employer / location"
              className="h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            <div className="flex items-center gap-1 rounded-lg border border-zinc-300 dark:border-zinc-700 p-0.5">
              {(["list", "cards"] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={
                    "text-xs px-2.5 h-8 rounded-md transition-colors " +
                    (view === v
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900")
                  }
                >
                  {v === "list" ? "List" : "Cards"}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="text-xs text-zinc-500 mt-3">
          {filtered.length === findings.length
            ? `${findings.length} finding${findings.length === 1 ? "" : "s"}`
            : `${filtered.length} of ${findings.length} finding${findings.length === 1 ? "" : "s"}`}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center text-sm text-zinc-500">
          {findings.length === 0
            ? "No findings yet. They land here after the scraper runs."
            : "No findings match these filters."}
        </div>
      ) : view === "list" ? (
        <ListView projectId={projectId} findings={filtered} />
      ) : (
        <CardsView projectId={projectId} findings={filtered} />
      )}
    </div>
  );
}

function ListView({
  projectId,
  findings,
}: {
  projectId: string;
  findings: FindingRow[];
}) {
  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Title</th>
            <th className="text-left px-4 py-2 font-medium">Employer</th>
            <th className="text-left px-4 py-2 font-medium">Location</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
            <th className="text-left px-4 py-2 font-medium">Source</th>
            <th className="text-left px-4 py-2 font-medium">Last seen</th>
            <th className="text-left px-4 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800 align-top">
          {findings.map((f) => (
            <tr
              key={f.id}
              className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
            >
              <td className="px-4 py-3 font-medium max-w-xs">
                <div className="truncate">{f.title}</div>
                {f.error && (
                  <div
                    className="text-xs text-red-600 dark:text-red-400 mt-1 truncate"
                    title={f.error}
                  >
                    {f.error}
                  </div>
                )}
              </td>
              <td className="px-4 py-3">{f.employer}</td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                {f.location || "—"}
                {f.country && (
                  <span className="text-xs text-zinc-500 ml-1">
                    {f.country.toUpperCase()}
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                <span
                  className={
                    "text-xs px-2 py-0.5 rounded-full whitespace-nowrap " +
                    statusClasses(f.status)
                  }
                >
                  {f.status}
                </span>
              </td>
              <td className="px-4 py-3 text-xs">
                <Link
                  href={`/projects/${projectId}/sources/${f.source_id}`}
                  className="hover:underline"
                >
                  {f.source_name || f.source_id}
                </Link>
              </td>
              <td
                className="px-4 py-3 text-xs text-zinc-500 whitespace-nowrap"
                title={f.last_seen_at}
              >
                {fmtRelative(f.last_seen_at)}
              </td>
              <td className="px-4 py-3 text-xs whitespace-nowrap">
                {f.source_url && (
                  <a
                    href={f.source_url}
                    target="_blank"
                    rel="noopener"
                    className="hover:underline text-zinc-700 dark:text-zinc-300"
                  >
                    Source ↗
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CardsView({
  projectId,
  findings,
}: {
  projectId: string;
  findings: FindingRow[];
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {findings.map((f) => (
        <div
          key={f.id}
          className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 flex flex-col gap-3"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-medium leading-tight">{f.title}</h3>
            <span
              className={
                "text-xs px-2 py-0.5 rounded-full whitespace-nowrap shrink-0 " +
                statusClasses(f.status)
              }
            >
              {f.status}
            </span>
          </div>
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            <div className="font-medium text-zinc-800 dark:text-zinc-200">
              {f.employer}
            </div>
            <div className="text-xs mt-0.5">
              {f.location || "—"}
              {f.country && (
                <span className="ml-1 text-zinc-500">
                  {f.country.toUpperCase()}
                </span>
              )}
            </div>
          </div>
          {f.error && (
            <div className="text-xs text-red-700 dark:text-red-400 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/40 px-2 py-1.5 break-words whitespace-pre-wrap font-mono">
              {f.error}
            </div>
          )}
          <div className="mt-auto pt-2 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between text-xs text-zinc-500">
            <Link
              href={`/projects/${projectId}/sources/${f.source_id}`}
              className="hover:underline truncate max-w-[60%]"
              title={f.source_name}
            >
              {f.source_name || "source"}
            </Link>
            <span title={f.last_seen_at}>{fmtRelative(f.last_seen_at)}</span>
          </div>
          {f.source_url && (
            <a
              href={f.source_url}
              target="_blank"
              rel="noopener"
              className="text-xs text-zinc-700 dark:text-zinc-300 hover:underline"
            >
              Source ↗
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
