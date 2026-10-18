import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { destinationsCol, projectsCol } from "@/lib/firestore/collections";
import { listResources } from "@/lib/firestore/resources";
import {
  JobWizard,
  type DestinationSourceJob,
} from "@/components/job-wizard/JobWizard";

export const dynamic = "force-dynamic";

/**
 * /projects/new — step-by-step job creation. A static segment, so it wins
 * over /projects/[id]; POST /api/projects reserves the id "new" to match.
 */
export default async function NewJobPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const [resources, projects] = await Promise.all([
    listResources(session.uid),
    projectsCol()
      .where("owner_uid", "==", session.uid)
      .orderBy("created_at", "desc")
      .limit(100)
      .get(),
  ]);

  const jobsWithDestinations: DestinationSourceJob[] = (
    await Promise.all(
      projects.docs.map(async (p) => {
        const dests = await destinationsCol(p.id).select("name").get();
        return {
          id: p.id,
          name: p.get("name") ?? p.id,
          destinations: dests.docs.map((d) => d.get("name") ?? d.id),
        };
      })
    )
  ).filter((j) => j.destinations.length > 0);

  return (
    <main className="max-w-4xl mx-auto px-6 py-10 space-y-6">
      <div>
        <Link
          href="/"
          className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline"
        >
          ← Jobs
        </Link>
        <h2 className="text-2xl font-semibold tracking-tight mt-2">New job</h2>
      </div>
      <JobWizard
        resources={resources}
        jobsWithDestinations={jobsWithDestinations}
      />
    </main>
  );
}
