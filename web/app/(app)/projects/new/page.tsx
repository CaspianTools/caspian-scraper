"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";
import { SchedulePicker } from "@/components/SchedulePicker";

interface FieldErr {
  field?: string;
  message: string;
}

export default function NewProjectPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scheduleCron, setScheduleCron] = useState("0 */6 * * *");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setBusy(true);
    try {
      const res = await authedFetch("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          schedule_cron: scheduleCron.trim(),
          enabled,
          hse_keywords: [],
        }),
      });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        setErrors([
          {
            message: `Quota reached (${body.used}/${body.max} projects). Delete or upgrade.`,
          },
        ]);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.details && Array.isArray(body.details)) {
          setErrors(
            body.details.map((d: { path?: string[]; message: string }) => ({
              field: d.path?.join("."),
              message: d.message,
            }))
          );
        } else {
          setErrors([{ message: body.error || `Request failed (${res.status})` }]);
        }
        return;
      }
      const created = await res.json();
      router.push(`/projects/${created.id}`);
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  const errFor = (field: string) =>
    errors.find((e) => e.field === field)?.message;

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-black p-6">
      <div className="max-w-2xl mx-auto">
        <Link
          href="/"
          className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline mb-6 inline-block"
        >
          ← Projects
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight mb-6">
          New project
        </h1>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-6"
        >
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="HSE Jobs Middle East"
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
              placeholder="What does this scraper publish, and where?"
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
              Enable scraping right away
            </label>
          </div>

          {errors
            .filter((e) => !e.field)
            .map((e, i) => (
              <p key={i} className="text-sm text-red-600">
                {e.message}
              </p>
            ))}

          <div className="flex justify-end gap-2">
            <Link
              href="/"
              className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              {busy ? "Creating…" : "Create project"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
