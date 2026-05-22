"use client";

import { useEffect, useMemo, useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";

interface FieldErr {
  field?: string;
  message: string;
}

interface ReferencedName {
  name: string;
  destinations: string[];
}

const NAME_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CUSTOM_NAME_SENTINEL = "__custom__";

interface Props {
  projectId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export function QuickAddSecretForm({ projectId, onSuccess, onCancel }: Props) {
  // Load context: existing secret names + destinations that reference
  // secrets by name. The dropdown prefers names a destination is
  // already waiting for; the user only types a custom name if needed.
  const [existingSecrets, setExistingSecrets] = useState<Set<string> | null>(
    null
  );
  const [referencedNames, setReferencedNames] = useState<ReferencedName[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [secretsRes, destsRes] = await Promise.all([
          authedFetch(`/api/projects/${projectId}/secrets`),
          authedFetch(`/api/projects/${projectId}/destinations`),
        ]);
        if (!secretsRes.ok || !destsRes.ok) {
          setLoadError(
            `Failed to load project context (${secretsRes.status}/${destsRes.status})`
          );
          return;
        }
        const secretsBody = (await secretsRes.json()) as {
          secrets?: { name: string }[];
        };
        const destsBody = (await destsRes.json()) as {
          destinations?: { name?: string; secret_ref?: string }[];
        };

        if (cancelled) return;

        const names = new Set((secretsBody.secrets ?? []).map((s) => s.name));
        const refMap = new Map<string, string[]>();
        for (const d of destsBody.destinations ?? []) {
          const ref = d.secret_ref?.trim();
          if (!ref) continue;
          const list = refMap.get(ref) ?? [];
          list.push(d.name || "(unnamed destination)");
          refMap.set(ref, list);
        }
        const refs: ReferencedName[] = Array.from(refMap.entries()).map(
          ([name, destinations]) => ({ name, destinations })
        );

        setExistingSecrets(names);
        setReferencedNames(refs);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const missing = useMemo(
    () =>
      existingSecrets
        ? referencedNames.filter((r) => !existingSecrets.has(r.name))
        : [],
    [referencedNames, existingSecrets]
  );
  const referencedAndSet = useMemo(
    () =>
      existingSecrets
        ? referencedNames.filter((r) => existingSecrets.has(r.name))
        : [],
    [referencedNames, existingSecrets]
  );

  const useDropdown = referencedNames.length > 0;
  const initialNameSelection =
    missing[0]?.name ??
    referencedAndSet[0]?.name ??
    CUSTOM_NAME_SENTINEL;

  const [nameSelection, setNameSelection] = useState<string>(
    CUSTOM_NAME_SENTINEL
  );
  const [customName, setCustomName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);

  // Once the load resolves, pick a sensible default for the dropdown.
  useEffect(() => {
    if (existingSecrets === null) return;
    setNameSelection(useDropdown ? initialNameSelection : CUSTOM_NAME_SENTINEL);
  }, [existingSecrets, useDropdown, initialNameSelection]);

  const resolvedName =
    nameSelection === CUSTOM_NAME_SENTINEL ? customName.trim() : nameSelection;

  const isReplacingExisting =
    nameSelection !== CUSTOM_NAME_SENTINEL &&
    (existingSecrets?.has(nameSelection) ?? false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);

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
        `/api/projects/${projectId}/secrets/${encodeURIComponent(resolvedName)}`,
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
      onSuccess();
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  const errFor = (field: string) =>
    errors.find((e) => e.field === field)?.message;

  if (loadError) {
    return <p className="text-sm text-red-600">{loadError}</p>;
  }
  if (existingSecrets === null) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {useDropdown && (
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
            <option value={CUSTOM_NAME_SENTINEL}>Custom name…</option>
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
            Pick a name a destination is already waiting for, or enter a
            custom one. Destinations reference secrets by this name.
          </p>
        </div>
      )}

      {!useDropdown && (
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
          The value is stored encrypted at rest and never shown again from
          this UI. You can replace it any time.
        </p>
      </div>

      {errors
        .filter((e) => !e.field)
        .map((e, i) => (
          <p key={i} className="text-sm text-red-600">
            {e.message}
          </p>
        ))}

      <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {busy
            ? "Saving…"
            : isReplacingExisting
            ? "Save new value"
            : "Add secret"}
        </button>
      </div>
    </form>
  );
}
