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
      // Runs start on this computer (lib/localRunner.ts).
      if (body.dispatched) {
        setMsg(body.reused ? "Already running — started it again on this computer." : "Started on this computer. Results appear as it finishes.");
      } else {
        setMsg(`Queued, but it couldn't start here${body.dispatch_error ? `: ${body.dispatch_error}` : ""}. Try Start.bat.`);
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
        className="inline-flex items-center h-10 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 disabled:opacity-50 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
      >
        {busy ? "Starting…" : "Run now"}
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
