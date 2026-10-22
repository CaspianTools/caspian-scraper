import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { projectDoc } from "@/lib/firestore/collections";
import { ProjectSettingsForm } from "@/components/ProjectSettingsForm";
import { jobKind } from "@/lib/jobKinds";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function SettingsPage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id } = await params;

  const snap = await projectDoc(id).get();
  if (!snap.exists) notFound();
  const data = snap.data();
  if (!data || data.owner_uid !== session.uid) notFound();

  return (
    <>
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Settings</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          Rename the job, pause it, or delete it.
        </p>
      </div>
      <ProjectSettingsForm
        projectId={id}
        kind={jobKind(data.kind)}
        initial={{
          name: data.name ?? "",
          description: data.description ?? "",
          schedule_cron: data.schedule_cron ?? "30 4 * * *",
          enabled: data.enabled !== false,
        }}
      />
    </>
  );
}
