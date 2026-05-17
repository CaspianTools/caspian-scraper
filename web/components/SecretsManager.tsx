"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";

export interface SecretListItem {
  name: string;
  updated_at: string;
}

export interface ReferencedName {
  name: string;
  destinations: string[];
}

interface Props {
  projectId: string;
  secrets: SecretListItem[];
  /**
   * Secret names that one or more destinations reference. The "Add a
   * secret" form prefers picking from this list — the user has
   * already decided the name elsewhere, no need to retype it.
   */
  referencedNames: ReferencedName[];
}

interface FieldErr {
  field?: string;
  message: string;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CUSTOM_NAME_SENTINEL = "__custom__";

export function SecretsManager({
  projectId,
  secrets,
  referencedNames,
}: Props) {
  const router = useRouter();
  const existingSecretNames = useMemo(
    () => new Set(secrets.map((s) => s.name)),
    [secrets]
  );

  // Names that destinations want but no secret exists for yet — the
  // most useful entries to pick first.
  const missing = useMemo(
    () => referencedNames.filter((r) => !existingSecretNames.has(r.name)),
    [referencedNames, existingSecretNames]
  );
  // Names that destinations reference AND already have a stored value
  // — picking one switches the form into replace-mode.
  const referencedAndSet = useMemo(
    () => referencedNames.filter((r) => existingSecretNames.has(r.name)),
    [referencedNames, existingSecretNames]
  );

  // Pick form mode: dropdown if any destination references exist,
  // free-text otherwise. The user can still escape to custom name.
  const useDropdown = referencedNames.length > 0;

  // Default the dropdown to the first "missing" name; falls back to
  // the first referenced name; falls back to custom.
  const initialNameSelection =
    missing[0]?.name ??
    referencedAndSet[0]?.name ??
    CUSTOM_NAME_SENTINEL;

  const [nameSelection, setNameSelection] = useState<string>(
    useDropdown ? initialNameSelection : CUSTOM_NAME_SENTINEL
  );
  const [customName, setCustomName] = useState("");
  const [value, setValue] = useState("");
  const [overwriteName, setOverwriteName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);
  const [success, setSuccess] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  // Resolve the secret name the form will write to.
  const resolvedName = overwriteName
    ?? (nameSelection === CUSTOM_NAME_SENTINEL ? customName.trim() : nameSelection);

  const isReplacingExisting =
    !!overwriteName ||
    (nameSelection !== CUSTOM_NAME_SENTINEL &&
      existingSecretNames.has(nameSelection));

  function resetForm() {
    setOverwriteName(null);
    setNameSelection(
      useDropdown ? initialNameSelection : CUSTOM_NAME_SENTINEL
    );
    setCustomName("");
    setValue("");
    setErrors([]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setSuccess(null);

    if (!NAME_RE.test(resolvedName)) {
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
        `/api/projects/${projectId}/secrets/${encodeURIComponent(
          resolvedName
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
      setSuccess(`Saved ${resolvedName}.`);
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

  // Helper: human description of who needs this name.
  const referenceDescriptionFor = (n: string): string => {
    const r = referencedNames.find((x) => x.name === n);
    if (!r) return "";
    if (r.destinations.length === 1) return `used by ${r.destinations[0]}`;
    return `used by ${r.destinations.length} destinations`;
  };

  return (
    <div className="space-y-6">
      {secrets.length > 0 && (
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
                    {referenceDescriptionFor(s.name) && (
                      <div className="text-xs text-zinc-500">
                        {referenceDescriptionFor(s.name)}
                      </div>
                    )}
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
          ) : isReplacingExisting && resolvedName ? (
            <>
              Replace value for{" "}
              <code className="text-sm">{resolvedName}</code>
            </>
          ) : (
            "Add a secret"
          )}
        </h3>

        {!overwriteName && useDropdown && (
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <select
              value={nameSelection}
              onChange={(e) => setNameSelection(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
            >
              {missing.length > 0 && (
                <optgroup label="Referenced by destinations (not set yet)">
                  {missing.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name} — {r.destinations.join(", ")}
                    </option>
                  ))}
                </optgroup>
              )}
              {referencedAndSet.length > 0 && (
                <optgroup label="Referenced by destinations (already set — will replace)">
                  {referencedAndSet.map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name} — {r.destinations.join(", ")}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={CUSTOM_NAME_SENTINEL}>
                Custom name…
              </option>
            </select>

            {nameSelection === CUSTOM_NAME_SENTINEL && (
              <input
                type="text"
                required
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="MY_API_KEY"
                className="mt-2 w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
              />
            )}

            {errFor("name") && (
              <p className="mt-1 text-xs text-red-600">{errFor("name")}</p>
            )}
            <p className="mt-1 text-xs text-zinc-500">
              Pick a name a destination is already waiting for, or enter
              a custom one. Destinations reference secrets by this name.
            </p>
          </div>
        )}

        {!overwriteName && !useDropdown && (
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              required
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="ENTIRELYSAFE_API_KEY"
              className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            {errFor("name") && (
              <p className="mt-1 text-xs text-red-600">{errFor("name")}</p>
            )}
            <p className="mt-1 text-xs text-zinc-500">
              No destination references a secret yet. Add a destination
              first to pick from a dropdown here, or type a custom name.
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
              onClick={resetForm}
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
            {busy
              ? "Saving…"
              : overwriteName || isReplacingExisting
              ? "Save new value"
              : "Add secret"}
          </button>
        </div>
      </form>
    </div>
  );
}
