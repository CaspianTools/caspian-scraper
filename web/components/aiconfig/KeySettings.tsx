"use client";

import { useEffect, useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";

interface FieldErr {
  field?: string;
  message: string;
}

/** Millis from a Firestore Timestamp / {_seconds} / ISO string / number / 0. */
function millis(v: unknown): number {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  const o = v as { toMillis?: () => number; _seconds?: number; seconds?: number };
  if (typeof o.toMillis === "function") return o.toMillis();
  if (typeof o._seconds === "number") return o._seconds * 1000;
  if (typeof o.seconds === "number") return o.seconds * 1000;
  return 0;
}

function fmtWhen(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

interface KeyState {
  configured: boolean;
  hint?: string;
  updated_at?: unknown;
}

/**
 * Anthropic API key card. The key is stored write-only: GET only ever reports
 * whether one is set plus a masked hint, never the raw value. Reads/writes go
 * through /api/aiconfig/key (admin-SDK route; owner == session.uid enforced).
 */
export function KeySettings() {
  const [state, setState] = useState<KeyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await authedFetch("/api/aiconfig/key");
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors([{ message: b.error || `Request failed (${res.status})` }]);
        return;
      }
      setState({
        configured: !!b.configured,
        hint: b.hint,
        updated_at: b.updated_at,
      });
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await authedFetch("/api/aiconfig/key");
        const b = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setErrors([{ message: b.error || `Request failed (${res.status})` }]);
          return;
        }
        setState({
          configured: !!b.configured,
          hint: b.hint,
          updated_at: b.updated_at,
        });
      } catch (e) {
        if (!cancelled)
          setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setSavedMsg(null);
    setBusy(true);
    try {
      const res = await authedFetch("/api/aiconfig/key", {
        method: "PUT",
        body: JSON.stringify({ value }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
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
      setValue("");
      setSavedMsg("Key saved. It's stored write-only and won't be shown again.");
      await load();
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!confirm("Remove the stored Anthropic API key? The AI setup agent will stop working until you set a new one.")) {
      return;
    }
    setErrors([]);
    setSavedMsg(null);
    setRemoving(true);
    try {
      const res = await authedFetch("/api/aiconfig/key", { method: "DELETE" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErrors([{ message: b.error || `Request failed (${res.status})` }]);
        return;
      }
      setState({ configured: false });
      setSavedMsg("Key removed.");
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setRemoving(false);
    }
  }

  const errFor = (field: string) =>
    errors.find((e) => e.field === field)?.message;
  const generalErrors = errors.filter((e) => !e.field);
  const updatedMs = state?.updated_at ? millis(state.updated_at) : 0;

  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-5">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">
          Anthropic API key
        </h3>
        <p className="text-xs text-zinc-500 mt-1 max-w-xl">
          Used only by the AI setup agent (the GitHub Actions job) to inspect
          sites and propose scraper configs. It&apos;s stored{" "}
          <strong>write-only</strong> — encrypted at rest and never returned to
          the browser, so it can&apos;t be shown again after you save it.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 flex items-center gap-3 flex-wrap">
          <span
            className={
              "text-xs px-2 py-0.5 rounded-full " +
              (state?.configured
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300")
            }
          >
            {state?.configured ? "Configured" : "No key set"}
          </span>
          {state?.configured && state.hint && (
            <code className="text-xs text-zinc-600 dark:text-zinc-400">
              {state.hint}
            </code>
          )}
          {state?.configured && updatedMs > 0 && (
            <span className="text-xs text-zinc-500">
              updated {fmtWhen(updatedMs)}
            </span>
          )}
          {state?.configured && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={removing}
              className="ml-auto text-sm px-3 h-9 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
            >
              {removing ? "Removing…" : "Remove"}
            </button>
          )}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="aiconfig-key">
            {state?.configured ? "Replace key" : "API key"}
          </label>
          <p className="text-xs text-zinc-500 mb-2">
            Starts with <code className="text-xs">sk-</code>. Paste it once; it
            won&apos;t be displayed again.
          </p>
          <input
            id="aiconfig-key"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="sk-ant-…"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
          />
          {errFor("value") && (
            <p className="mt-1 text-xs text-red-600">{errFor("value")}</p>
          )}
        </div>

        {generalErrors.map((e, i) => (
          <p key={i} className="text-sm text-red-600">
            {e.message}
          </p>
        ))}

        {savedMsg && (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            {savedMsg}
          </p>
        )}

        <div className="flex justify-end pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {busy ? "Saving…" : state?.configured ? "Replace key" : "Save key"}
          </button>
        </div>
      </form>
    </section>
  );
}
