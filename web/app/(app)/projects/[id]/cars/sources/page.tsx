import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Classifieds sites are listed on the job's Sources page now. */
export default async function CarSourcesListPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/projects/${id}/sources`);
}
