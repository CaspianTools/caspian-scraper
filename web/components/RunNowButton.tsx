"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authedFetch } from "@/lib/firebase/clientFetch";

export function RunNowButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await authedFetch(
        `/api/projects/${projectId}/run-requests`,
        { method: "POST" }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(body.error || `Request failed (${res.status})`);
        return;
      }
      if (body.reused) {
        setMsg("A run request is already pending for this project.");
      } else if (body.dispatched) {
        setMsg("Dispatched. Workflow fires within ~1 minute.");
      } else if (body.dispatch_error) {
        setMsg(
          `Queued (cron ≤15 min). Instant dispatch failed: ${body.dispatch_error}`
        );
      } else {
        setMsg(
          "Queued. The next cron tick (≤15 min) will pick it up. " +
            "Set GH_DISPATCH_TOKEN for instant dispatch."
        );
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      >
        {busy ? "Queueing…" : "Run scrape now"}
      </button>
      {msg && (
        <span className="text-xs text-emerald-700 dark:text-emerald-400">
          {msg}
        </span>
      )}
      {err && (
        <span className="text-xs text-red-700 dark:text-red-300">{err}</span>
      )}
    </div>
  );
}
