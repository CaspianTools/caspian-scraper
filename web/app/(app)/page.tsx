import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { projectsCol } from "@/lib/firestore/collections";
import { humanizeCron } from "@/lib/cron/humanize";
import { SidebarHeader, SidebarLayout } from "@/components/shell/SidebarLayout";

export const dynamic = "force-dynamic";

const newJobCls =
  "inline-flex items-center rounded-lg text-sm font-medium transition-colors bg-brand-600 text-white hover:bg-brand-500 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20";

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
    <SidebarLayout
      sidebar={
        <>
          <SidebarHeader
            title="Jobs"
            subtitle={
              projects.length === 0
                ? "Create your first job to get started."
                : `${projects.length} job${projects.length === 1 ? "" : "s"}`
            }
          />
          <Link href="/projects/new" className={newJobCls + " h-10 px-4 w-full justify-center gap-2"}>
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            New job
          </Link>
          {projects.length > 0 && (
            <nav aria-label="Jobs" className="flex flex-col gap-0.5">
              {projects.map((p) => (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className="flex items-center gap-2.5 text-sm px-3 h-9 rounded-lg text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100 transition-colors"
                >
                  <span
                    aria-hidden
                    className={
                      "w-1.5 h-1.5 rounded-full shrink-0 " +
                      (p.enabled ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600")
                    }
                  />
                  <span className="truncate">{p.name}</span>
                </Link>
              ))}
            </nav>
          )}
        </>
      }
    >
      {projects.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </SidebarLayout>
  );
}

function ProjectCard({ project }: { project: ProjectListItem }) {
  return (
    <Link
      href={`/projects/${project.id}`}
      className="group flex flex-col rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-card hover:shadow-card-hover hover:border-zinc-300 dark:hover:border-zinc-700 hover:-translate-y-px transition-all"
    >
      <div className="p-5 flex-1">
        <div className="flex items-start gap-3 mb-3">
          <span
            aria-hidden
            className="w-9 h-9 rounded-lg bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-600/10 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-400/20 flex items-center justify-center text-sm font-semibold shrink-0"
          >
            {project.name.trim().charAt(0).toUpperCase() || "?"}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold tracking-tight text-zinc-900 dark:text-white truncate group-hover:text-brand-700 dark:group-hover:text-brand-300 transition-colors">
              {project.name}
            </h3>
            <p className="text-xs text-zinc-500 truncate" title={project.schedule_cron}>
              {humanizeCron(project.schedule_cron)}
            </p>
          </div>
          <span
            className={
              "inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full shrink-0 " +
              (project.enabled
                ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25"
                : "bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-500/15 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-400/15")
            }
          >
            <span aria-hidden className={"w-1.5 h-1.5 rounded-full " + (project.enabled ? "bg-emerald-500" : "bg-zinc-400")} />
            {project.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        {project.description ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400 line-clamp-2">{project.description}</p>
        ) : (
          <p className="text-sm text-zinc-400 dark:text-zinc-600 italic">No description</p>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-zinc-100 dark:border-zinc-800/80 text-xs text-zinc-500">
        <span>
          Last run{" "}
          {project.last_run_at ? (
            <span title={project.last_run_at} className="font-medium text-zinc-700 dark:text-zinc-300">
              {fmtRelative(project.last_run_at)}
            </span>
          ) : (
            <span className="text-zinc-400">never</span>
          )}
        </span>
        <span aria-hidden className="text-zinc-300 dark:text-zinc-600 group-hover:text-brand-500 group-hover:translate-x-0.5 transition-all">
          →
        </span>
      </div>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 px-6 py-16 text-center bg-white/60 dark:bg-zinc-950/40">
      <span
        aria-hidden
        className="mx-auto mb-4 w-12 h-12 rounded-xl bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-600/10 dark:bg-brand-500/10 dark:text-brand-300 flex items-center justify-center"
      >
        <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="7" width="18" height="13" rx="2" />
          <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18" />
        </svg>
      </span>
      <h2 className="text-base font-semibold tracking-tight mb-1">No jobs yet</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6 max-w-md mx-auto">
        A job is one scraping pipeline — websites to scrape, picked from the
        shared resource library. Everything a run finds is listed under the
        job&apos;s Findings for review.
      </p>
      <Link href="/projects/new" className={newJobCls + " h-9 px-4"}>
        Create your first job
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
