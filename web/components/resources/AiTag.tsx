"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

/**
 * AI tagging (ai_tag.py via /api/resources/ai-tag): tag findings from
 * criteria in plain words, on the provider + key from Settings.
 *
 *   planTags / applyTags   the two API steps (apply in chunks, for progress)
 *   auto-tag setting       criteria to tag every new search's results with
 *                          (kept in this browser), set in <AutoTagSettings>
 *                          or from the dialog
 *   <AiTagDialog>          write criteria → check the tags it reads → tag
 */

export interface TagRule {
  tag: string;
  criteria: string;
}

export interface AiTagResult {
  tags: Record<string, string[]>;
  counts: Record<string, number>;
  tagged: number;
  checked: number;
  skipped: number;
  errors: string[];
  cost_usd: number;
}

const CHUNK = 100;

async function post(body: Record<string, unknown>) {
  const res = await apiFetch("/api/resources/ai-tag", { method: "POST", body: JSON.stringify(body) });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(b.details?.[0]?.message || b.error || `AI tagging failed (${res.status})`);
  return b;
}

/** Criteria in plain words → the tag rules the AI reads from them. */
export async function planTags(
  criteria: string,
  database = "companies"
): Promise<{ rules: TagRule[]; note: string; cost_usd: number }> {
  return post({ mode: "plan", criteria, database });
}

/** Tag the companies by the rules, CHUNK at a time; `shouldStop` is checked
 *  between chunks. Saved to the findings database as it goes. */
export async function applyTags(
  rules: TagRule[],
  ids: string[],
  {
    replace = false,
    onProgress,
    shouldStop,
    database = "companies",
  }: {
    replace?: boolean;
    onProgress?: (done: number, total: number) => void;
    shouldStop?: () => boolean;
    /** Which database the records are in (db/<id>.jsonl). */
    database?: string;
  } = {}
): Promise<AiTagResult & { stopped: boolean }> {
  const total: AiTagResult = { tags: {}, counts: {}, tagged: 0, checked: 0, skipped: 0, errors: [], cost_usd: 0 };
  let stopped = false;
  onProgress?.(0, ids.length);
  for (let i = 0; i < ids.length; i += CHUNK) {
    if (shouldStop?.()) {
      stopped = true;
      break;
    }
    const r: AiTagResult = await post({ mode: "apply", rules, ids: ids.slice(i, i + CHUNK), replace, database });
    Object.assign(total.tags, r.tags);
    for (const [t, n] of Object.entries(r.counts)) total.counts[t] = (total.counts[t] ?? 0) + n;
    total.tagged += r.tagged;
    total.checked += r.checked;
    total.skipped += r.skipped;
    total.errors.push(...r.errors);
    total.cost_usd += r.cost_usd;
    onProgress?.(Math.min(i + CHUNK, ids.length), ids.length);
  }
  return { ...total, stopped };
}

