"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";
import type { DestinationFormInitial } from "./destinationFormDefaults";

interface Props {
  projectId: string;
  destId?: string;
  initial: DestinationFormInitial;
  availableSecrets: string[];
}

interface FieldErr {
  field?: string;
  message: string;
}

export function DestinationForm({
  projectId,
  destId,
  initial,
  availableSecrets,
}: Props) {
  const router = useRouter();
  const isEdit = !!destId;
  const [form, setForm] = useState<DestinationFormInitial>(initial);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);

  function set<K extends keyof DestinationFormInitial>(
    key: K,
    value: DestinationFormInitial[K]
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setBusy(true);
    try {
      // field_map intentionally omitted from the UI for now — server
      // accepts an empty object as the default.
      const body = JSON.stringify({ ...form, field_map: {} });
      const url = isEdit
        ? `/api/projects/${projectId}/destinations/${destId}`
        : `/api/projects/${projectId}/destinations`;
      const res = await authedFetch(url, {
        method: isEdit ? "PATCH" : "POST",
        body,
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
      router.push(`/projects/${projectId}/destinations`);
      router.refresh();
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!destId) return;
    if (!confirm(`Delete "${form.name}"?`)) return;
    setDeleting(true);
    try {
      const res = await authedFetch(
        `/api/projects/${projectId}/destinations/${destId}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErrors([{ message: b.error || `Delete failed (${res.status})` }]);
        return;
      }
      router.push(`/projects/${projectId}/destinations`);
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  const errFor = (field: string) =>
    errors.find((e) => e.field === field)?.message;

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-5"
    >
      <Row label="Name" error={errFor("name")} required>
        <input
          type="text"
          required
          maxLength={80}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="entirelysafe.com API"
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
      </Row>

      <Row label="Base URL" error={errFor("base_url")} required>
        <input
          type="url"
          required
          value={form.base_url}
          onChange={(e) => set("base_url", e.target.value)}
          placeholder="https://entirelysafe.com/api/v1"
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
      </Row>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Row label="List endpoint" error={errFor("list_path")} required hint="Path appended to base URL. Used to fetch existing items so we can dedup.">
          <input
            type="text"
            required
            value={form.list_path}
            onChange={(e) => set("list_path", e.target.value)}
            placeholder="/vacancies"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
        </Row>

        <Row label="POST endpoint" error={errFor("post_path")} required hint="Path to POST new findings to.">
          <input
            type="text"
            required
            value={form.post_path}
            onChange={(e) => set("post_path", e.target.value)}
            placeholder="/vacancies"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
        </Row>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Row label="Auth header name" error={errFor("auth_header_name")} required>
          <input
            type="text"
            required
            value={form.auth_header_name}
            onChange={(e) => set("auth_header_name", e.target.value)}
            placeholder="X-API-Key"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
        </Row>

        <Row label="Auth header format" hint="Token literal '{secret}' is replaced with the secret value at scrape time.">
          <input
            type="text"
            value={form.auth_header_format}
            onChange={(e) => set("auth_header_format", e.target.value)}
            placeholder="{secret}"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
        </Row>
      </div>

      <Row
        label="Secret to use"
        error={errFor("secret_ref")}
        required
        hint={
          availableSecrets.length === 0
            ? "No secrets in this project yet. Add one on the Secrets tab first."
            : "Name of an existing secret in this project."
        }
      >
        {availableSecrets.length > 0 ? (
          <select
            required
            value={form.secret_ref}
            onChange={(e) => set("secret_ref", e.target.value)}
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            <option value="">— pick a secret —</option>
            {availableSecrets.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            required
            value={form.secret_ref}
            onChange={(e) => set("secret_ref", e.target.value)}
            placeholder="API_KEY"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
        )}
      </Row>

      {errors
        .filter((e) => !e.field)
        .map((e, i) => (
          <p key={i} className="text-sm text-red-600">
            {e.message}
          </p>
        ))}

      <div className="flex items-center justify-between pt-2 border-t border-zinc-100 dark:border-zinc-800">
        {isEdit ? (
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || busy}
            className="text-sm px-3 h-9 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete destination"}
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Link
            href={`/projects/${projectId}/destinations`}
            className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={busy || deleting}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {busy ? "Saving…" : isEdit ? "Save changes" : "Add destination"}
          </button>
        </div>
      </div>
    </form>
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
