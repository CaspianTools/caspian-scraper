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
  { id: "kimi", label: "Kimi (Moonshot AI)" },
  { id: "openai_compatible", label: "OpenAI-compatible (custom endpoint)" },
];

// Suggested models per provider, best default first — free text is allowed
// too (datalist). Checked Oct 2026 against each provider's model list;
// mirrored in aiconfig/providers/__init__.py (MODEL_CATALOG).
const MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  openai: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
  gemini: [
    "gemini-4-argon",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite",
  ],
  kimi: ["kimi-k3", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"],
  openai_compatible: [],
};

// The model <select> value that switches to a free-text model id.
const CUSTOM_MODEL = "__custom__";

const KEY_HINTS: Record<string, string> = {
  anthropic: "Anthropic key (starts with sk-ant-) — console.anthropic.com",
  openai: "OpenAI key (starts with sk-) — platform.openai.com",
  gemini: "Google AI Studio key (starts with AIza) — aistudio.google.com",
  kimi: "Kimi Open Platform key (starts with sk-) — platform.kimi.ai",
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
 * AI provider + key card.
 *
 * Managing the key is restricted to the workspace owner — it's the key that
 * gets billed. Admins see an explanatory note instead. The form is split into
 * its own component so its mount-time fetch never fires for someone who would
 * only get a 403 back. Real enforcement lives in /api/aiconfig/key.
 */
export function KeySettings({ canManage }: { canManage: boolean }) {
  return canManage ? <KeyForm /> : <KeyLocked />;
}

function KeyLocked() {
  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-2 shadow-card">
      <h3 className="text-sm font-semibold tracking-tight">AI provider &amp; key</h3>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-xl">
        Scrapes with <strong>Use AI</strong>{" "}on run on a provider key managed
        by the workspace owner. You can use them normally — you just can&apos;t
        view or change the key itself.
      </p>
      <p className="text-xs text-zinc-500">
        Need it pointed at a different provider or model? Ask the workspace
        owner.
      </p>
    </section>
  );
}

/**
 * Pick a provider (Anthropic / OpenAI / Gemini / any OpenAI-compatible
 * endpoint) and a model. The key is stored write-only: GET reports only
 * whether one is set + a masked hint, never the raw value.
 */
function KeyForm() {
  const [state, setState] = useState<KeyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState(MODELS.anthropic[0]);
  // "Custom model…" chosen in the dropdown (a saved model that isn't in the
  // list counts as custom too, see isCustom).
  const [customPicked, setCustomPicked] = useState(false);
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
    setCustomPicked(false);
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
    if (!confirm("Remove the stored key? Scrapes with Use AI on will fail until you set a new one.")) {
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
  const suggestions = MODELS[provider] ?? [];
  const isCustom = customPicked || !suggestions.includes(model);
  const inputBase =
    "w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm shadow-xs";

  return (
    <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-5 shadow-card">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">AI provider &amp; key</h3>
        <p className="text-xs text-zinc-500 mt-1 max-w-xl">
          The model used by scrapes that have <strong>Use AI</strong>{" "}on (it&apos;s
          off by default) and by <strong>AI tag</strong>{" "}on findings. Nothing else in the
          app needs a key. The key is stored{" "}
          <strong>write-only</strong>{" "}in <code>local-data/</code>{" "}on this computer (never
          committed) and never returned to the browser, so it can&apos;t be shown again
          after you save it.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 flex items-center gap-3 flex-wrap">
          <span
            className={
              "text-xs font-medium px-2 py-0.5 rounded-full " +
              (state?.configured
                ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25"
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
            {/* A real dropdown: a datalist only lists suggestions matching what's
                already typed, so a pre-filled model hid all the others. */}
            {suggestions.length > 0 && (
              <select
                id="ai-model"
                value={isCustom ? CUSTOM_MODEL : model}
                onChange={(e) => {
                  const v = e.target.value;
                  setCustomPicked(v === CUSTOM_MODEL);
                  setModel(v === CUSTOM_MODEL ? "" : v);
                }}
                className={`${inputBase} font-mono`}
              >
                {suggestions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>Custom model…</option>
              </select>
            )}
            {isCustom && (
              <input
                id={suggestions.length > 0 ? "ai-model-custom" : "ai-model"}
                aria-label="Model id"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="model id"
                className={`${inputBase} font-mono ${suggestions.length > 0 ? "mt-2" : ""}`}
              />
            )}
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
            {KEY_HINTS[provider]}{" "}— paste once; it won&apos;t be displayed again.
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
            className="inline-flex items-center h-10 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
          >
            {busy ? "Saving…" : state?.configured ? "Update" : "Save key"}
          </button>
        </div>
      </form>
    </section>
  );
}
