"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";

export function DeleteDatabaseButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!confirm(`Delete the database “${name}” and all its records? Jobs that save into it stop doing so.`)) return;
        setBusy(true);
        const res = await apiFetch(`/api/databases/${id}`, { method: "DELETE" });
        if (res.ok) {
          router.push("/databases");
          router.refresh();
        } else {
          const b = await res.json().catch(() => ({}));
          alert(b.error || `Couldn't delete (${res.status})`);
          setBusy(false);
        }
      }}
      className="h-9 px-3 rounded-lg border border-red-200 dark:border-red-900/50 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
    >
      {busy ? "Deleting…" : "Delete database"}
    </button>
  );
}
