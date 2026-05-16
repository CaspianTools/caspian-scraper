"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";
import { humanizeCron } from "@/lib/cron/humanize";

interface Props {
  projectId: string;
  initial: {
    name: string;
    description: string;
    schedule_cron: string;
    enabled: boolean;
  };
}

interface FieldErr {
  field?: string;
  message: string;
}

const CRON_PRESETS = [
  { label: "Every day, early morning (04:30 UTC)", value: "30 4 * * *" },
  { label: "Every day, working hours (09:00 UTC)", value: "0 9 * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Every Monday morning", value: "0 4 * * 1" },
  { label: "Every weekday at 09:00 UTC", value: "0 9 * * 1-5" },
  { label: "Once a month, on the 1st", value: "0 4 1 * *" },
];

export function ProjectSettingsForm({ projectId, initial }: Props) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [scheduleCron, setScheduleCron] = useState(initial.schedule_cron);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setSuccess(null);
    setBusy(true);
    try {
      const res = await authedFetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          schedule_cron: scheduleCron.trim(),
          enabled,
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
      setSuccess("Saved.");
      router.refresh();
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const confirmText = `delete ${initial.name}`;
    const typed = prompt(
      `This permanently deletes the project AND all its sources, destinations, secrets, runs, and lessons.\n\nType "${confirmText}" to confirm.`
    );
    if (typed !== confirmText) return;
    setDeleting(true);
    try {
      const res = await authedFetch(`/api/projects/${projectId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        alert(b.error || `Delete failed (${res.status})`);
        return;
      }
      router.push("/");
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  const errFor = (field: string) =>
    errors.find((e) => e.field === field)?.message;

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleSave}
        className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-5"
      >
        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <input
            type="text"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
          {errFor("name") && (
            <p className="mt-1 text-xs text-red-600">{errFor("name")}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            Description{" "}
            <span className="text-zinc-500 font-normal">(optional)</span>
          </label>
          <textarea
            rows={3}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            When should it run?
          </label>
          <p className="text-xs text-zinc-500 mb-3">
            Pick a preset, or write your own schedule below. All times in UTC. Minimum: 1 run per hour.
          </p>
          <div className="flex flex-wrap gap-2 mb-4">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setScheduleCron(p.value)}
                className={
                  "text-xs px-2.5 py-1.5 rounded-full border transition-colors " +
                  (scheduleCron === p.value
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-black"
                    : "border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900")
                }
              >
                {p.label}
              </button>
            ))}
          </div>
          <details className="group">
            <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300 select-none list-none flex items-center gap-1">
              <span className="group-open:rotate-90 transition-transform inline-block">
                ▸
              </span>
              Custom schedule (cron expression)
            </summary>
            <input
              type="text"
              required
              value={scheduleCron}
              onChange={(e) => setScheduleCron(e.target.value)}
              className="mt-2 w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </details>

          <div className="mt-3 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-3 py-2 text-sm">
            <span className="text-xs uppercase tracking-wide text-zinc-500 mr-2">
              Runs:
            </span>
            <span className="text-zinc-900 dark:text-zinc-100">
              {humanizeCron(scheduleCron)}
            </span>
          </div>
          {errFor("schedule_cron") && (
            <p className="mt-2 text-xs text-red-600">
              {errFor("schedule_cron")}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="w-4 h-4"
          />
          <label htmlFor="enabled" className="text-sm">
            Enabled{" "}
            <span className="text-zinc-500">
              — uncheck to pause scrapes without deleting the project
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

        {success && (
          <p className="text-sm text-emerald-700 dark:text-emerald-400">
            {success}
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>

      <div className="rounded-2xl border border-red-200 dark:border-red-900/40 bg-red-50/50 dark:bg-red-950/20 p-6">
        <h3 className="text-base font-medium text-red-900 dark:text-red-300">
          Danger zone
        </h3>
        <p className="text-sm text-red-800 dark:text-red-400 mt-1 mb-4">
          Permanently delete this project and everything in it — sources,
          destinations, secrets, runs, lessons. This cannot be undone.
        </p>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="inline-flex items-center h-10 px-4 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
        >
          {deleting ? "Deleting…" : "Delete this project"}
        </button>
      </div>
    </div>
  );
}
