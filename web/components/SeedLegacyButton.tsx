"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";

interface SeedResult {
  total: number;
  added: number;
  skipped_duplicate: number;
  skipped_invalid: number;
}

export function SeedLegacyButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SeedResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleSeed() {
    if (
      !confirm(
        "Import the legacy employers.json (191 entries) into this project? Existing duplicates will be skipped."
      )
    )
      return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await authedFetch(
        `/api/projects/${projectId}/seed-legacy`,
        { method: "POST" }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error || `Request failed (${res.status})`);
        return;
      }
      setResult({
        total: body.total ?? 0,
        added: body.added ?? 0,
        skipped_duplicate: body.skipped_duplicate ?? 0,
        skipped_invalid: body.skipped_invalid ?? 0,
      });
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-300 dark:border-amber-700/50 bg-amber-50/70 dark:bg-amber-950/20 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div className="text-xs text-amber-900 dark:text-amber-200">
        <strong>Legacy import (temporary).</strong> Bulk-load all 191
        employers from <code>employers.json</code> into this project as
        sources. Duplicates by careers URL are skipped. Remove this
        button once HSE is fully migrated.
      </div>
      <div className="flex items-center gap-3">
        {result && (
          <span className="text-xs text-amber-900 dark:text-amber-200">
            Added {result.added}, skipped {result.skipped_duplicate} dup
            {result.skipped_invalid > 0
              ? `, ${result.skipped_invalid} invalid`
              : ""}
            .
          </span>
        )}
        {err && (
          <span className="text-xs text-red-700 dark:text-red-300">
            {err}
          </span>
        )}
        <button
          type="button"
          onClick={handleSeed}
          disabled={busy}
          className="text-xs h-8 px-3 rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 font-medium whitespace-nowrap"
        >
          {busy ? "Importing…" : "Seed from employers.json"}
        </button>
      </div>
    </div>
  );
}
