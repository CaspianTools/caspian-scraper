"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";

// Loose client-side mirror of /config_jobs/{id}. The authoritative schema
// lives in web/lib/firestore/schema.ts (ConfigJobDocSchema); here we only
// read the fields the wizard renders, all optional to survive partial docs.
interface JobTurn {
  role: string;
  text: string;
  ts: string;
}
interface JobAdapter {
  key?: string;
  pr_url?: string;
  branch?: string;
  validation_report?: string;
}
interface JobDoc {
  status?: string;
  path?: "config" | "adapter" | null;
  turns?: JobTurn[];
  proposed_config?: unknown;
  sample_records?: Record<string, unknown>[];
  diagnostics?: {
    pages_visited?: number;
    extractor_hits?: Record<string, number>;
    http_errors?: Record<string, number>;
    escalation_reason?: string;
  };
  adapter?: JobAdapter | null;
  error?: string;
}

interface FieldErr {
  field?: string;
  message: string;
}

const TERMINAL: Record<string, boolean> = {
  proposed: true,
  approved: true,
  failed: true,
  // The config-path job stops at "escalating_adapter" (Phase-1 job mode writes
  // it together with finished_at and returns); without it here the job would
  // render as a perpetual spinner with no action.
  escalating_adapter: true,
};

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued — starting up",
  inspecting: "Inspecting the page",
  proposing_config: "Proposing a config",
  previewing: "Previewing extraction",
  escalating_adapter: "Escalating to a custom adapter",
  generating_adapter: "Generating the adapter",
  validating: "Validating",
  proposed: "Proposal ready",
  approved: "Approved",
  failed: "Failed",
};

/**
 * Describe a site → a proposed scraper config → approve it into a generic
 * source of the "Website data" job `projectId` (the config job carries it to
 * the approve route).
 */
