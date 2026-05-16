import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { projectDoc, sourcesCol } from "@/lib/firestore/collections";

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

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-black">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline"
            >
              ← Projects
            </Link>
            <span className="text-zinc-400">/</span>
            <h1 className="text-lg font-semibold tracking-tight">
              {data.name}
            </h1>
            <span
              className={
                "text-xs px-2 py-0.5 rounded-full " +
                (data.enabled !== false
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400")
              }
            >
              {data.enabled !== false ? "enabled" : "disabled"}
            </span>
          </div>
          <span className="text-xs text-zinc-500">{session.email}</span>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {data.description && (
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            {data.description}
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <StatCard label="Schedule" value={data.schedule_cron} mono />
          <StatCard
            label="Sources"
            value={String(sourcesCount)}
            link={`/projects/${id}/sources`}
          />
          <StatCard
            label="Last run"
            value={
              data.last_run_at
                ? new Date(data.last_run_at.toDate?.() ?? data.last_run_at)
                    .toISOString()
                    .slice(0, 16) + " UTC"
                : "never"
            }
          />
          <StatCard
            label="Status"
            value={data.enabled !== false ? "enabled" : "disabled"}
          />
        </div>

        <nav className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-2 flex flex-wrap gap-1">
          <NavLink href={`/projects/${id}`} active>
            Overview
          </NavLink>
          <NavLink href={`/projects/${id}/sources`}>Sources</NavLink>
          <NavLink href={`/projects/${id}/destinations`}>Destinations</NavLink>
          <NavLink href={`/projects/${id}/secrets`}>Secrets</NavLink>
          <NavLink href={`/projects/${id}/runs`}>Runs</NavLink>
          <NavLink href={`/projects/${id}/lessons`}>Lessons</NavLink>
          <NavLink href={`/projects/${id}/settings`}>Settings</NavLink>
        </nav>

        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6">
          <h2 className="text-lg font-medium mb-2">Next steps</h2>
          <ol className="text-sm text-zinc-600 dark:text-zinc-400 space-y-2 list-decimal list-inside">
            <li>
              Add <Link href={`/projects/${id}/sources`} className="underline">sources</Link> —
              the URLs to scrape (each tagged with an ATS type).
            </li>
            <li>
              Configure a <Link href={`/projects/${id}/destinations`} className="underline">destination</Link> —
              the API to POST findings to.
            </li>
            <li>
              Store the API key for that destination as a{" "}
              <Link href={`/projects/${id}/secrets`} className="underline">secret</Link>.
            </li>
            <li>
              Wait for the schedule, or trigger an ad-hoc run from{" "}
              <Link href={`/projects/${id}/runs`} className="underline">Runs</Link>.
            </li>
          </ol>
          <p className="text-xs text-zinc-500 mt-4">
            Sources, destinations, secrets, runs, and lessons UIs land in
            Phase 2.
          </p>
        </div>
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  link,
  mono,
}: {
  label: string;
  value: string;
  link?: string;
  mono?: boolean;
}) {
  const body = (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
        {label}
      </div>
      <div
        className={
          "text-sm " +
          (mono ? "font-mono" : "font-medium") +
          " text-zinc-900 dark:text-zinc-100 truncate"
        }
        title={value}
      >
        {value}
      </div>
    </div>
  );
  return link ? <Link href={link}>{body}</Link> : body;
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={
        "text-sm px-3 py-1.5 rounded-lg transition-colors " +
        (active
          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
          : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900")
      }
    >
      {children}
    </Link>
  );
}
