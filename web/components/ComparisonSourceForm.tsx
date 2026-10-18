"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/firebase/clientFetch";
import { SourceTester } from "./SourceTester";
import type {
  ComparisonSourceFormInitial,
  ExtractionConfigInput,
} from "./comparisonSourceFormDefaults";

// Type-only re-exports — fine to surface across the client/server boundary
// because they're erased at compile time. The factory function lives in
// comparisonSourceFormDefaults (non-client) so server components can call it.
export type {
  ComparisonSourceFormInitial,
  ExtractionConfigInput,
} from "./comparisonSourceFormDefaults";

interface Props {
  initial: ComparisonSourceFormInitial;
  sourceId?: string;
}

interface FieldErr {
  field?: string;
  message: string;
}

export function ComparisonSourceForm({ initial, sourceId }: Props) {
  const router = useRouter();
  const isEdit = !!sourceId;
  const [form, setForm] = useState<ComparisonSourceFormInitial>(initial);
  const [extractionJson, setExtractionJson] = useState<string>(
    JSON.stringify(initial.extraction, null, 2)
  );
  const [extractionParseError, setExtractionParseError] = useState<string>("");
  const [startUrlsText, setStartUrlsText] = useState<string>(
    initial.start_urls.join("\n")
  );
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errors, setErrors] = useState<FieldErr[]>([]);

  function set<K extends keyof ComparisonSourceFormInitial>(
    key: K,
    value: ComparisonSourceFormInitial[K]
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function parsedExtraction(): ExtractionConfigInput | null {
    try {
      const parsed = JSON.parse(extractionJson);
      setExtractionParseError("");
      return parsed;
    } catch (e) {
      setExtractionParseError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    const extraction = parsedExtraction();
    if (!extraction) {
      setErrors([
        {
          field: "extraction",
          message: `Extraction config is not valid JSON: ${extractionParseError}`,
        },
      ]);
      return;
    }
    const start_urls = startUrlsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (start_urls.length === 0) {
      setErrors([{ field: "start_urls", message: "at least one start URL" }]);
      return;
    }

    setBusy(true);
    try {
      const body = JSON.stringify({
        ...form,
        start_urls,
        extraction,
      });

      const url = isEdit
        ? `/api/comparison/sources/${sourceId}`
        : "/api/comparison/sources";
      const res = await authedFetch(url, {
        method: isEdit ? "PATCH" : "POST",
        body,
      });
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
      router.push("/comparison/sources");
      router.refresh();
    } catch (e) {
      setErrors([{ message: e instanceof Error ? e.message : String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  async function handleRunNow() {
    if (!sourceId) return;
    setBusy(true);
    try {
      const res = await authedFetch(
        `/api/comparison/sources/${sourceId}/run-now`,
        { method: "POST" }
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErrors([{ message: b.error || `Run-now failed (${res.status})` }]);
        return;
      }
      router.push("/comparison/runs");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!sourceId) return;
    if (!confirm(`Delete "${form.name}"? Existing listings are kept; only future scrapes stop.`))
      return;
    setDeleting(true);
    try {
      const res = await authedFetch(`/api/comparison/sources/${sourceId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErrors([{ message: b.error || `Delete failed (${res.status})` }]);
        return;
      }
      router.push("/comparison/sources");
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  function loadPreset(preset: "jsonld" | "bim" | "carrefour") {
    if (preset === "jsonld") {
      setExtractionJson(
        JSON.stringify(
          {
            link_discovery: {
              mode: "css",
              link_selector: "a[href*='/p/']",
              next_page_selector: "a[rel='next']",
              max_pages: 5,
            },
            extractors: [{ type: "jsonld_product" }, { type: "og_meta" }],
            request_delay_ms: 1500,
            respect_robots: true,
          },
          null,
          2
        )
      );
    } else if (preset === "bim") {
      setExtractionJson(
        JSON.stringify(
          {
            link_discovery: {
              mode: "css",
              link_selector:
                "a[href*='/aktuel-urunler/'][href$='/aktuel.aspx']",
              next_page_selector: "a[aria-label='Next'], a.next",
              max_pages: 5,
            },
            extractors: [
              { type: "og_meta" },
              {
                type: "css",
                name_selector: "h1, .product-title",
                price_selector: ".product-price, .price",
                currency: "TRY",
                image_selector: "img.product-image, .product-photo img",
              },
            ],
            request_delay_ms: 2000,
            respect_robots: true,
          },
          null,
          2
        )
      );
    } else if (preset === "carrefour") {
      setExtractionJson(
        JSON.stringify(
          {
            link_discovery: {
              mode: "css",
              link_selector: "a[href*='/mafuae/en/p/']",
              next_page_selector: "button[aria-label='Next page']",
              max_pages: 5,
            },
            extractors: [{ type: "jsonld_product" }],
            request_delay_ms: 1500,
            respect_robots: true,
          },
          null,
          2
        )
      );
    }
  }

  const errFor = (field: string) =>
    errors.find((e) => e.field === field)?.message;

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-5"
    >
      <Row label="Name" error={errFor("name")} required>
        <input
          type="text"
          required
          maxLength={120}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Carrefour UAE"
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
        />
      </Row>

      <Row
        label="Retailer ID"
        error={errFor("retailer_id")}
        required
        hint="Stable slug used as the column key in the side-by-side compare table. Lowercase letters, digits, dash, underscore only."
      >
        <input
          type="text"
          required
          maxLength={80}
          value={form.retailer_id}
          onChange={(e) =>
            set("retailer_id", e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))
          }
          placeholder="carrefour-uae"
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
          disabled={isEdit}
        />
      </Row>

      <Row label="Home URL" error={errFor("home_url")} required>
        <input
          type="url"
          required
          value={form.home_url}
          onChange={(e) => set("home_url", e.target.value)}
          placeholder="https://www.carrefouruae.com"
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
        />
      </Row>

      <Row
        label="Start URLs"
        error={errFor("start_urls")}
        required
        hint="One per line. Category or listing pages — NOT the homepage. Each one is processed independently per scrape."
      >
        <textarea
          rows={3}
          required
          value={startUrlsText}
          onChange={(e) => setStartUrlsText(e.target.value)}
          placeholder="https://www.carrefouruae.com/mafuae/en/c/dairy"
          className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
        />
      </Row>

      <Row
        label="Extraction config"
        error={errFor("extraction") || extractionParseError}
        required
        hint="JSON. See plan v2 §3 for the schema. Quick-start presets below."
      >
        <div className="flex gap-2 mb-2 flex-wrap">
          <button
            type="button"
            onClick={() => loadPreset("jsonld")}
            className="text-xs px-2 h-7 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            JSON-LD only
          </button>
          <button
            type="button"
            onClick={() => loadPreset("carrefour")}
            className="text-xs px-2 h-7 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            Carrefour UAE preset
          </button>
          <button
            type="button"
            onClick={() => loadPreset("bim")}
            className="text-xs px-2 h-7 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            BIM preset
          </button>
        </div>
        <textarea
          rows={14}
          value={extractionJson}
          onChange={(e) => {
            setExtractionJson(e.target.value);
            setExtractionParseError("");
          }}
          spellCheck={false}
          className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-mono"
        />
      </Row>

      <SourceTester
        extractionJson={extractionJson}
        sampleUrl={
          startUrlsText.split("\n").map((s) => s.trim()).filter(Boolean)[0] ||
          ""
        }
      />

      <Row
        label="Schedule (cron)"
        error={errFor("schedule_cron")}
        required
        hint="≥1hr granularity. Minute must be a fixed number (e.g. '30 4 * * *' for daily 04:30 UTC)."
      >
        <input
          type="text"
          required
          value={form.schedule_cron}
          onChange={(e) => set("schedule_cron", e.target.value)}
          placeholder="30 4 * * *"
          className="w-full h-10 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-mono"
        />
      </Row>

      <Row label="Notes">
        <textarea
          rows={2}
          maxLength={2000}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Optional context."
          className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
        />
      </Row>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="active"
          checked={form.active}
          onChange={(e) => set("active", e.target.checked)}
          className="w-4 h-4"
        />
        <label htmlFor="active" className="text-sm">
          Active{" "}
          <span className="text-zinc-500">
            — uncheck to keep configured but skip during scheduled scrapes
          </span>
        </label>
      </div>

      {errors
        .filter((e) => !e.field)
        .map((e, i) => (
          <p key={i} className="text-sm text-red-600">
            {e.message}
          </p>
        ))}

      <div className="flex items-center justify-between pt-2 border-t border-zinc-100 dark:border-zinc-800">
        {isEdit ? (
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || busy}
            className="text-sm px-3 h-9 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete source"}
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          {isEdit && (
            <button
              type="button"
              onClick={handleRunNow}
              disabled={busy || deleting}
              className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50"
            >
              Run now
            </button>
          )}
          <Link
            href="/comparison/sources"
            className="inline-flex items-center h-10 px-4 rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={busy || deleting}
            className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {busy ? "Saving…" : isEdit ? "Save changes" : "Add source"}
          </button>
        </div>
      </div>
    </form>
  );
}

function Row({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        {label}
        {!required && (
          <span className="text-zinc-500 font-normal"> (optional)</span>
        )}
      </label>
      {hint && <p className="text-xs text-zinc-500 mb-2">{hint}</p>}
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