export function ConfigWizard({ projectId }: { projectId: string }) {
  const [intent, setIntent] = useState("");
  const [url, setUrl] = useState("");
  const [sampleUrls, setSampleUrls] = useState("");
  const [recordSchemaHint, setRecordSchemaHint] = useState("");
  // Off by default: the config is built from the page itself — free, no key.
  const [useAi, setUseAi] = useState(false);
  // Whether an AI key is saved in Settings (checked when Use AI is turned on).
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobDoc | null>(null);

  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);

  const [approving, setApproving] = useState(false);
  const [approveMsg, setApproveMsg] = useState<string | null>(null);
  // The source the approval created, for an "Open the source" link.
  const [approvedId, setApprovedId] = useState<string | null>(null);

  // Poll the config job doc (owner-guarded admin-SDK route) until it reaches a
  // terminal status. We poll rather than use a client Firestore onSnapshot so
  // the wizard needs NO client rules on /config_jobs — consistent with the rest
  // of the app, which is admin-SDK-only, and avoids a named-database client
  // read that would otherwise require deployed rules to permit it.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const res = await authedFetch(`/api/aiconfig/jobs/${jobId}`);
        if (cancelled) return;
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          setErrors([
            { message: b.error || `Failed to load job (${res.status})` },
          ]);
          return; // stop on a hard error (401/404)
        }
        const data = (await res.json()) as JobDoc;
        if (cancelled) return;
        setJob(data);
        if (!TERMINAL[data.status ?? ""]) {
          timer = setTimeout(poll, 1500);
        }
      } catch {
        // transient network error — keep trying at a slower cadence
        if (!cancelled) timer = setTimeout(poll, 2500);
      }
    }
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  async function toggleAi(next: boolean) {
    setUseAi(next);
    if (!next || hasKey !== null) return;
    try {
      const res = await authedFetch("/api/aiconfig/key");
      const b = await res.json().catch(() => ({}));
      // A 403 means the owner manages the key — assume it's there.
      setHasKey(res.ok ? Boolean(b.configured) : true);
    } catch {
      setHasKey(true);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setBusy(true);
    try {
      const sample_urls = sampleUrls
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await authedFetch("/api/aiconfig/jobs", {
        method: "POST",
        body: JSON.stringify({
          intent,
          url,
          sample_urls,
          record_schema_hint: recordSchemaHint,
          use_ai: useAi,
          project_id: projectId,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        if (Array.isArray(b.details)) {
          setErrors(
            b.details.map((d: { path?: string[]; message: string }) => ({
              field: d.path?.join("."),
              message: d.message,
            }))
          );
        } else {
          setErrors([{ message: b.error || `Request failed (${res.status})` }]);
        }
        return;
      }
      const b = await res.json();
      setJobId(String(b.id));
    } catch (err) {
      setErrors([{ message: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (!jobId) return;
    setApproveMsg(null);
    setErrors([]);
    setApproving(true);
    try {
      const res = await authedFetch(`/api/aiconfig/jobs/${jobId}/approve`, {
        method: "POST",
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (Array.isArray(b.details)) {
          setErrors(
            b.details.map((d: { path?: string[]; message: string }) => ({
              field: d.path?.join("."),
              message: d.message,
            }))
          );
        } else {
          setErrors([{ message: b.error || `Approve failed (${res.status})` }]);
        }
        return;
      }
      setApprovedId(b.id ? String(b.id) : null);
      if (b.adapter_pr_url) {
        setApproveMsg(
          `Source created (inactive). Merge the adapter PR, then activate the source to start scraping.`
        );
      } else {
        setApproveMsg(
          `Source created and active. It goes live on the next scheduled scrape.`
        );
      }
    } catch (err) {
      setErrors([{ message: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setApproving(false);
    }
  }

  function reset() {
    setJobId(null);
    setJob(null);
    setApproveMsg(null);
    setApprovedId(null);
    setErrors([]);
    setIntent("");
    setUrl("");
    setSampleUrls("");
    setRecordSchemaHint("");
    setUseAi(false);
  }

  const errFor = (field: string) =>
    errors.find((e) => e.field === field)?.message;

  const generalErrors = errors.filter((e) => !e.field);

  // ---- Intake form (before a job exists) ----------------------------------
  if (!jobId) {
    return (
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-5 shadow-card"
      >
        <Row
          label="What do you want to scrape?"
          error={errFor("intent")}
          required
          hint="Describe the records in plain language, e.g. 'grant opportunities with a title, deadline, and award amount'."
        >
          <textarea
            required
            rows={3}
            maxLength={4000}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="Tender notices: title, buyer, closing date, and value."
            className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm shadow-xs"
          />
        </Row>

        <Row
          label="Listing URL"
          error={errFor("url")}
          required
          hint="The page that lists the items (not a single detail page)."
        >
          <input
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/tenders"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm shadow-xs"
          />
        </Row>

        <Row
          label="Sample detail URLs"
          error={errFor("sample_urls")}
          hint="Optional. One per line — example item pages the agent can inspect."
        >
          <textarea
            rows={2}
            value={sampleUrls}
            onChange={(e) => setSampleUrls(e.target.value)}
            placeholder={"https://example.com/tenders/123\nhttps://example.com/tenders/456"}
            className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono shadow-xs"
          />
        </Row>

        <Row
          label="Record schema hint"
          error={errFor("record_schema_hint")}
          hint="Optional shorthand, e.g. 'title:string,deadline:string,amount:number'."
        >
          <input
            type="text"
            maxLength={2000}
            value={recordSchemaHint}
            onChange={(e) => setRecordSchemaHint(e.target.value)}
            placeholder="title:string,deadline:string,amount:number"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono shadow-xs"
          />
        </Row>

        <UseAiToggle checked={useAi} onChange={toggleAi} hasKey={hasKey} />

        {generalErrors.map((e, i) => (
          <p key={i} className="text-sm text-red-600">
            {e.message}
          </p>
        ))}

        <div className="flex justify-end pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <button
            type="submit"
            disabled={busy || (useAi && hasKey === false)}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
          >
            {busy ? "Starting…" : useAi ? "Start with AI" : "Start"}
          </button>
        </div>
      </form>
    );
  }

  // ---- Live job view ------------------------------------------------------
  const status = job?.status ?? "queued";
  const working = !TERMINAL[status];

  return (
    <div className="space-y-6">
      <StatusBar status={status} working={working} />

      {generalErrors.map((e, i) => (
        <p key={i} className="text-sm text-red-600">
          {e.message}
        </p>
      ))}

      {status === "failed" && job?.error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
          {job.error}
        </div>
      )}

      <Transcript turns={job?.turns ?? []} working={working} withAi={useAi} />

      {job?.proposed_config != null && (
        <Section title="Proposed config">
          <pre className="text-xs leading-relaxed overflow-x-auto rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4">
            {JSON.stringify(job.proposed_config, null, 2)}
          </pre>
        </Section>
      )}

      <SampleRecords records={job?.sample_records ?? []} />

      <Diagnostics diagnostics={job?.diagnostics} />

      {job?.path === "adapter" && job?.adapter && (
        <Section title="Custom adapter">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            This site needed a purpose-built Python adapter
            {job.adapter.key ? (
              <>
                {" "}
                (<code className="text-xs">{job.adapter.key}</code>)
              </>
            ) : null}
            . It has to be merged before the source can run — approving now
            creates the source <strong>inactive</strong>; activate it after
            the PR merges.
          </p>
          {job.adapter.pr_url && (
            <a
              href={job.adapter.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center h-9 px-3 mt-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 bg-white dark:bg-zinc-900 shadow-xs font-medium"
            >
              View adapter PR ↗
            </a>
          )}
          {job.adapter.validation_report && (
            <pre className="text-xs mt-3 overflow-x-auto rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4 whitespace-pre-wrap">
              {job.adapter.validation_report}
            </pre>
          )}
        </Section>
      )}

      {approveMsg && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 p-4 text-sm text-emerald-700 dark:text-emerald-300">
          {approveMsg}
          {approvedId && (
            <>
              {" "}
              <Link
                href={`/projects/${projectId}/data/sources/${approvedId}`}
                className="font-medium underline"
              >
                Open the source →
              </Link>
            </>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-zinc-100 dark:border-zinc-800">
        <button
          type="button"
          onClick={reset}
          className="text-sm px-3 h-9 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 bg-white dark:bg-zinc-900 shadow-xs font-medium"
        >
          Start over
        </button>
        {status === "proposed" && !approveMsg && (
          <button
            type="button"
            onClick={handleApprove}
            disabled={approving}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
          >
            {approving
              ? "Approving…"
              : job?.path === "adapter"
                ? "Approve (create inactive)"
                : "Approve & create source"}
          </button>
        )}
      </div>
    </div>
  );
}

function StatusBar({ status, working }: { status: string; working: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-4 py-3">
      <span
        className={
          "inline-block w-2.5 h-2.5 rounded-full " +
          (status === "failed"
            ? "bg-red-500"
            : status === "approved"
              ? "bg-emerald-500"
              : working
                ? "bg-amber-400 animate-pulse"
                : "bg-blue-500")
        }
        aria-hidden
      />
      <div className="text-sm font-medium">
        {STATUS_LABEL[status] ?? status}
      </div>
      <code className="ml-auto text-xs text-zinc-500">{status}</code>
    </div>
  );
}

function Transcript({
  turns,
  working,
  withAi,
}: {
  turns: JobTurn[];
  working: boolean;
  withAi: boolean;
}) {
  return (
    <Section title={withAi ? "Conversation" : "Progress"}>
      {turns.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {working ? (withAi ? "The agent is starting up…" : "Opening the page…") : "No messages yet."}
        </p>
      ) : (
        <div className="space-y-3">
          {turns.map((t, i) => (
            <div
              key={i}
              className={
                "flex " + (t.role === "user" ? "justify-end" : "justify-start")
              }
            >
              <div
                className={
                  "max-w-[85%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap " +
                  (t.role === "user"
                    ? "bg-brand-600 text-white dark:bg-brand-500 dark:text-white shadow-sm shadow-brand-600/20"
                    : t.role === "system"
                      ? "bg-zinc-100 dark:bg-zinc-900 text-zinc-500 text-xs"
                      : "bg-zinc-100 dark:bg-zinc-900")
                }
              >
                {t.text}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function SampleRecords({ records }: { records: Record<string, unknown>[] }) {
  const columns = useMemo(() => {
    const seen = new Set<string>();
    for (const r of records) {
      for (const k of Object.keys(r ?? {})) seen.add(k);
    }
    return Array.from(seen);
  }, [records]);

  if (records.length === 0) return null;

  return (
    <Section title={`Sample records (${records.length})`}>
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50/80 dark:bg-zinc-900/60 text-[11px] font-medium uppercase tracking-wider text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              {columns.map((c) => (
                <th key={c} className="text-left px-3 py-2 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {records.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td
                    key={c}
                    className="px-3 py-2 align-top max-w-xs truncate"
                    title={cell(r[c])}
                  >
                    {cell(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function Diagnostics({
  diagnostics,
}: {
  diagnostics?: JobDoc["diagnostics"];
}) {
  if (!diagnostics) return null;
  const { pages_visited, extractor_hits, http_errors, escalation_reason } =
    diagnostics;
  const hasAny =
    pages_visited != null ||
    escalation_reason ||
    (extractor_hits && Object.keys(extractor_hits).length > 0) ||
    (http_errors && Object.keys(http_errors).length > 0);
  if (!hasAny) return null;

  return (
    <Section title="Diagnostics">
      <dl className="text-sm space-y-1">
        {pages_visited != null && (
          <div className="flex gap-2">
            <dt className="text-zinc-500">Pages visited</dt>
            <dd className="tabular-nums">{pages_visited}</dd>
          </div>
        )}
        {extractor_hits && Object.keys(extractor_hits).length > 0 && (
          <div className="flex gap-2">
            <dt className="text-zinc-500">Extractor hits</dt>
            <dd className="font-mono text-xs">
              {Object.entries(extractor_hits)
                .map(([k, v]) => `${k}=${v}`)
                .join("  ")}
            </dd>
          </div>
        )}
        {http_errors && Object.keys(http_errors).length > 0 && (
          <div className="flex gap-2">
            <dt className="text-zinc-500">HTTP errors</dt>
            <dd className="font-mono text-xs">
              {Object.entries(http_errors)
                .map(([k, v]) => `${k}=${v}`)
                .join("  ")}
            </dd>
          </div>
        )}
        {escalation_reason && (
          <div className="flex gap-2">
            <dt className="text-zinc-500">Escalation</dt>
            <dd>{escalation_reason}</dd>
          </div>
        )}
      </dl>
    </Section>
  );
}

function UseAiToggle({
  checked,
  onChange,
  hasKey,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  hasKey: boolean | null;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label="Use AI"
          onClick={() => onChange(!checked)}
          className={
            "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors " +
            (checked ? "bg-brand-600 dark:bg-brand-500 shadow-sm shadow-brand-600/20" : "bg-zinc-300 dark:bg-zinc-700")
          }
        >
          <span
            className={
              "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white dark:bg-zinc-950 transition-transform " +
              (checked ? "translate-x-4" : "")
            }
          />
        </button>
        <div className="min-w-0">
          <p className="text-sm font-medium">Use AI</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            {checked
              ? "An AI model inspects the site, writes the config and checks it with live previews. Uses your provider key and is billed by the provider."
              : "Off: the item links and fields are found automatically from the page — free, no key. Turn on for sites this can't handle."}
          </p>
        </div>
      </div>
      {checked && hasKey === false && (
        <p className="text-xs rounded-lg bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-3 py-2">
          No AI key yet —{" "}
          <Link href="/settings" className="underline">
            add one in Settings
          </Link>
          , or turn Use AI off.
        </p>
      )}
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
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-3 shadow-card">
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        {label}
        {!required && (
          <span className="text-zinc-500 font-normal"> (optional)</span>
        )}
      </label>
      {hint && <p className="text-xs text-zinc-500 mb-2">{hint}</p>}
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
