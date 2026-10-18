"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";

export interface SecretListItem {
  name: string;
  updated_at: string;
}

interface Props {
  projectId: string;
  secrets: SecretListItem[];
}

interface FieldErr {
  field?: string;
  message: string;
}

/**
 * Inline list + Replace + Delete UI for project secrets. The "Add a
 * secret" flow lives in the global Quick Add popup; this component
 * handles only ongoing maintenance of existing secrets.
 */
export function SecretsManager({ projectId, secrets }: Props) {
  const router = useRouter();
  const [overwriteName, setOverwriteName] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);
  const [success, setSuccess] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  function resetForm() {
    setOverwriteName(null);
    setValue("");
    setErrors([]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setSuccess(null);

    if (!overwriteName) return;
    if (!value) {
      setErrors([{ field: "value", message: "Value can't be empty." }]);
      return;
    }

    setBusy(true);
    try {
      const res = await authedFetch(
        `/api/projects/${projectId}/secrets/${encodeURIComponent(
          overwriteName
        )}`,
        { method: "PUT", body: JSON.stringify({ value }) }
      );
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
          setErrors([
            { message: b.error || `Request failed (${res.status})` },
          ]);
        }
        return;
      }
      setSuccess(`Saved ${overwriteName}.`);
      resetForm();
      router.refresh();
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(secretName: string) {
    if (
      !confirm(
        `Delete secret "${secretName}"? Destinations referencing it will fail.`
      )
    ) {
      return;
    }
    setDeletingName(secretName);
    try {
      const res = await authedFetch(
        `/api/projects/${projectId}/secrets/${encodeURIComponent(secretName)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        alert(b.error || `Delete failed (${res.status})`);
        return;
      }
      router.refresh();
    } finally {
      setDeletingName(null);
    }
  }

  const errFor = (field: string) =>
    errors.find((e) => e.field === field)?.message;

  return (
    <div className="space-y-6">
      {secrets.length > 0 ? (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Value</th>
                <th className="text-left px-4 py-2 font-medium">
                  Last updated
                </th>
                <th className="text-right px-4 py-2 font-medium w-px"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {secrets.map((s) => (
                <tr
                  key={s.name}
                  className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                >
                  <td className="px-4 py-3">
                    <div className="font-mono">{s.name}</div>
                  </td>
                  <td className="px-4 py-3 text-zinc-500">••••••••</td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {s.updated_at || "—"}
                  </td>
                  <td className="px-4 py-3 text-right space-x-3 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => {
                        setOverwriteName(s.name);
                        setValue("");
                        setErrors([]);
                        setSuccess(null);
                      }}
                      className="text-sm text-zinc-700 dark:text-zinc-300 hover:underline"
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(s.name)}
                      disabled={deletingName === s.name}
                      className="text-sm text-red-600 hover:underline disabled:opacity-50"
                    >
                      {deletingName === s.name ? "Deleting…" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md mx-auto">
            No secrets yet. Use <span className="font-medium">+ Add secret</span>{" "}
            above to add an API key or token this project needs.
          </p>
        </div>
      )}

      {overwriteName && (
        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-4"
        >
          <h3 className="text-base font-medium">
            Replace value for{" "}
            <code className="text-sm">{overwriteName}</code>
          </h3>

          <div>
            <label className="block text-sm font-medium mb-1">Value</label>
            <input
              type="password"
              required
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="es_live_…"
              className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            {errFor("value") && (
              <p className="mt-1 text-xs text-red-600">{errFor("value")}</p>
            )}
            <p className="mt-1 text-xs text-zinc-500">
              The value is stored encrypted at rest and never shown again
              from this UI.
            </p>
          </div>

          {errors
            .filter((e) => !e.field)
            .map((e, i) => (
              <p key={i} className="text-sm text-red-600">
                {e.message}
              </p>
            ))}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={resetForm}
              className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              {busy ? "Saving…" : "Save new value"}
            </button>
          </div>
        </form>
      )}

      {success && !overwriteName && (
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          {success}
        </p>
      )}
    </div>
  );
}
