import Link from "next/link";
import {
  DestinationForm,
  emptyDestinationFormInitial,
} from "@/components/DestinationForm";
import { secretsCol } from "@/lib/firestore/collections";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function NewDestinationPage({ params }: PageProps) {
  const { id } = await params;
  const snap = await secretsCol(id).get();
  const availableSecrets = snap.docs.map((d) => d.id);

  return (
    <>
      <Link
        href={`/projects/${id}/destinations`}
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Destinations
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">Add destination</h2>
      <DestinationForm
        projectId={id}
        initial={emptyDestinationFormInitial()}
        availableSecrets={availableSecrets}
      />
    </>
  );
}
