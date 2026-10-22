"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CountrySelect } from "@/components/CountrySelect";
import { apiFetch } from "@/lib/api";
import type { SourceFormInitial } from "./sourceFormDefaults";

interface Props {
  projectId?: string;
  sourceId?: string; // undefined → create mode; defined → edit mode
  /** Collection endpoint; defaults to the project's /sources. The shared
   *  library passes "/api/resources". Items live at `${apiPath}/${id}`. */
  apiPath?: string;
  /** Where Cancel / save / delete go; defaults to the project's Sources tab. */
  listHref?: string;
  initial: SourceFormInitial;
  /** When provided, called instead of navigating to the listing page on
   *  successful create/edit. router.refresh() is still called. */
  onSuccess?: () => void;
  /** When provided, the Cancel control is a button calling this instead
   *  of a Link to the listing page. */
  onCancel?: () => void;
}

interface FieldErr {
  field?: string;
  message: string;
}

export function SourceForm({
  projectId,
  sourceId,
  apiPath,
  listHref,
  initial,
  onSuccess,
  onCancel,
}: Props) {
  const router = useRouter();
  const isEdit = !!sourceId;
  const collectionUrl = apiPath ?? `/api/projects/${projectId}/sources`;
  const backHref = listHref ?? `/projects/${projectId}/sources`;
  const [form, setForm] = useState<SourceFormInitial>(initial);
  const [countries, setCountries] = useState<string[]>(initial.countries);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);

  function set<K extends keyof SourceFormInitial>(
    key: K,
    value: SourceFormInitial[K]
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setBusy(true);
    try {
      const body = JSON.stringify({ ...form, countries });

      const url = isEdit ? `${collectionUrl}/${sourceId}` : collectionUrl;
      const res = await apiFetch(url, {
        method: isEdit ? "PATCH" : "POST",
        body,
      });

      if (res.status === 429) {
        const b = await res.json().catch(() => ({}));
        setErrors([
          {
            message: `Source quota reached (${b.used}/${b.max}). Delete one first.`,
          },
        ]);
        return;
      }
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

      router.refresh();
      if (onSuccess) {
        onSuccess();
      } else {
        router.push(backHref);
      }
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!sourceId) return;
    if (!confirm(`Delete "${form.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`${collectionUrl}/${sourceId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErrors([{ message: b.error || `Delete failed (${res.status})` }]);
        return;
      }
      router.push(backHref);
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
      className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-5 shadow-card"
    >
      <Row label="Name" error={errFor("name")} required>
        <input
          type="text"
          required
          maxLength={120}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Saudi Aramco"
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
        />
      </Row>

      <Row label="Careers URL" error={errFor("careers_url")} required hint="The careers search page to scrape (filtered to the roles you want, if the site allows) — not the homepage.">
        <input
          type="url"
          required
          value={form.careers_url}
          onChange={(e) => set("careers_url", e.target.value)}
          placeholder="https://careers.aramco.com/search/?q=hse"
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
        />
      </Row>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Row label="ATS / parser type" error={errFor("ats")} required>
          <select
            value={form.ats}
            onChange={(e) =>
              set("ats", e.target.value as SourceFormInitial["ats"])
            }
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
          >
            <option value="successfactors">SAP SuccessFactors</option>
            <option value="jibe">Jibe / iCIMS</option>
            <option value="unknown">Unknown (won&apos;t be scraped yet)</option>
          </select>
        </Row>

        <Row label="Kind">
          <select
            value={form.kind}
            onChange={(e) =>
              set("kind", e.target.value as SourceFormInitial["kind"])
            }
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
          >
            <option value="employer">Employer</option>
            <option value="agency">Recruitment agency</option>
            <option value="feed">Feed / aggregator</option>
          </select>
        </Row>
      </div>

      <Row label="Countries" hint="Type to search; pick as many as apply.">
        <CountrySelect value={countries} onChange={setCountries} />
      </Row>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Row label="Headquarters">
          <input
            type="text"
            value={form.headquarters}
            onChange={(e) => set("headquarters", e.target.value)}
            placeholder="Dhahran"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
          />
        </Row>

        <Row label="Segment">
          <input
            type="text"
            value={form.segment}
            onChange={(e) => set("segment", e.target.value)}
            placeholder="Upstream, Downstream"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
          />
        </Row>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Row label="Website">
          <input
            type="url"
            value={form.website}
            onChange={(e) => set("website", e.target.value)}
            placeholder="https://www.aramco.com"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
          />
        </Row>

        <Row label="LinkedIn">
          <input
            type="url"
            value={form.linkedin}
            onChange={(e) => set("linkedin", e.target.value)}
            placeholder="https://www.linkedin.com/company/..."
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
          />
        </Row>
      </div>

      <Row label="Notes">
        <textarea
          rows={3}
          maxLength={2000}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Anything else worth remembering about this source."
          className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500 shadow-xs"
        />
      </Row>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="active"
          checked={form.active}
          onChange={(e) => set("active", e.target.checked)}
          className="w-4 h-4"
        />
        <label htmlFor="active" className="text-sm">
          Active{" "}
          <span className="text-zinc-500">
            — uncheck to keep configured but skip during scrapes
          </span>
        </label>
      </div>

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
            {deleting ? "Deleting…" : "Delete source"}
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 bg-white dark:bg-zinc-900 shadow-xs font-medium"
            >
              Cancel
            </button>
          ) : (
            <Link
              href={backHref}
              className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 bg-white dark:bg-zinc-900 shadow-xs font-medium"
            >
              Cancel
            </Link>
          )}
          <button
            type="submit"
            disabled={busy || deleting || !form.name.trim() || !form.careers_url.trim()}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
          >
            {busy ? "Saving…" : isEdit ? "Save changes" : "Add source"}
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
