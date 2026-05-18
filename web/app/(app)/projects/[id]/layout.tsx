import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { projectDoc } from "@/lib/firestore/collections";
import { ProjectNav } from "@/components/ProjectNav";

export const dynamic = "force-dynamic";

/**
 * Project sub-layout. Sits *inside* the authed (app)/layout.tsx, so
 * the global header is already rendered above. This file only adds:
 *
 *   1. A breadcrumb sub-bar with the project name + enabled chip and
 *      a "← Projects" back link.
 *   2. The tab nav (Overview / Sources / Destinations / …).
 *
 * Auth was checked one level up; we re-fetch the project doc here
 * for the name + chip + ownership guard (404 if not the user's).
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

  return (
    <>
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
        <div className="max-w-6xl mx-auto px-6 h-12 flex items-center gap-3 min-w-0">
          <Link
            href="/"
            className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline shrink-0"
          >
            ← Projects
          </Link>
          <span className="text-zinc-400 shrink-0">/</span>
          <h1 className="text-sm font-semibold tracking-tight truncate">
            {data.name}
          </h1>
          <span
            className={
              "text-xs px-2 py-0.5 rounded-full shrink-0 " +
              (data.enabled !== false
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400")
            }
          >
            {data.enabled !== false ? "enabled" : "disabled"}
          </span>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <ProjectNav projectId={id} />
        {children}
      </div>
    </>
  );
}
