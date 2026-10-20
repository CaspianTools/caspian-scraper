import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { listResources } from "@/lib/firestore/resources";
import { ResourcesWorkspace } from "@/components/resources/ResourcesWorkspace";

export const dynamic = "force-dynamic";

/** /resources — the shared library of websites that jobs attach. */
export default async function ResourcesPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const resources = await listResources(session.uid);
  return <ResourcesWorkspace resources={resources} />;
}
