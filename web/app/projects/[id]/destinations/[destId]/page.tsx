import Link from "next/link";
import { notFound } from "next/navigation";
import { DestinationForm } from "@/components/DestinationForm";
import type { DestinationFormInitial } from "@/components/destinationFormDefaults";
import { destinationsCol, secretsCol } from "@/lib/firestore/collections";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; destId: string }>;
}

export default async function EditDestinationPage({ params }: PageProps) {
  const { id, destId } = await params;
  const [destSnap, secretsSnap] = await Promise.all([
    destinationsCol(id).doc(destId).get(),
    secretsCol(id).get(),
  ]);
  if (!destSnap.exists) notFound();
  const data = destSnap.data() ?? {};
  const initial: DestinationFormInitial = {
    name: data.name ?? "",
    base_url: data.base_url ?? "",
    list_path: data.list_path ?? "",
    post_path: data.post_path ?? "",
    auth_header_name: data.auth_header_name ?? "",
    auth_header_format: data.auth_header_format ?? "{secret}",
    secret_ref: data.secret_ref ?? "",
  };
  const availableSecrets = secretsSnap.docs.map((d) => d.id);

  return (
    <>
      <Link
        href={`/projects/${id}/destinations`}
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Destinations
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">
        Edit {initial.name || "destination"}
      </h2>
      <DestinationForm
        projectId={id}
        destId={destId}
        initial={initial}
        availableSecrets={availableSecrets}
      />
    </>
  );
}
