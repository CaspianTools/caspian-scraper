import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { listResources } from "@/lib/firestore/resources";
import { JobWizard } from "@/components/job-wizard/JobWizard";

export const dynamic = "force-dynamic";

/**
 * /projects/new — step-by-step job creation. A static segment, so it wins
 * over /projects/[id]; POST /api/projects reserves the id "new" to match.
 */
export default async function NewJobPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const resources = await listResources(session.uid);

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
      <JobWizard resources={resources} />
    </main>
  );
}
