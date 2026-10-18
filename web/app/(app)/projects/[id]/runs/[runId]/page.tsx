import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import {
  runsCol,
  lessonsCol,
  projectDoc,
} from "@/lib/firestore/collections";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; runId: string }>;
}

function tsToIso(v: unknown): string {
  if (!v) return "";
  const t = v as { toDate?: () => Date };
  if (typeof t.toDate === "function") return t.toDate().toISOString();
  if (typeof v === "string") return v;
  return "";
}

function fmtAbsolute(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function fmtDuration(seconds: number): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function statusClasses(status: string): string {
  switch (status) {
    case "ok":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "partial":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "running":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
    case "auth_halt":
    case "error":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

function verdictClasses(v: string): string {
  switch (v) {
    case "ok":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "no_new":
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
    case "zero_found":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "errors":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

export default async function RunDetailPage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id, runId } = await params;

  // Ownership guard
  const projSnap = await projectDoc(id).get();
  if (
    !projSnap.exists ||
    projSnap.data()?.owner_uid !== session.uid
  ) {
    notFound();
  }

  const runSnap = await runsCol(id).doc(runId).get();
  if (!runSnap.exists) notFound();
  const run = runSnap.data() ?? {};

  // All lessons for this run. Subcollection equality query — single-field
  // index is automatic, no composite needed.
  const lessonsSnap = await lessonsCol(id)
    .where("run_id", "==", runId)
    .get();
  type LessonRow = { id: string } & Record<string, unknown>;
  const lessons: LessonRow[] = lessonsSnap.docs.map(
    (d) => ({ id: d.id, ...d.data() }) as LessonRow
  );
  lessons.sort((a, b) =>
    String(a.source_name ?? "").localeCompare(String(b.source_name ?? ""))
  );

  const status = String(run.status ?? "");
  const trigger = String(run.trigger ?? "");
  const dryRun = !!run.dry_run;
  const startedAt = tsToIso(run.started_at);
  const finishedAt = tsToIso(run.finished_at);
  const duration = Number(run.duration_seconds ?? 0);
  const totals = (run.totals ?? {}) as Record<string, number>;
  const errors: string[] = Array.isArray(run.errors)
    ? (run.errors as string[])
    : [];
  const publishedSample = Array.isArray(run.published_roles_sample)
    ? (run.published_roles_sample as Record<string, unknown>[])
    : [];

  return (
    <>
      <Link
        href={`/projects/${id}/runs`}
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Runs
      </Link>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2 flex-wrap">
            <span>Run</span>
            <code className="text-sm text-zinc-500 font-mono">{runId}</code>
            <span
              className={
                "text-xs px-2 py-0.5 rounded-full " + statusClasses(status)
              }
            >
              {status.replace("_", " ") || "unknown"}
            </span>
            {dryRun && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                dry run
              </span>
            )}
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Trigger: <code className="text-xs">{trigger || "—"}</code>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Started" value={fmtAbsolute(startedAt)} small />
        <Stat
          label="Finished"
          value={finishedAt ? fmtAbsolute(finishedAt) : "—"}
          small
        />
        <Stat label="Duration" value={fmtDuration(duration)} />
        <Stat label="Sources checked" value={String(totals.checked ?? 0)} />
        <Stat
          label="Errors"
          value={String(totals.errors_count ?? errors.length ?? 0)}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Found" value={String(totals.found ?? 0)} />
        <Stat label="Published" value={String(totals.published ?? 0)} />
        <Stat
          label="Duplicates"
          value={String(totals.skipped_duplicate ?? 0)}
        />
      </div>

      {errors.length > 0 && (
        <div className="rounded-2xl border border-red-200 dark:border-red-900/40 bg-red-50/50 dark:bg-red-950/20 p-5">
          <h3 className="font-medium text-red-900 dark:text-red-300 mb-2">
            Run-level errors ({errors.length})
          </h3>
          <ul className="space-y-1 text-xs font-mono text-red-800 dark:text-red-300 break-words whitespace-pre-wrap">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
        <div className="px-4 py-2 text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
          Per-source breakdown ({lessons.length})
        </div>
        {lessons.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            No source lessons recorded for this run. The run may have
            failed before reaching any source (e.g. config error,
            missing secret).
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Source</th>
                <th className="text-left px-4 py-2 font-medium">Verdict</th>
                <th className="text-right px-4 py-2 font-medium">Found</th>
                <th className="text-right px-4 py-2 font-medium">Published</th>
                <th className="text-right px-4 py-2 font-medium">Dup</th>
                <th className="text-left px-4 py-2 font-medium">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800 align-top">
              {lessons.map((l) => {
                const row = l as Record<string, unknown> & { id: string };
                const v = String(row.verdict ?? "");
                const errs = Array.isArray(row.errors)
                  ? (row.errors as string[])
                  : [];
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${id}/sources/${row.source_id}`}
                        className="font-medium hover:underline"
                      >
                        {String(row.source_name ?? row.source_id ?? "")}
                      </Link>
                      <div className="text-xs text-zinc-500">
                        {String(row.ats ?? "")}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          "text-xs px-2 py-0.5 rounded-full whitespace-nowrap " +
                          verdictClasses(v)
                        }
                      >
                        {v.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {Number(row.found ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {Number(row.published ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-zinc-500">
                      {Number(row.skipped_duplicate ?? 0)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {errs.length > 0 ? (
                        <ul className="space-y-1 text-red-700 dark:text-red-400 max-w-md">
                          {errs.map((e, i) => (
                            <li
                              key={i}
                              className="font-mono text-[11px] break-words whitespace-pre-wrap"
                            >
                              {e}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {publishedSample.length > 0 && (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
          <div className="px-4 py-2 text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
            Published in this run ({publishedSample.length})
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 text-sm">
            {publishedSample.map((p, i) => (
              <li key={i} className="px-4 py-3">
                <div className="font-medium">
                  {String(p.title ?? "(untitled)")}
                </div>
                <div className="text-xs text-zinc-500">
                  {String(p.employer ?? "")}
                  {p.location ? ` · ${p.location}` : ""}
                  {p.country ? ` · ${String(p.country).toUpperCase()}` : ""}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  small,
}: {
  label: string;
  value: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
        {label}
      </div>
      <div
        className={
          (small ? "text-xs " : "text-sm ") +
          "font-medium text-zinc-900 dark:text-zinc-100 truncate"
        }
        title={value}
      >
        {value}
      </div>
    </div>
  );
}
