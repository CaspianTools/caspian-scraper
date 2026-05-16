import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { projectsCol } from "@/lib/firestore/collections";
import { SignOutButton } from "@/components/SignOutButton";

export const dynamic = "force-dynamic";

interface ProjectListItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule_cron: string;
  last_run_at: string | null;
}

export default async function Home() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const snap = await projectsCol()
    .where("owner_uid", "==", session.uid)
    .orderBy("created_at", "desc")
    .limit(100)
    .get();

  const projects: ProjectListItem[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      name: data.name ?? "(unnamed)",
      description: data.description ?? "",
      enabled: data.enabled !== false,
      schedule_cron: data.schedule_cron ?? "",
      last_run_at: data.last_run_at?.toDate?.()
        ? data.last_run_at.toDate().toISOString()
        : (typeof data.last_run_at === "string" ? data.last_run_at : null),
    };
  });

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-black">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">
            Caspian Scraper
          </h1>
          <div className="flex items-center gap-3 text-sm text-zinc-600 dark:text-zinc-400">
            <span>{session.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Projects</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              {projects.length === 0
                ? "Create your first project to get started."
                : `${projects.length} project${projects.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <Link
            href="/projects/new"
            className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors"
          >
            + New project
          </Link>
        </div>

        {projects.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function ProjectCard({ project }: { project: ProjectListItem }) {
  return (
    <Link
      href={`/projects/${project.id}`}
      className="block rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 hover:border-zinc-400 dark:hover:border-zinc-600 transition-colors"
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-medium tracking-tight">{project.name}</h3>
        <span
          className={
            "text-xs px-2 py-0.5 rounded-full " +
            (project.enabled
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400")
          }
        >
          {project.enabled ? "enabled" : "disabled"}
        </span>
      </div>
      {project.description && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3 line-clamp-2">
          {project.description}
        </p>
      )}
      <div className="text-xs text-zinc-500 space-y-1">
        <div>
          schedule:{" "}
          <code className="text-zinc-700 dark:text-zinc-300">
            {project.schedule_cron}
          </code>
        </div>
        <div>
          last run:{" "}
          {project.last_run_at ? (
            <span title={project.last_run_at}>
              {fmtRelative(project.last_run_at)}
            </span>
          ) : (
            <span className="text-zinc-400">never</span>
          )}
        </div>
      </div>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
      <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
        No projects yet. A project is one scraping pipeline — a list of
        sources to scrape, one or more destinations to POST findings to,
        and a schedule.
      </p>
      <Link
        href="/projects/new"
        className="inline-flex items-center h-9 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      >
        Create your first project
      </Link>
    </div>
  );
}

function fmtRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Math.round((Date.now() - t) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}
