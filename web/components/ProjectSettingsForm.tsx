"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";
import { SchedulePicker } from "@/components/SchedulePicker";

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

        <SchedulePicker
          value={scheduleCron}
          onChange={setScheduleCron}
          errorMessage={errFor("schedule_cron")}
        />

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
