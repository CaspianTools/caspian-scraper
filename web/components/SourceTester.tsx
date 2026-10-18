"use client";

import { useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";

interface Props {
  extractionJson: string;
  sampleUrl: string;
}

interface TestResult {
  ok: boolean;
  http_status?: number;
  error?: string;
  note?: string;
  tried?: string[];
  extractor?: string;
  listing?: {
    name: string;
    brand?: string;
    gtin?: string | null;
    price_value: number;
    price_currency: string;
    size_value?: number | null;
    size_unit?: string;
    image_url?: string;
    product_url: string;
  };
}

/**
 * Test button + inline result panel for the source-create form. Calls
 * /api/comparison/sources/test which runs a lightweight, no-persist
 * extraction against the sample URL. Plan v2 §5 — turns "zero found,
 * 15 minutes later" into "wrong selector, 4 seconds later".
 */
export function SourceTester({ extractionJson, sampleUrl }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [parseError, setParseError] = useState<string>("");
  const [urlOverride, setUrlOverride] = useState<string>("");

  async function runTest() {
    setBusy(true);
    setResult(null);
    setParseError("");
    let extraction: unknown;
    try {
      extraction = JSON.parse(extractionJson);
    } catch (e) {
      setParseError(
        `Extraction config is not valid JSON: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      setBusy(false);
      return;
    }
    const sample = (urlOverride.trim() || sampleUrl).trim();
    if (!sample) {
      setParseError("Provide a sample URL above (in Start URLs) or in the field below.");
      setBusy(false);
      return;
    }
    try {
      const res = await authedFetch("/api/comparison/sources/test", {
        method: "POST",
        body: JSON.stringify({ extraction, sample_url: sample }),
      });
      const body = await res.json().catch(() => ({}));
      setResult(body as TestResult);
    } catch (e) {
      setResult({
        ok: false,
        error: `request failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Test extraction
        </div>
        <button
          type="button"
          onClick={runTest}
          disabled={busy}
          className="text-xs px-3 h-8 rounded-lg bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 disabled:opacity-50"
        >
          {busy ? "Testing…" : "Test"}
        </button>
      </div>
      <input
        type="text"
        value={urlOverride}
        onChange={(e) => setUrlOverride(e.target.value)}
        placeholder={
          sampleUrl
            ? `Sample URL (default: ${sampleUrl})`
            : "Sample URL — must be a product detail page"
        }
        className="w-full h-8 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-mono"
      />
      <p className="text-xs text-zinc-500">
        Runs JSON-LD and OG-meta extractors against the live page (no
        persistence). CSS selectors are validated only during the scheduled
        scrape.
      </p>

      {parseError && (
        <div className="text-xs text-red-600 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20">
          {parseError}
        </div>
      )}

      {result && <ResultPanel result={result} />}
    </div>
  );
}

function ResultPanel({ result }: { result: TestResult }) {
  const cls = result.ok
    ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20"
    : "border-red-300 dark:border-red-800 bg-red-50/60 dark:bg-red-900/20";
  return (
    <div className={"rounded-lg border p-3 text-xs " + cls}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">
          {result.ok ? "Extracted" : "Failed"}
        </span>
        {result.http_status !== undefined && result.http_status > 0 && (
          <span className="text-zinc-500">HTTP {result.http_status}</span>
        )}
        {result.extractor && (
          <span className="text-zinc-500">via {result.extractor}</span>
        )}
      </div>
      {result.error && (
        <div className="mt-2 text-red-700 dark:text-red-300 break-words whitespace-pre-wrap">
          {result.error}
        </div>
      )}
      {result.note && (
        <div className="mt-2 text-zinc-600 dark:text-zinc-400">
          {result.note}
        </div>
      )}
      {result.tried && result.tried.length > 0 && (
        <div className="mt-2 text-zinc-500">
          Tried extractors: {result.tried.join(", ")}
        </div>
      )}
      {result.listing && (
        <div className="mt-3 flex items-start gap-3 flex-wrap">
          {result.listing.image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={result.listing.image_url}
              alt=""
              className="w-12 h-12 rounded-lg object-cover bg-white dark:bg-zinc-800"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-medium break-words">{result.listing.name}</div>
            <div className="text-zinc-500 mt-0.5 space-x-2">
              {result.listing.brand && <span>{result.listing.brand}</span>}
              {result.listing.size_value != null &&
                result.listing.size_unit && (
                  <span>
                    · {result.listing.size_value} {result.listing.size_unit}
                  </span>
                )}
              {result.listing.gtin && <span>· GTIN {result.listing.gtin}</span>}
            </div>
          </div>
          <div className="font-medium tabular-nums shrink-0">
            {result.listing.price_value.toFixed(2)}{" "}
            {result.listing.price_currency}
          </div>
        </div>
      )}
    </div>
  );
}
