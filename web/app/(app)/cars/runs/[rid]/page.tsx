import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { carRunsCol } from "@/lib/firestore/collections";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ rid: string }>;
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
    case "error":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

export default async function CarRunDetailPage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { rid } = await params;

  const runSnap = await carRunsCol().doc(rid).get();
  if (!runSnap.exists) notFound();
  const run = runSnap.data();
  if (!run || run.owner_uid !== session.uid) notFound();

  const totals = (run.totals ?? {}) as Record<string, number>;
  const errors: string[] = Array.isArray(run.errors)
    ? (run.errors as string[])
    : [];

  return (
    <>
      <Link
        href="/cars/runs"
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Runs
      </Link>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2 flex-wrap">
            <span>{String(run.source_name ?? "Run")}</span>
            <code className="text-xs text-zinc-500 font-mono">{rid}</code>
            <span
              className={
                "text-xs px-2 py-0.5 rounded-full " +
                statusClasses(String(run.status ?? ""))
              }
            >
              {String(run.status ?? "").replace("_", " ") || "unknown"}
            </span>
            {run.dry_run && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                dry run
              </span>
            )}
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Site: <code className="text-xs">{String(run.site ?? "—")}</code>{" "}
            · Trigger:{" "}
            <code className="text-xs">{String(run.trigger ?? "—")}</code>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Stat label="Started" value={fmtAbsolute(tsToIso(run.started_at))} small />
        <Stat
          label="Finished"
          value={run.finished_at ? fmtAbsolute(tsToIso(run.finished_at)) : "—"}
          small
        />
        <Stat
          label="Duration"
          value={fmtDuration(Number(run.duration_seconds ?? 0))}
        />
        <Stat label="Found" value={String(totals.found ?? 0)} />
        <Stat label="New" value={String(totals.new ?? 0)} />
        <Stat label="Updated" value={String(totals.updated ?? 0)} />
      </div>

      {errors.length > 0 && (
        <div className="rounded-2xl border border-red-200 dark:border-red-900/40 bg-red-50/50 dark:bg-red-950/20 p-5">
          <h3 className="font-medium text-red-900 dark:text-red-300 mb-2">
            Errors ({errors.length})
          </h3>
          <ul className="space-y-1 text-xs font-mono text-red-800 dark:text-red-300 break-words whitespace-pre-wrap">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
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
          "font-medium text-zinc-900 dark:text-zinc-100 break-words"
        }
        title={value}
      >
        {value}
      </div>
    </div>
  );
}
