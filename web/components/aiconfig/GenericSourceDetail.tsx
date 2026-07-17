"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/firebase/clientFetch";

interface FieldErr {
  field?: string;
  message: string;
}

interface FieldSpec {
  name: string;
  type?: string;
  required?: boolean;
}

interface LastRunSummary {
  ts?: string;
  found?: number;
  extracted?: number;
  errors_count?: number;
}

interface GenericSource {
  id: string;
  name?: string;
  source_key?: string;
  strategy?: {
    mode?: "config" | "adapter";
    adapter_key?: string;
    adapter_pr_url?: string;
    extraction?: unknown;
  };
  record_schema?: FieldSpec[];
  start_urls?: string[];
  schedule_cron?: string;
  active?: boolean;
  notes?: string;
  last_run_at?: unknown;
  last_run_summary?: LastRunSummary | null;
  origin?: { via?: string; config_job_id?: string };
}

interface GenericRecord {
  id: string;
  uid?: string;
  url?: string;
  data?: Record<string, unknown>;
  status?: string;
  first_seen_at?: unknown;
  last_seen_at?: unknown;
}

interface GenericRun {
  id: string;
  status?: string;
  started_at?: unknown;
  finished_at?: unknown;
  duration_seconds?: number;
  totals?: {
    checked?: number;
    found?: number;
    extracted?: number;
    skipped_duplicate?: number;
    errors_count?: number;
  };
  errors?: string[];
  diagnostics?: {
    links_discovered?: number;
    pages_visited?: number;
    extractor_hits?: Record<string, number>;
    http_errors?: Record<string, number>;
  };
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

function statusClasses(s: string): string {
  switch (s) {
    case "ok":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "partial":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "running":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
    case "error":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Only http(s) URLs are safe to render as a clickable link. Scraped record URLs
 * are third-party data and could be `javascript:` / `data:` — those would run in
 * this authenticated origin if clicked, so this returns null for them and the
 * caller renders plain text instead. (React does not neutralize such hrefs.)
 */
function safeHref(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const scheme = new URL(url, window.location.origin).protocol;
    return scheme === "http:" || scheme === "https:" ? url : null;
  } catch {
    return null;
  }
}

type Tab = "config" | "records" | "runs";

export function GenericSourceDetail({ sid }: { sid: string }) {
  const router = useRouter();

  const [source, setSource] = useState<GenericSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<FieldErr[]>([]);

  const [tab, setTab] = useState<Tab>("config");

  // Edit form (name / schedule_cron / notes / start_urls).
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: "",
    schedule_cron: "",
    notes: "",
    start_urls: "",
  });
  const [saving, setSaving] = useState(false);

