"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";

export function SeedLegacyDestinationButton({
  projectId,
}: {
  projectId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleSeed() {
    if (
      !confirm(
        "Add the legacy entirelysafe.com API destination (referencing secret ENTIRELYSAFE_API_KEY)?"
      )
    )
      return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await authedFetch(
        `/api/projects/${projectId}/seed-legacy-destination`,
        { method: "POST" }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error || `Request failed (${res.status})`);
        return;
      }
      if (body.created) {
        setMsg(
          "Added entirelysafe.com destination. Now add a secret named ENTIRELYSAFE_API_KEY on the Secrets tab."
        );
      } else {
        setMsg(body.message || "Already exists.");
      }
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
        <strong>Legacy import (temporary).</strong> Add the entirelysafe.com API as a destination — the one the old <code>scrape.py</code> used to POST to. Skipped if it already exists. References secret <code>ENTIRELYSAFE_API_KEY</code>.
      </div>
      <div className="flex items-center gap-3">
        {msg && (
          <span className="text-xs text-amber-900 dark:text-amber-200 max-w-md">
            {msg}
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
          {busy ? "Adding…" : "Add entirelysafe destination"}
        </button>
      </div>
    </div>
  );
}
