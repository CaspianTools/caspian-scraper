import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { listResources } from "@/lib/firestore/resources";
import { JobWizard } from "@/components/job-wizard/JobWizard";

export const dynamic = "force-dynamic";

/**
 * /projects/new — step-by-step job creation (the wizard draws its own
 * sidebar). A static segment, so it wins over /projects/[id]; POST
 * /api/projects reserves the id "new" to match.
 */
export default async function NewJobPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const resources = await listResources(session.uid);
  return <JobWizard resources={resources} />;
}
