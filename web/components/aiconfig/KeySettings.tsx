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
  return ms ? new Date(ms).toLocaleString() : "";
}

const PROVIDERS: { id: string; label: string }[] = [
  { id: "anthropic", label: "Anthropic (Claude)" },
  { id: "openai", label: "OpenAI (GPT)" },
  { id: "gemini", label: "Google (Gemini)" },
  { id: "openai_compatible", label: "OpenAI-compatible (custom endpoint)" },
];

// Suggested models per provider — free text is allowed too (datalist).
const MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini", "o3"],
  gemini: [
    "gemini-3.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
    "gemini-3.1-pro-preview",
  ],
  openai_compatible: [],
};

const KEY_HINTS: Record<string, string> = {
  anthropic: "Anthropic key (starts with sk-ant-) — console.anthropic.com",
  openai: "OpenAI key (starts with sk-) — platform.openai.com",
  gemini: "Google AI Studio key (starts with AIza) — aistudio.google.com",
  openai_compatible: "API key for your endpoint (OpenRouter, Groq, DeepSeek, local vLLM/Ollama, …)",
};

interface KeyState {
  configured: boolean;
  provider?: string;
  model?: string;
  base_url?: string;
  hint?: string;
  updated_at?: unknown;
}

/**
 * AI provider + key card. Pick a provider (Anthropic / OpenAI / Gemini / any
 * OpenAI-compatible endpoint) and a model. The key is stored write-only: GET
 * reports only whether one is set + a masked hint, never the raw value.
 */
export function KeySettings() {
  const [state, setState] = useState<KeyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState(MODELS.anthropic[0]);
  const [baseUrl, setBaseUrl] = useState("");
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
      setState(b as KeyState);
      if (b.configured) {
        setProvider(b.provider || "anthropic");
        // Reflect exactly what's saved (don't substitute a default for "").
        setModel(b.model || "");
        setBaseUrl(b.base_url || "");
      }
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch("/api/aiconfig/key");
        const b = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setErrors([{ message: b.error || `Request failed (${res.status})` }]);
          return;
        }
        setState(b as KeyState);
        if (b.configured) {
          setProvider(b.provider || "anthropic");
          setModel(b.model || MODELS[b.provider as string]?.[0] || "");
          setBaseUrl(b.base_url || "");
        }
      } catch (e) {
        if (!cancelled) setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function onProviderChange(next: string) {
    setProvider(next);
    // Snap the model to the new provider's first suggestion.
    setModel(MODELS[next]?.[0] ?? "");
    if (next !== "openai_compatible") setBaseUrl("");
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setSavedMsg(null);
    setBusy(true);
    try {
      const res = await authedFetch("/api/aiconfig/key", {
        method: "PUT",
        body: JSON.stringify({ provider, model, base_url: baseUrl, value }),
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
      setSavedMsg("Saved. The key is stored write-only and won't be shown again.");
      await load();
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!confirm("Remove the stored key? The AI setup agent will stop working until you set a new one.")) {
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

  const errFor = (field: string) => errors.find((e) => e.field === field)?.message;
  // General bucket = field-less errors PLUS any field error we don't render next
  // to a specific input, so nothing is silently swallowed.
  const RENDERED_FIELDS = ["base_url", "value", "model"];
  const generalErrors = errors.filter(
    (e) => !e.field || !RENDERED_FIELDS.includes(e.field)
  );
  const updatedMs = state?.updated_at ? millis(state.updated_at) : 0;
  const providerLabel =
    PROVIDERS.find((p) => p.id === state?.provider)?.label || state?.provider;
  const inputBase =
    "w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm";

  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-5">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">AI provider &amp; key</h3>
        <p className="text-xs text-zinc-500 mt-1 max-w-xl">
          Choose the model provider the AI setup agent uses. The key is stored{" "}
          <strong>write-only</strong> — encrypted at rest and never returned to the
          browser, so it can&apos;t be shown again after you save it.
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
          {state?.configured && (
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              {providerLabel}
              {state.model ? ` · ${state.model}` : ""}
            </span>
          )}
          {state?.configured && state.hint && (
            <code className="text-xs text-zinc-500">{state.hint}</code>
          )}
          {state?.configured && updatedMs > 0 && (
            <span className="text-xs text-zinc-500">updated {fmtWhen(updatedMs)}</span>
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

      <form onSubmit={handleSave} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="ai-provider">
              Provider
            </label>
            <select
              id="ai-provider"
              value={provider}
              onChange={(e) => onProviderChange(e.target.value)}
              className={inputBase}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="ai-model">
              Model
            </label>
            <input
              id="ai-model"
              list="ai-model-options"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model id"
              className={`${inputBase} font-mono`}
            />
            <datalist id="ai-model-options">
              {(MODELS[provider] ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {errFor("model") && (
              <p className="mt-1 text-xs text-red-600">{errFor("model")}</p>
            )}
          </div>
        </div>

        {provider === "openai_compatible" && (
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="ai-base-url">
              Base URL
            </label>
            <input
              id="ai-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://openrouter.ai/api/v1"
              className={`${inputBase} font-mono`}
            />
            {errFor("base_url") && (
              <p className="mt-1 text-xs text-red-600">{errFor("base_url")}</p>
            )}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="ai-key">
            {state?.configured ? "Replace API key" : "API key"}
          </label>
          <p className="text-xs text-zinc-500 mb-2">
            {KEY_HINTS[provider]} — paste once; it won&apos;t be displayed again.
          </p>
          <input
            id="ai-key"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="paste your API key"
            className={`${inputBase} font-mono`}
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
          <p className="text-xs text-emerald-700 dark:text-emerald-400">{savedMsg}</p>
        )}

        <div className="flex justify-end pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {busy ? "Saving…" : state?.configured ? "Update" : "Save key"}
          </button>
        </div>
      </form>
    </section>
  );
}
