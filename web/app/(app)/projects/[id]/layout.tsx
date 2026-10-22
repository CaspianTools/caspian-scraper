import { notFound } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { projectDoc } from "@/lib/firestore/collections";
import { SidebarHeader, SidebarLayout } from "@/components/shell/SidebarLayout";
import { ProjectNav } from "@/components/ProjectNav";
import { TEMPLATE_INFO, jobNav, jobSettings } from "@/lib/jobTemplates";

export const dynamic = "force-dynamic";

/**
 * Job (project) layout: the sidebar holds "← Jobs", the job's name, the
 * template it was made from and its enabled chip, and its menu — Results ·
 * Sources · Runs · Settings, plus Discover / Compare when those modules are
 * on (lib/jobTemplates.ts); pages render in the main area. 404s for a job
 * that isn't the session's.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionFromCookie();
  const { id } = await params;

  const snap = await projectDoc(id).get();
  if (!snap.exists) notFound();
  const data = snap.data();
  if (!data || data.owner_uid !== session?.uid) notFound();

  const enabled = data.enabled !== false;
  const settings = jobSettings(data);
  return (
    <SidebarLayout
      sidebar={
        <>
          <SidebarHeader
            back={{ href: "/", label: "Jobs" }}
            title={data.name}
            subtitle={
              <>
                <span className="inline-flex items-center px-1.5 py-0.5 mr-1.5 rounded-md bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-600/15 text-[11px] font-medium dark:bg-brand-500/10 dark:text-brand-300">
                  {TEMPLATE_INFO[settings.template].label}
                </span>
                {data.description || null}
              </>
            }
            badge={
              <span
                className={
                  "text-xs font-medium px-2 py-0.5 rounded-full shrink-0 " +
                  (enabled
                    ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25"
                    : "bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-500/15 dark:bg-zinc-800 dark:text-zinc-400 dark:ring-zinc-400/15")
                }
              >
                {enabled ? "enabled" : "paused"}
              </span>
            }
          />
          <ProjectNav items={jobNav(id, settings)} />
        </>
      }
    >
      {children}
    </SidebarLayout>
  );
}
