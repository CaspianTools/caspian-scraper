import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { listResources } from "@/lib/firestore/resources";
import { ResourceLibrary } from "@/components/resources/ResourceLibrary";

export const dynamic = "force-dynamic";

/** /resources — the shared library of websites that jobs attach. */
export default async function ResourcesPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const resources = await listResources(session.uid);

  return (
    <main className="max-w-6xl mx-auto px-6 py-10 space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Resources</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          Websites to scrape, shared across jobs.{" "}
          {resources.length > 0 &&
            `${resources.length} resource${resources.length === 1 ? "" : "s"}.`}
        </p>
      </div>
      <ResourceLibrary resources={resources} />
    </main>
  );
}
