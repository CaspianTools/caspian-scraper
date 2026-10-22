import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Car listings are on the job's Results page now. */
export default async function CarListingsPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/projects/${id}`);
}
