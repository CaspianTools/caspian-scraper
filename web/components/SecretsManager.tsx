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

const NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function SecretsManager({ projectId, secrets }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [overwriteName, setOverwriteName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);
  const [success, setSuccess] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const activeName = overwriteName ?? name.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setSuccess(null);

    if (!NAME_RE.test(activeName)) {
      setErrors([
        {
          field: "name",
          message:
            "Name must be 1-80 chars: letters, digits, underscore, dash.",
        },
      ]);
      return;
    }
    if (!value) {
      setErrors([{ field: "value", message: "Value can't be empty." }]);
      return;
    }

    setBusy(true);
    try {
      const res = await authedFetch(
        `/api/projects/${projectId}/secrets/${encodeURIComponent(activeName)}`,
        {
          method: "PUT",
          body: JSON.stringify({ value }),
        }
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
          setErrors([{ message: b.error || `Request failed (${res.status})` }]);
        }
        return;
      }
      setSuccess(`Saved ${activeName}.`);
      setName("");
      setValue("");
      setOverwriteName(null);
      router.refresh();
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(secretName: string) {
    if (!confirm(`Delete secret "${secretName}"? Destinations referencing it will fail.`)) {
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
      {secrets.length > 0 && (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Value</th>
                <th className="text-left px-4 py-2 font-medium">Last updated</th>
                <th className="text-right px-4 py-2 font-medium w-px"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {secrets.map((s) => (
                <tr
                  key={s.name}
                  className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                >
                  <td className="px-4 py-3 font-mono">{s.name}</td>
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
                        setName("");
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
      )}

      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-4"
      >
        <h3 className="text-base font-medium">
          {overwriteName ? (
            <>
              Replace value for{" "}
              <code className="text-sm">{overwriteName}</code>
            </>
          ) : (
            "Add a secret"
          )}
        </h3>

        {!overwriteName && (
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ENTIRELYSAFE_API_KEY"
              className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            {errFor("name") && (
              <p className="mt-1 text-xs text-red-600">{errFor("name")}</p>
            )}
            <p className="mt-1 text-xs text-zinc-500">
              Letters, digits, underscore, dash. Destinations refer to
              secrets by this name.
            </p>
          </div>
        )}

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
            from this UI. You can replace it any time.
          </p>
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

        <div className="flex justify-end gap-2">
          {overwriteName && (
            <button
              type="button"
              onClick={() => {
                setOverwriteName(null);
                setValue("");
                setErrors([]);
              }}
              className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {busy ? "Saving…" : overwriteName ? "Save new value" : "Add secret"}
          </button>
        </div>
      </form>
    </div>
  );
}
