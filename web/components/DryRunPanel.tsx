"use client";

import { useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";

interface SourceCheck {
  name: string;
  careers_url: string;
  ok: boolean;
  status: number | null;
  ms: number;
  message: string;
  content_bytes: number | null;
}

interface DestinationCheck {
  name: string;
  endpoint: string;
  secret_ref: string;
  secret_resolved: boolean;
  ok: boolean;
  status: number | null;
  ms: number;
  message: string;
}

interface DryRunResult {
  ok: boolean;
  ran_at: string;
  summary: {
    sources_checked: number;
    sources_ok: number;
    destinations_checked: number;
    destinations_ok: number;
  };
  sources: SourceCheck[];
  destinations: DestinationCheck[];
}

export function DryRunPanel({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleRun() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await authedFetch(
        `/api/projects/${projectId}/dry-run`,
        { method: "POST" }
      );
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        setErr((body && body.error) || `Request failed (${res.status})`);
        return;
      }
      setResult(body as DryRunResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-base font-medium">Dry run</h3>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-xl">
            Quick wiring check: hit each source URL, resolve each
            destination&apos;s secret, ping each destination endpoint.
            <strong className="font-medium"> No scraping. No POSTing.</strong>{" "}
            Confirms everything is reachable and configured correctly.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRun}
          disabled={busy}
          className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50 shrink-0"
        >
          {busy ? "Running…" : "Dry run"}
        </button>
      </div>

      {err && (
        <p className="text-sm text-red-600 dark:text-red-400">{err}</p>
      )}

      {result && <DryRunResultView result={result} />}
    </div>
  );
}

function DryRunResultView({ result }: { result: DryRunResult }) {
  const s = result.summary;
  return (
    <div className="space-y-3">
      <div
        className={
          "rounded-lg px-4 py-3 text-sm flex items-center justify-between " +
          (result.ok
            ? "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800"
            : "bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 border border-amber-200 dark:border-amber-800")
        }
      >
        <span>
          <strong>
            {result.ok ? "All wiring OK." : "Some checks failed."}
          </strong>{" "}
          Sources {s.sources_ok}/{s.sources_checked} · Destinations{" "}
          {s.destinations_ok}/{s.destinations_checked}
        </span>
        <span className="text-xs opacity-70">
          {new Date(result.ran_at).toISOString().slice(11, 19)} UTC
        </span>
      </div>

      {result.sources.length > 0 && (
        <Section title="Sources">
          {result.sources.map((c) => (
            <CheckRow
              key={c.careers_url || c.name}
              ok={c.ok}
              name={c.name}
              sub={c.careers_url}
              right={`${c.status ?? "—"} · ${c.ms}ms`}
              message={c.message}
            />
          ))}
        </Section>
      )}

      {result.destinations.length > 0 && (
        <Section title="Destinations">
          {result.destinations.map((c) => (
            <CheckRow
              key={c.endpoint || c.name}
              ok={c.ok}
              name={c.name}
              sub={c.endpoint}
              right={`${c.status ?? "—"} · ${c.ms}ms`}
              message={
                c.message + (c.secret_resolved ? "" : " · secret missing")
              }
            />
          ))}
        </Section>
      )}

      <p className="text-xs text-zinc-500">
        Item-count and parser correctness are not exercised by this check —
        those need the full scraper (Phase 3).
      </p>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
        {title}
      </div>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        {children}
      </ul>
    </div>
  );
}

function CheckRow({
  ok,
  name,
  sub,
  right,
  message,
}: {
  ok: boolean;
  name: string;
  sub: string;
  right: string;
  message: string;
}) {
  return (
    <li className="px-3 py-2 flex items-center justify-between gap-3 text-sm">
      <span className="flex items-start gap-2 min-w-0">
        <span
          aria-hidden
          className={
            "mt-0.5 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 " +
            (ok
              ? "bg-emerald-500 text-white"
              : "bg-red-500 text-white")
          }
        >
          {ok ? "✓" : "✕"}
        </span>
        <span className="min-w-0">
          <div className="font-medium truncate">{name}</div>
          {sub && (
            <div
              className="text-xs text-zinc-500 truncate font-mono"
              title={sub}
            >
              {sub}
            </div>
          )}
          <div
            className={
              "text-xs " +
              (ok
                ? "text-zinc-500"
                : "text-red-600 dark:text-red-400")
            }
          >
            {message}
          </div>
        </span>
      </span>
      <span className="text-xs text-zinc-500 whitespace-nowrap font-mono">
        {right}
      </span>
    </li>
  );
}
