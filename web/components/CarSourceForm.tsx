"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/firebase/clientFetch";
import { CAR_SITES, type CarSourceFormInitial } from "./carSourceFormDefaults";

// Type-only re-export — erased at compile time, so safe across the
// client/server boundary. The factory lives in carSourceFormDefaults
// (non-client) so server components can call it.
export type { CarSourceFormInitial } from "./carSourceFormDefaults";

interface Props {
  initial: CarSourceFormInitial;
  sourceId?: string;
}

interface FieldErr {
  field?: string;
  message: string;
}

export function CarSourceForm({ initial, sourceId }: Props) {
  const router = useRouter();
  const isEdit = !!sourceId;
  const [form, setForm] = useState<CarSourceFormInitial>(initial);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);

  function set<K extends keyof CarSourceFormInitial>(
    key: K,
    value: CarSourceFormInitial[K]
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setBusy(true);
    try {
      const body = JSON.stringify({
        ...form,
        country: form.country.trim().toLowerCase(),
        max_listings: Number(form.max_listings) || 50,
        posted_within_days: Number(form.posted_within_days),
      });
      const url = isEdit
        ? `/api/cars/sources/${sourceId}`
        : "/api/cars/sources";
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
      router.push("/cars/sources");
      router.refresh();
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleRunNow() {
    if (!sourceId) return;
    setBusy(true);
    try {
      const res = await authedFetch(`/api/cars/sources/${sourceId}/run-now`, {
        method: "POST",
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErrors([{ message: b.error || `Run-now failed (${res.status})` }]);
        return;
      }
      router.push("/cars/runs");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!sourceId) return;
    if (
      !confirm(
        `Delete "${form.name}"? Existing listings are kept; only future scrapes stop.`
      )
    )
      return;
    setDeleting(true);
    try {
      const res = await authedFetch(`/api/cars/sources/${sourceId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErrors([{ message: b.error || `Delete failed (${res.status})` }]);
        return;
      }
      router.push("/cars/sources");
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
          maxLength={120}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="OpenSooq Oman — Land Cruiser"
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
        />
      </Row>

      <Row label="Site" error={errFor("site")} required>
        <select
          value={form.site}
          onChange={(e) =>
            set("site", e.target.value as CarSourceFormInitial["site"])
          }
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
        >
          {CAR_SITES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </Row>

      <div className="grid grid-cols-2 gap-4">
        <Row
          label="Country"
          error={errFor("country")}
          required
          hint="ISO-2. These adapters currently cover Oman only."
        >
          <input
            type="text"
            required
            maxLength={2}
            value={form.country}
            onChange={(e) => set("country", e.target.value)}
            placeholder="om"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
          />
        </Row>
        <Row label="City" hint="Optional narrowing, e.g. muscat.">
          <input
            type="text"
            maxLength={80}
            value={form.city}
            onChange={(e) => set("city", e.target.value)}
            placeholder="muscat"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
          />
        </Row>
      </div>

      <Row
        label="Search query"
        hint="Optional free-text, e.g. 'land cruiser'. Leave blank to scrape all cars."
      >
        <input
          type="text"
          maxLength={200}
          value={form.query}
          onChange={(e) => set("query", e.target.value)}
          placeholder="land cruiser"
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
        />
      </Row>

      <div className="grid grid-cols-2 gap-4">
        <Row
          label="Max listings"
          error={errFor("max_listings")}
          required
          hint="Per scrape, 1–200."
        >
          <input
            type="number"
            required
            min={1}
            max={200}
            value={form.max_listings}
            onChange={(e) => set("max_listings", Number(e.target.value))}
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm tabular-nums"
          />
        </Row>
        <div className="flex items-end pb-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="with_details"
              checked={form.with_details}
              onChange={(e) => set("with_details", e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor="with_details" className="text-sm">
              Fetch full details{" "}
              <span className="text-zinc-500">
                — specs, photo gallery, description
              </span>
            </label>
          </div>
        </div>
      </div>

      <Row
        label="New listings only (days)"
        error={errFor("posted_within_days")}
        hint="Keep only cars first posted within this many days. 1 = today's new listings only; 0 = every listing (no date filter)."
      >
        <input
          type="number"
          min={0}
          max={30}
          value={form.posted_within_days}
          onChange={(e) => set("posted_within_days", Number(e.target.value))}
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm tabular-nums"
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
          onChange={(e) => set("schedule_cron", e.target.value)}
          placeholder="30 4 * * *"
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
        />
      </Row>

      <Row label="Notes">
        <textarea
          rows={2}
          maxLength={2000}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Optional context."
          className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
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
            — uncheck to keep configured but skip during scheduled scrapes
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
          {isEdit && (
            <button
              type="button"
              onClick={handleRunNow}
              disabled={busy || deleting}
              className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50"
            >
              Run now
            </button>
          )}
          <Link
            href="/cars/sources"
            className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={busy || deleting}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
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
