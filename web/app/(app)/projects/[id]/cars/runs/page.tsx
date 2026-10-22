import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Car runs are listed on the job's Runs page now. */
export default async function CarRunsPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/projects/${id}/runs`);
}