/** "AI tagged 34 of 120: Priority 20, Gulf 14 · est. $0.04" */
export function summarize(r: AiTagResult & { stopped?: boolean }): string {
  const counts = Object.entries(r.counts)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t} ${n}`)
    .join(", ");
  return [
    `AI tagged ${r.tagged} of ${r.checked}${counts ? `: ${counts}` : ""}.`,
    r.skipped > 0 ? `${r.skipped} couldn't be checked.` : "",
    r.stopped ? "Stopped early." : "",
    `Est. cost $${r.cost_usd.toFixed(2)}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

// ---- auto-tag setting --------------------------------------------------------------

const AUTO_KEY = "caspian.aitag.auto";
const AUTO_EVENT = "caspian:autotag";

export interface AutoTag {
  enabled: boolean;
  criteria: string;
  /** Rules read from `rulesFor` (re-read when the criteria change). */
  rules: TagRule[];
  rulesFor: string;
}
const NO_AUTO: AutoTag = { enabled: false, criteria: "", rules: [], rulesFor: "" };

export function loadAutoTag(): AutoTag {
  try {
    const raw = localStorage.getItem(AUTO_KEY);
    return raw ? { ...NO_AUTO, ...JSON.parse(raw) } : NO_AUTO;
  } catch {
    return NO_AUTO;
  }
}

export function saveAutoTag(a: AutoTag) {
  try {
    localStorage.setItem(AUTO_KEY, JSON.stringify(a));
  } catch {
    /* storage unavailable — auto-tag just stays off */
  }
  window.dispatchEvent(new Event(AUTO_EVENT));
}

/** The saved rules if they were read from these criteria, else null. */
export function rulesFor(a: AutoTag): TagRule[] | null {
  return a.rules.length > 0 && a.rulesFor === a.criteria.trim() ? a.rules : null;
}

function useAutoTag(): [AutoTag, (patch: Partial<AutoTag>) => void] {
  const [auto, setAuto] = useState<AutoTag>(NO_AUTO);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore of a saved setting
    setAuto(loadAutoTag());
    const sync = () => setAuto(loadAutoTag());
    window.addEventListener(AUTO_EVENT, sync);
    return () => window.removeEventListener(AUTO_EVENT, sync);
  }, []);
  return [auto, (patch) => saveAutoTag({ ...loadAutoTag(), ...patch })];
}

// ---- pieces ------------------------------------------------------------------------

export function SparkIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z" />
    </svg>
  );
}

const EXAMPLE =
  "Tag “Priority” for training centres in the GCC that teach HSE or NEBOSH courses.\n" +
  "Tag “University” for universities and colleges.\n" +
  "Tag “Skip” for gyms, schools for children, and anything not about training or jobs.";

const textareaCls =
  "w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm shadow-xs focus:outline-none focus:ring-4 focus:ring-brand-500/15 focus:border-brand-500";
const primaryBtn =
  "inline-flex items-center justify-center gap-2 h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 dark:bg-brand-500 dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20";
const secondaryBtn =
  "inline-flex items-center justify-center h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-medium shadow-xs hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50";

function NoKeyHint({ error }: { error: string }) {
  if (!/Settings/.test(error)) return null;
  return (
    <Link href="/settings" className="ml-1 underline font-medium">
      Open Settings
    </Link>
  );
}

/** The rules the AI read, editable: rename a tag, sharpen a criterion, drop one. */
function RulesEditor({ rules, onChange, disabled }: { rules: TagRule[]; onChange: (r: TagRule[]) => void; disabled?: boolean }) {
  return (
    <ul className="space-y-2">
      {rules.map((r, i) => (
        <li key={i} className="flex items-start gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 p-2">
          <input
            value={r.tag}
            disabled={disabled}
            maxLength={40}
            onChange={(e) => onChange(rules.map((x, j) => (j === i ? { ...x, tag: e.target.value } : x)))}
            aria-label="Tag"
            className="w-36 shrink-0 h-8 px-2 rounded-md border border-brand-200 bg-brand-50 text-brand-800 text-xs font-medium dark:border-brand-400/30 dark:bg-brand-500/10 dark:text-brand-200"
          />
          <textarea
            value={r.criteria}
            disabled={disabled}
            maxLength={500}
            rows={3}
            onChange={(e) => onChange(rules.map((x, j) => (j === i ? { ...x, criteria: e.target.value } : x)))}
            aria-label={`When to tag ${r.tag}`}
            className="flex-1 min-w-0 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs resize-y"
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(rules.filter((_, j) => j !== i))}
            aria-label={`Remove ${r.tag}`}
            title="Remove this tag"
            className="h-8 w-8 shrink-0 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

const validRules = (rules: TagRule[]) =>
  rules.map((r) => ({ tag: r.tag.trim(), criteria: r.criteria.trim() })).filter((r) => r.tag && r.criteria);

// ---- before searching -----------------------------------------------------------

/**
 * "Tag results with AI" in the Find websites form: criteria saved in this
 * browser; every new search's results get tagged by them automatically.
 */
export function AutoTagSettings() {
  const [auto, setAuto] = useAutoTag();
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? auto.criteria;
  const planned = rulesFor(auto);
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 p-3 space-y-2">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={auto.enabled}
          onChange={(e) => setAuto({ enabled: e.target.checked, criteria: text })}
          className="w-4 h-4 mt-0.5"
        />
        <span>
          <span className="inline-flex items-center gap-1.5 font-medium">
            <SparkIcon className="w-3.5 h-3.5 text-brand-600 dark:text-brand-400" />
            Tag results with AI
          </span>
          <span className="block text-xs text-zinc-500">
            New results are tagged by your criteria after each search. Uses the AI key in Settings.
          </span>
        </span>
      </label>
      {auto.enabled && (
        <>
          <textarea
            value={text}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft !== null) setAuto({ criteria: draft });
              setDraft(null);
            }}
            rows={4}
            placeholder={EXAMPLE}
            aria-label="Tagging criteria"
            className={textareaCls + " text-xs"}
          />
          {planned ? (
            <p className="flex flex-wrap items-center gap-1 text-xs text-zinc-500">
              Tags:
              {planned.map((r) => (
                <span key={r.tag} title={r.criteria} className="px-1.5 py-0.5 rounded-full bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-600/20 dark:bg-brand-500/10 dark:text-brand-300">
                  {r.tag}
                </span>
              ))}
            </p>
          ) : (
            text.trim() && <p className="text-xs text-zinc-500">The AI reads these into tags on the next search.</p>
          )}
        </>
      )}
    </div>
  );
}

// ---- after the results are listed -------------------------------------------------

type Scope = "selected" | "shown" | "all";
type Stage = "write" | "planning" | "review" | "tagging" | "done";

/**
 * Tag findings with AI: criteria in plain words → the tags the AI reads from
 * them (editable) → tag the chosen companies, with progress → summary.
 */
export function AiTagDialog({
  database = "companies",
  noun = "companies",
  counts,
  idsFor,
  onTagged,
  onShowTags,
  onClose,
}: {
  /** The database the records are in. */
  database?: string;
  /** What the records are called, plural ("companies", "vacancies"). */
  noun?: string;
  /** How many records each scope covers (selected may be 0). */
  counts: Record<Scope, number>;
  /** The ids a scope covers (may ask the server). */
  idsFor: (scope: Scope) => string[] | Promise<string[]>;
  /** New tags per company, to update the list. */
  onTagged: (tags: Record<string, string[]>) => void;
  /** "Show tagged": filter the list by these tags. */
  onShowTags: (tags: string[]) => void;
  onClose: () => void;
}) {
  const saved = loadAutoTag();
  const [criteria, setCriteria] = useState(saved.criteria);
  const [rules, setRules] = useState<TagRule[]>([]);
  const [note, setNote] = useState("");
  const [scope, setScope] = useState<Scope>(counts.selected > 0 ? "selected" : "shown");
  const [replace, setReplace] = useState(false);
  const [useForSearches, setUseForSearches] = useState(saved.enabled && saved.criteria.trim() !== "");
  const [stage, setStage] = useState<Stage>("write");
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(AiTagResult & { stopped: boolean }) | null>(null);
  const [planCost, setPlanCost] = useState(0);
  const stop = useRef(false);
  const busy = stage === "planning" || stage === "tagging";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function readCriteria() {
    setStage("planning");
    setError(null);
    try {
      const p = await planTags(criteria.trim(), database);
      setRules(p.rules);
      setNote(p.note);
      setPlanCost(p.cost_usd);
      setStage("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("write");
    }
  }

  async function tag() {
    const use = validRules(rules);
    const ids = await idsFor(scope);
    if (use.length === 0 || ids.length === 0) return;
    if (useForSearches) saveAutoTag({ enabled: true, criteria: criteria.trim(), rules: use, rulesFor: criteria.trim() });
    else if (saved.enabled && saved.criteria.trim() === criteria.trim()) saveAutoTag({ ...saved, enabled: false });
    stop.current = false;
    setStage("tagging");
    setError(null);
    try {
      const r = await applyTags(use, ids, {
        database,
        replace,
        onProgress: (d, t) => setProgress([d, t]),
        shouldStop: () => stop.current,
      });
      r.cost_usd += planCost;
      onTagged(r.tags);
      setResult(r);
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("review");
    }
  }

  const scopeLabel: Record<Scope, string> = {
    selected: `The ${counts.selected} selected`,
    shown: `The ${counts.shown} shown (with your filters)`,
    all: `All ${counts.all} in this list`,
  };
  const pct = progress[1] ? Math.round((progress[0] / progress[1]) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 py-10" role="dialog" aria-modal="true" aria-label="Tag with AI">
      <button
        type="button"
        aria-label="Close"
        disabled={busy}
        onClick={onClose}
        className="fixed inset-0 bg-zinc-950/40 backdrop-blur-sm cursor-default"
      />
      <div className="relative w-full max-w-2xl rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-xl">
        <div className="flex items-center gap-3 px-6 h-14 border-b border-zinc-200 dark:border-zinc-800">
          <span className="w-8 h-8 rounded-lg bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-600/10 dark:bg-brand-500/10 dark:text-brand-300 flex items-center justify-center">
            <SparkIcon />
          </span>
          <h2 className="text-base font-semibold tracking-tight">Tag with AI</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="ml-auto h-8 w-8 rounded-lg flex items-center justify-center text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-40"
          >
            ×
          </button>
        </div>

        <div className="p-6 space-y-5">
          {(stage === "write" || stage === "planning") && (
            <>
              <label className="block text-sm">
                <span className="block font-medium mb-1">How should {noun} be tagged?</span>
                <span className="block text-xs text-zinc-500 mb-2">
                  In plain words. Name the tags you want and when each applies; the AI judges each one
                  by its own details (for a company: name, website, description, country, category).
                </span>
                <textarea
                  autoFocus
                  rows={6}
                  value={criteria}
                  disabled={busy}
                  onChange={(e) => setCriteria(e.target.value)}
                  placeholder={EXAMPLE}
                  className={textareaCls}
                />
              </label>
              <div className="flex items-center justify-end gap-2">
                <button type="button" className={secondaryBtn} onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className={primaryBtn} disabled={busy || !criteria.trim()} onClick={readCriteria}>
                  <SparkIcon />
                  {stage === "planning" ? "Reading…" : "Next: check the tags"}
                </button>
              </div>
            </>
          )}

          {(stage === "review" || stage === "tagging") && (
            <>
              <div className="space-y-2">
                <p className="text-sm font-medium">The AI will use these tags</p>
                <p className="text-xs text-zinc-500">
                  Edit a tag&apos;s name or rule, or remove it. Only these tags are given.
                </p>
                {note && (
                  <p className="text-xs rounded-lg bg-sky-50 text-sky-900 dark:bg-sky-950/30 dark:text-sky-200 px-3 py-2">{note}</p>
                )}
                <RulesEditor rules={rules} onChange={setRules} disabled={busy} />
              </div>

              <fieldset className="space-y-1.5 text-sm" disabled={busy}>
                <legend className="font-medium mb-1">Which {noun}?</legend>
                {(["selected", "shown", "all"] as Scope[])
                  .filter((s) => counts[s] > 0 && !(s === "all" && counts.all === counts.shown))
                  .map((s) => (
                    <label key={s} className="flex items-center gap-2">
                      <input type="radio" name="ai-scope" checked={scope === s} onChange={() => setScope(s)} />
                      {scopeLabel[s]}
                    </label>
                  ))}
              </fieldset>

              <fieldset className="space-y-1.5 text-sm" disabled={busy}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                  <span>
                    Also take these tags off {noun} that don&apos;t match
                    <span className="block text-xs text-zinc-500">Off: tags are only added. Other tags are never touched.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={useForSearches} onChange={(e) => setUseForSearches(e.target.checked)} />
                  <span>
                    Tag new search results this way too
                    <span className="block text-xs text-zinc-500">Find websites then tags what it finds automatically.</span>
                  </span>
                </label>
              </fieldset>

              {stage === "tagging" && (
                <div className="space-y-1.5" aria-live="polite">
                  <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                    <div className="h-full bg-brand-600 dark:bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-xs text-zinc-500">
                    Tagging… {progress[0]} of {progress[1]} checked. Tags are saved as each part finishes.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <button type="button" className={secondaryBtn} disabled={busy} onClick={() => setStage("write")}>
                  ← Criteria
                </button>
                {stage === "tagging" ? (
                  <button type="button" className={secondaryBtn} onClick={() => (stop.current = true)}>
                    Stop after this part
                  </button>
                ) : (
                  <button
                    type="button"
                    className={primaryBtn}
                    disabled={validRules(rules).length === 0 || counts[scope] === 0}
                    onClick={tag}
                  >
                    <SparkIcon />
                    Tag {counts[scope]} {noun}
                  </button>
                )}
              </div>
            </>
          )}

          {stage === "done" && result && (
            <>
              <div className="space-y-3">
                <p className="text-sm font-medium">
                  Tagged {result.tagged} of {result.checked} {noun}
                  {result.stopped && <span className="text-zinc-500 font-normal"> (stopped early)</span>}
                </p>
                <ul className="flex flex-wrap gap-2">
                  {Object.entries(result.counts).map(([t, n]) => (
                    <li key={t} className="inline-flex items-center gap-2 h-8 pl-2.5 pr-1.5 rounded-lg bg-brand-50 text-brand-800 ring-1 ring-inset ring-brand-600/15 dark:bg-brand-500/10 dark:text-brand-200 text-sm">
                      {t}
                      <span className="px-1.5 rounded-md bg-white/80 dark:bg-zinc-900 text-xs font-medium">{n}</span>
                    </li>
                  ))}
                </ul>
                {result.skipped > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {result.skipped} couldn&apos;t be checked{result.errors[0] ? `: ${result.errors[0]}` : ""}. Run again to retry them.
                  </p>
                )}
                <p className="text-xs text-zinc-500">
                  Saved to the findings database. Est. cost ${result.cost_usd.toFixed(2)}.
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button type="button" className={secondaryBtn} onClick={onClose}>
                  Close
                </button>
                <button
                  type="button"
                  className={primaryBtn}
                  disabled={Object.values(result.counts).every((n) => n === 0)}
                  onClick={() => {
                    onShowTags(Object.keys(result.counts).filter((t) => result.counts[t] > 0));
                    onClose();
                  }}
                >
                  Show tagged
                </button>
              </div>
            </>
          )}

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {error}
              <NoKeyHint error={error} />
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
