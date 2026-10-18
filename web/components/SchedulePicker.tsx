"use client";

import { useEffect, useMemo, useState } from "react";
import { humanizeCron } from "@/lib/cron/humanize";

type Unit = "hours" | "days" | "weeks" | "months";

interface Props {
  value: string;
  onChange: (cron: string) => void;
  errorMessage?: string;
}

interface ParsedSimple {
  n: number;
  unit: Unit;
}

/**
 * Build a cron expression for "every N units". Patterns:
 *   hours   →  0 *\/N * * *
 *   days    →  0 4 *\/N * *      (defaults to 04:00 UTC)
 *   weeks   →  0 4 * * 1         (every Monday; N>1 not natively supported)
 *   months  →  0 4 1 *\/N *      (1st of every N months)
 */
function buildCron(n: number, unit: Unit): string {
  const safeN = Math.max(1, Math.floor(n));
  switch (unit) {
    case "hours":
      if (safeN === 1) return "0 * * * *";
      return `0 */${safeN} * * *`;
    case "days":
      if (safeN === 1) return "0 4 * * *";
      return `0 4 */${safeN} * *`;
    case "weeks":
      // Cron has no native "every N weeks" — collapse to weekly Monday.
      return "0 4 * * 1";
    case "months":
      if (safeN === 1) return "0 4 1 * *";
      return `0 4 1 */${safeN} *`;
  }
}

/**
 * Best-effort reverse: given a cron string, see if it matches one of
 * the patterns this picker generates. Returns null on no match (the
 * picker then falls back to "advanced" mode with the raw cron).
 */
function parseSimple(cron: string): ParsedSimple | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mo, dow] = parts;
  if (!/^\d{1,2}$/.test(m)) return null;

  // Every N hours: M */N * * *  OR  M * * * *  (the every-1-hour case)
  if (dom === "*" && mo === "*" && dow === "*") {
    if (h === "*") return { n: 1, unit: "hours" };
    const step = h.match(/^\*\/(\d+)$/);
    if (step) return { n: parseInt(step[1], 10), unit: "hours" };
    // Every day at HH:MM matches "every 1 days"
    if (/^\d{1,2}$/.test(h)) return { n: 1, unit: "days" };
  }

  // Every N days: M H */N * *  (or M H * * *)
  if (mo === "*" && dow === "*" && /^\d{1,2}$/.test(h)) {
    if (dom === "*") return { n: 1, unit: "days" };
    const step = dom.match(/^\*\/(\d+)$/);
    if (step) return { n: parseInt(step[1], 10), unit: "days" };
  }

  // Every Monday at HH:MM: M H * * 1  →  treat as "every 1 weeks"
  if (mo === "*" && dom === "*" && dow === "1" && /^\d{1,2}$/.test(h)) {
    return { n: 1, unit: "weeks" };
  }

  // Every N months: M H 1 */N *
  if (dow === "*" && dom === "1" && /^\d{1,2}$/.test(h)) {
    if (mo === "*") return { n: 1, unit: "months" };
    const step = mo.match(/^\*\/(\d+)$/);
    if (step) return { n: parseInt(step[1], 10), unit: "months" };
  }

  return null;
}

function digitsOnly(s: string): string {
  return s.replace(/\D+/g, "");
}

export function SchedulePicker({ value, onChange, errorMessage }: Props) {
  // Initialise from incoming value. If it matches a simple pattern, use
  // the simple picker; otherwise drop into advanced mode.
  const initialParsed = useMemo(() => parseSimple(value), [value]);
  const [advanced, setAdvanced] = useState(initialParsed === null);
  const [n, setN] = useState<string>(
    initialParsed ? String(initialParsed.n) : "6"
  );
  const [unit, setUnit] = useState<Unit>(initialParsed?.unit ?? "hours");

  // When the user switches modes or edits N/unit, propagate the new
  // cron string to the parent.
  useEffect(() => {
    if (advanced) return; // advanced mode emits via the text input
    const parsedN = parseInt(n || "0", 10);
    if (parsedN >= 1) {
      const cron = buildCron(parsedN, unit);
      if (cron !== value) onChange(cron);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, unit, advanced]);

  const humanized = humanizeCron(value);

  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        When should it run?
      </label>
      <p className="text-xs text-zinc-500 mb-3">
        Pick a frequency. All times in UTC. Minimum granularity: 1 hour.
      </p>

      {!advanced && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              Run every
            </span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={unit === "weeks" ? "1" : n}
              disabled={unit === "weeks"}
              onChange={(e) => setN(digitsOnly(e.target.value).slice(0, 3))}
              onBlur={() => {
                // Clamp empty / zero to 1 on blur.
                if (!n || parseInt(n, 10) < 1) setN("1");
              }}
              className="w-20 h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-center focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as Unit)}
              className="h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
            >
              <option value="hours">hour(s)</option>
              <option value="days">day(s)</option>
              <option value="weeks">week (Monday)</option>
              <option value="months">month(s)</option>
            </select>
          </div>

          {unit === "weeks" && (
            <p className="mt-2 text-xs text-zinc-500">
              Weeks default to every Monday at 04:00 UTC. For other days
              of the week, use the custom expression below.
            </p>
          )}
          {unit === "days" && parseInt(n || "0", 10) > 1 && (
            <p className="mt-2 text-xs text-zinc-500">
              Every-N-days resets on the 1st of each month — the gap
              between the last run of one month and the first of the
              next may be shorter than {n} days.
            </p>
          )}
        </>
      )}

      <details
        className="group mt-3"
        open={advanced}
        onToggle={(e) =>
          setAdvanced((e.target as HTMLDetailsElement).open)
        }
      >
        <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300 select-none list-none flex items-center gap-1">
          <span className="group-open:rotate-90 transition-transform inline-block">
            ▸
          </span>
          Custom schedule (cron expression)
        </summary>
        <div className="mt-2 space-y-2">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="30 4 * * *"
            className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
          <p className="text-xs text-zinc-500">
            Format: <code>minute hour day-of-month month day-of-week</code>.
            Use <code>*</code> for &ldquo;any&rdquo;.{" "}
            <a
              href="https://crontab.guru"
              target="_blank"
              rel="noopener"
              className="underline"
            >
              crontab.guru
            </a>{" "}
            helps you build one.
          </p>
        </div>
      </details>

      <div className="mt-3 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-3 py-2 text-sm">
        <span className="text-xs uppercase tracking-wide text-zinc-500 mr-2">
          Runs:
        </span>
        <span className="text-zinc-900 dark:text-zinc-100">{humanized}</span>
      </div>

      {errorMessage && (
        <p className="mt-2 text-xs text-red-600">{errorMessage}</p>
      )}
    </div>
  );
}
