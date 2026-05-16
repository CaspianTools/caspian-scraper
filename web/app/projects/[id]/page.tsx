import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { projectDoc, sourcesCol } from "@/lib/firestore/collections";
import { humanizeCron } from "@/lib/cron/humanize";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectOverviewPage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id } = await params;

  const snap = await projectDoc(id).get();
  if (!snap.exists) notFound();
  const data = snap.data();
  if (!data || data.owner_uid !== session.uid) notFound();

  const sourcesCount = (await sourcesCol(id).count().get()).data().count;

  const lastRunIso = data.last_run_at?.toDate?.()
    ? data.last_run_at.toDate().toISOString()
    : typeof data.last_run_at === "string"
    ? data.last_run_at
    : null;

  return (
    <>
      {data.description && (
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          {data.description}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <StatCard
          label="Schedule"
          value={humanizeCron(data.schedule_cron)}
          hint={data.schedule_cron}
        />
        <StatCard
          label="Sources"
          value={String(sourcesCount)}
          link={`/projects/${id}/sources`}
        />
        <StatCard
          label="Last run"
          value={
            lastRunIso
              ? new Date(lastRunIso).toISOString().slice(0, 16) + " UTC"
              : "never"
          }
        />
        <StatCard
          label="Status"
          value={data.enabled !== false ? "enabled" : "disabled"}
        />
      </div>

      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6">
        <h2 className="text-lg font-medium mb-2">Next steps</h2>
        <ol className="text-sm text-zinc-600 dark:text-zinc-400 space-y-2 list-decimal list-inside">
          <li>
            Add{" "}
            <Link
              href={`/projects/${id}/sources`}
              className="underline"
            >
              sources
            </Link>{" "}
            — the URLs to scrape (each tagged with an ATS type).
          </li>
          <li>
            Configure a{" "}
            <Link
              href={`/projects/${id}/destinations`}
              className="underline"
            >
              destination
            </Link>{" "}
            — the API to POST findings to.
          </li>
          <li>
            Store the API key for that destination as a{" "}
            <Link
              href={`/projects/${id}/secrets`}
              className="underline"
            >
              secret
            </Link>
            .
          </li>
          <li>
            Wait for the schedule, or trigger an ad-hoc run from{" "}
            <Link href={`/projects/${id}/runs`} className="underline">
              Runs
            </Link>
            .
          </li>
        </ol>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  link,
  hint,
}: {
  label: string;
  value: string;
  link?: string;
  hint?: string;
}) {
  const body = (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
        {label}
      </div>
      <div
        className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate"
        title={hint || value}
      >
        {value}
      </div>
    </div>
  );
  return link ? <Link href={link}>{body}</Link> : body;
}