  const [toggling, setToggling] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function loadSource() {
    setErrors([]);
    try {
      const res = await authedFetch(`/api/generic/sources/${sid}`);
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors([{ message: b.error || `Request failed (${res.status})` }]);
        setSource(null);
        return;
      }
      const s = b as GenericSource;
      setSource(s);
      setForm({
        name: s.name ?? "",
        schedule_cron: s.schedule_cron ?? "",
        notes: s.notes ?? "",
        start_urls: (s.start_urls ?? []).join("\n"),
      });
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
      setSource(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await authedFetch(`/api/generic/sources/${sid}`);
        const b = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setErrors([{ message: b.error || `Request failed (${res.status})` }]);
          return;
        }
        const s = b as GenericSource;
        setSource(s);
        setForm({
          name: s.name ?? "",
          schedule_cron: s.schedule_cron ?? "",
          notes: s.notes ?? "",
          start_urls: (s.start_urls ?? []).join("\n"),
        });
      } catch (e) {
        if (!cancelled)
          setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sid]);

  async function handleToggle() {
    if (!source) return;
    if (source.strategy?.mode === "adapter") return;
    setErrors([]);
    setToggling(true);
    const next = !source.active;
    try {
      const res = await authedFetch(`/api/generic/sources/${sid}`, {
        method: "PATCH",
        body: JSON.stringify({ active: next }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors([{ message: b.error || `Request failed (${res.status})` }]);
        return;
      }
      setSource((prev) => (prev ? { ...prev, active: next } : prev));
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setToggling(false);
    }
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setSaving(true);
    try {
      const start_urls = form.start_urls
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await authedFetch(`/api/generic/sources/${sid}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          schedule_cron: form.schedule_cron,
          notes: form.notes,
          start_urls,
        }),
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
          setErrors([{ message: b.error || `Request failed (${res.status})` }]);
        }
        return;
      }
      setEditing(false);
      await loadSource();
    } catch (err) {
      setErrors([{ message: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setSaving(false);
    }
  }

  async function handleRunNow() {
    setErrors([]);
    setRunMsg(null);
    setRunning(true);
    try {
      const res = await authedFetch(`/api/generic/sources/${sid}/run-now`, {
        method: "POST",
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors([{ message: b.error || `Request failed (${res.status})` }]);
        return;
      }
      setRunMsg("Run queued. The next cron tick picks it up.");
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete() {
    if (!source) return;
    if (
      !confirm(
        `Delete "${source.name || source.source_key || sid}"? Existing records are kept; only future scrapes stop.`
      )
    )
      return;
    setErrors([]);
    setDeleting(true);
    try {
      const res = await authedFetch(`/api/generic/sources/${sid}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErrors([{ message: b.error || `Request failed (${res.status})` }]);
        return;
      }
      router.push("/aiconfig");
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  const errFor = (field: string) =>
    errors.find((e) => e.field === field)?.message;
  const generalErrors = errors.filter((e) => !e.field);

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  if (!source) {
    return (
      <div className="space-y-4">
        <Link
          href="/aiconfig"
          className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
        >
          ← Sources
        </Link>
        {generalErrors.length > 0 ? (
          generalErrors.map((e, i) => (
            <p key={i} className="text-sm text-red-600">
              {e.message}
            </p>
          ))
        ) : (
          <p className="text-sm text-zinc-500">Source not found.</p>
        )}
      </div>
    );
  }

  const mode = source.strategy?.mode ?? "config";
  const isAdapter = mode === "adapter";
  const lastRunMs = millis(source.last_run_at);

  return (
    <div className="space-y-6">
      <Link
        href="/aiconfig"
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Sources
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-semibold tracking-tight">
              {source.name || source.source_key || sid}
            </h2>
            <span
              className={
                "text-xs px-2 py-0.5 rounded-full " +
                (isAdapter
                  ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                  : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300")
              }
            >
              {mode}
            </span>
            <span
              className={
                "text-xs px-2 py-0.5 rounded-full " +
                (source.active
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                  : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300")
              }
            >
              {source.active ? "active" : "inactive"}
            </span>
          </div>
          <p className="text-xs text-zinc-500">
            <code className="font-mono">{source.source_key}</code> · last run{" "}
            {fmtRelative(lastRunMs)}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button
            type="button"
            onClick={handleRunNow}
            disabled={running || isAdapter}
            title={
              isAdapter
                ? "Adapter sources can't run until their module is merged to main"
                : undefined
            }
            className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50"
          >
            {running ? "Queueing…" : "Run now"}
          </button>
          <button
            type="button"
            onClick={handleToggle}
            disabled={isAdapter || toggling}
            title={
              isAdapter
                ? "Adapter sources activate after their module is merged to main"
                : undefined
            }
            className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50"
          >
            {toggling
              ? "Saving…"
              : source.active
                ? "Deactivate"
                : "Activate"}
          </button>
        </div>
      </div>

      {runMsg && (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">{runMsg}</p>
      )}
      {generalErrors.map((e, i) => (
        <p key={i} className="text-sm text-red-600">
          {e.message}
        </p>
      ))}

      {isAdapter && (
        <div className="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 p-4 text-sm text-blue-700 dark:text-blue-300 space-y-2">
          <p>
            This is a custom-adapter source
            {source.strategy?.adapter_key ? (
              <>
                {" "}
                (<code className="text-xs">{source.strategy.adapter_key}</code>)
              </>
            ) : null}
            . It needs the generated Python module merged to{" "}
            <code className="text-xs">main</code> before it can run, so it stays{" "}
            <strong>inactive</strong> until then.
          </p>
          {source.strategy?.adapter_pr_url && (
            <a
              href={source.strategy.adapter_pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center h-9 px-3 rounded-lg border border-blue-300 dark:border-blue-800 text-sm hover:bg-blue-100 dark:hover:bg-blue-900/40"
            >
              View adapter PR ↗
            </a>
          )}
        </div>
      )}

      {/* Tabs */}
      <nav className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-2 flex flex-wrap gap-1">
        {(
          [
            ["config", "Configuration"],
            ["records", "Records"],
            ["runs", "Runs"],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={
              "text-sm px-3 py-1.5 rounded-lg transition-colors " +
              (tab === value
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900")
            }
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "config" && (
        <ConfigTab
          source={source}
          editing={editing}
          setEditing={setEditing}
          form={form}
          setForm={setForm}
          onSave={handleSaveEdit}
          saving={saving}
          errFor={errFor}
          onDelete={handleDelete}
          deleting={deleting}
        />
      )}
      {tab === "records" && <RecordsTab sid={sid} schema={source.record_schema} />}
      {tab === "runs" && <RunsTab sid={sid} />}
    </div>
  );
}

// ---- Configuration tab ----------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-3">
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {children}
    </section>
  );
}

function ConfigTab({
  source,
  editing,
  setEditing,
  form,
  setForm,
  onSave,
  saving,
  errFor,
  onDelete,
  deleting,
}: {
  source: GenericSource;
  editing: boolean;
  setEditing: (v: boolean) => void;
  form: { name: string; schedule_cron: string; notes: string; start_urls: string };
  setForm: React.Dispatch<
    React.SetStateAction<{
      name: string;
      schedule_cron: string;
      notes: string;
      start_urls: string;
    }>
  >;
  onSave: (e: React.FormEvent) => void;
  saving: boolean;
  errFor: (f: string) => string | undefined;
  onDelete: () => void;
  deleting: boolean;
}) {
  if (editing) {
    return (
      <form
        onSubmit={onSave}
        className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-5"
      >
        <Row label="Name" error={errFor("name")} required>
          <input
            type="text"
            required
            maxLength={120}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
          />
        </Row>
        <Row
          label="Schedule (cron)"
          error={errFor("schedule_cron")}
          required
          hint="≥1hr granularity. Minute must be a fixed number (e.g. '30 4 * * *' for daily 04:30 UTC)."
        >
          <input
            type="text"
            required
            value={form.schedule_cron}
            onChange={(e) =>
              setForm((f) => ({ ...f, schedule_cron: e.target.value }))
            }
            placeholder="30 4 * * *"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
          />
        </Row>
        <Row
          label="Start URLs"
          error={errFor("start_urls")}
          required
          hint="One per line — the listing pages the scraper begins from."
        >
          <textarea
            rows={3}
            value={form.start_urls}
            onChange={(e) =>
              setForm((f) => ({ ...f, start_urls: e.target.value }))
            }
            placeholder={"https://example.com/tenders"}
            className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
          />
        </Row>
        <Row label="Notes" error={errFor("notes")}>
          <textarea
            rows={2}
            maxLength={2000}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            placeholder="Optional context."
            className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
          />
        </Row>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    );
  }

  const schema = source.record_schema ?? [];

  return (
    <div className="space-y-6">
      <Section title="Overview">
        <dl className="space-y-2">
          <SpecRow label="Name" value={source.name || "—"} />
          <SpecRow label="Source key" value={source.source_key || "—"} mono />
          <SpecRow label="Schedule" value={source.schedule_cron || "—"} mono />
          <SpecRow label="Strategy" value={source.strategy?.mode || "—"} />
          {source.strategy?.adapter_key && (
            <SpecRow
              label="Adapter key"
              value={source.strategy.adapter_key}
              mono
            />
          )}
          {source.origin?.via && (
            <SpecRow label="Created via" value={source.origin.via} />
          )}
          {source.notes && <SpecRow label="Notes" value={source.notes} />}
        </dl>
        <div className="pt-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-sm px-3 h-9 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            Edit
          </button>
        </div>
      </Section>

      <Section title="Start URLs">
        {source.start_urls && source.start_urls.length > 0 ? (
          <ul className="space-y-1">
            {source.start_urls.map((u, i) => (
              <li key={i}>
                {safeHref(u) ? (
                  <a
                    href={safeHref(u) as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-zinc-700 dark:text-zinc-300 hover:underline break-all"
                  >
                    {u}
                  </a>
                ) : (
                  <span className="text-sm text-zinc-500 break-all">{u}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">None.</p>
        )}
      </Section>

      <Section title={`Record schema (${schema.length})`}>
        {schema.length > 0 ? (
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Field</th>
                  <th className="text-left px-3 py-2 font-medium">Type</th>
                  <th className="text-left px-3 py-2 font-medium">Required</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {schema.map((f) => (
                  <tr key={f.name}>
                    <td className="px-3 py-2 font-mono text-xs">{f.name}</td>
                    <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                      {f.type ?? "string"}
                    </td>
                    <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                      {f.required ? "yes" : "no"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">No schema fields.</p>
        )}
      </Section>

      <Section title="Strategy config">
        <pre className="text-xs leading-relaxed overflow-x-auto rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4">
          {JSON.stringify(source.strategy ?? {}, null, 2)}
        </pre>
      </Section>

      <div className="flex items-center pt-2 border-t border-zinc-100 dark:border-zinc-800">
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="text-sm px-3 h-9 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
        >
          {deleting ? "Deleting…" : "Delete source"}
        </button>
      </div>
    </div>
  );
}

function SpecRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-100 dark:border-zinc-800 pb-2">
      <dt className="text-sm text-zinc-500">{label}</dt>
      <dd
        className={
          "text-sm font-medium text-right break-all " + (mono ? "font-mono" : "")
        }
      >
        {value}
      </dd>
    </div>
  );
}

// ---- Records tab ----------------------------------------------------------

function RecordsTab({
  sid,
  schema,
}: {
  sid: string;
  schema?: FieldSpec[];
}) {
  const [records, setRecords] = useState<GenericRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(`/api/generic/sources/${sid}/records`);
        const b = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setErr(b.error || `Request failed (${res.status})`);
          return;
        }
        setRecords((b.records ?? []) as GenericRecord[]);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sid]);

  const columns = useMemo(() => {
    // De-dup: record_schema has no cross-field name uniqueness, so two fields
    // could share a name and produce duplicate React keys on <th>/<td>.
    const fromSchema = Array.from(
      new Set((schema ?? []).map((f) => f.name).filter(Boolean))
    );
    if (fromSchema.length > 0) return fromSchema;
    const seen = new Set<string>();
    for (const r of records ?? []) {
      for (const k of Object.keys(r.data ?? {})) seen.add(k);
    }
    return Array.from(seen);
  }, [schema, records]);

  if (err) {
    return (
      <div className="rounded-2xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
        {err}
      </div>
    );
  }
  if (records === null) {
    return (
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 text-sm text-zinc-500">
        Loading…
      </div>
    );
  }
  if (records.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center text-sm text-zinc-500">
        No records scraped yet. Run the source to collect some.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-500">
        {records.length} record{records.length === 1 ? "" : "s"}
      </p>
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              {columns.map((c) => (
                <th key={c} className="text-left px-3 py-2 font-medium">
                  {c}
                </th>
              ))}
              <th className="text-left px-3 py-2 font-medium">URL</th>
              <th className="text-left px-3 py-2 font-medium">Status</th>
              <th className="text-left px-3 py-2 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {records.map((r) => (
              <tr
                key={r.id}
                className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
              >
                {columns.map((c) => {
                  const text = cell(r.data?.[c]);
                  return (
                    <td
                      key={c}
                      className="px-3 py-2 align-top max-w-xs truncate"
                      title={text}
                    >
                      {text}
                    </td>
                  );
                })}
                <td className="px-3 py-2 align-top max-w-[16rem] truncate">
                  {safeHref(r.url) ? (
                    <a
                      href={safeHref(r.url) as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-700 dark:text-zinc-300 hover:underline"
                      title={r.url}
                    >
                      {r.url}
                    </a>
                  ) : (
                    <span className="text-zinc-500" title={r.url}>
                      {r.url ?? ""}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top">
                  <span
                    className={
                      "text-xs px-2 py-0.5 rounded-full " +
                      (r.status === "new"
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300")
                    }
                  >
                    {r.status ?? "seen"}
                  </span>
                </td>
                <td className="px-3 py-2 align-top text-xs text-zinc-500 whitespace-nowrap">
                  {fmtRelative(millis(r.last_seen_at))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Runs tab -------------------------------------------------------------

function RunsTab({ sid }: { sid: string }) {
  const [runs, setRuns] = useState<GenericRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(`/api/generic/sources/${sid}/runs`);
        const b = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setErr(b.error || `Request failed (${res.status})`);
          return;
        }
        setRuns((b.runs ?? []) as GenericRun[]);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sid]);

  if (err) {
    return (
      <div className="rounded-2xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300">
        {err}
      </div>
    );
  }
  if (runs === null) {
    return (
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 text-sm text-zinc-500">
        Loading…
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center text-sm text-zinc-500">
        No runs yet. Trigger Run now to start one.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-500">
        {runs.length} recent run{runs.length === 1 ? "" : "s"}
      </p>
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="text-left px-4 py-2 font-medium">Started</th>
              <th className="text-right px-4 py-2 font-medium">Found</th>
              <th className="text-right px-4 py-2 font-medium">Extracted</th>
              <th className="text-right px-4 py-2 font-medium">Errors</th>
              <th className="text-left px-4 py-2 font-medium w-px"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {runs.map((r) => {
              const totals = r.totals ?? {};
              const isOpen = expanded === r.id;
              const hasDetail =
                (r.errors && r.errors.length > 0) || !!r.diagnostics;
              const status = r.status ?? "";
              return (
                <Fragment key={r.id}>
                  <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                    <td className="px-4 py-3">
                      <span
                        className={
                          "text-xs px-2 py-0.5 rounded-full " +
                          statusClasses(status)
                        }
                      >
                        {status.replace("_", " ") || "unknown"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500 whitespace-nowrap">
                      {fmtRelative(millis(r.started_at))}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {totals.found ?? 0}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {totals.extracted ?? 0}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-zinc-500">
                      {totals.errors_count ?? 0}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {hasDetail && (
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : r.id)}
                          className="text-xs text-zinc-600 dark:text-zinc-400 hover:underline whitespace-nowrap"
                        >
                          {isOpen ? "Hide" : "Details"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isOpen && hasDetail && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-3 bg-zinc-50 dark:bg-zinc-900/50"
                      >
                        <div className="space-y-3">
                          {r.errors && r.errors.length > 0 && (
                            <div>
                              <p className="text-xs font-medium text-zinc-500 mb-1">
                                Errors
                              </p>
                              <ul className="space-y-1">
                                {r.errors.map((e, i) => (
                                  <li
                                    key={i}
                                    className="text-xs text-red-700 dark:text-red-300 font-mono break-all"
                                  >
                                    {e}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {r.diagnostics && (
                            <div>
                              <p className="text-xs font-medium text-zinc-500 mb-1">
                                Diagnostics
                              </p>
                              <pre className="text-xs leading-relaxed overflow-x-auto rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-3">
                                {JSON.stringify(r.diagnostics, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- shared Row (edit form) ----------------------------------------------

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
