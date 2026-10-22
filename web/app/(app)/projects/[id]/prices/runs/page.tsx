import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Shop runs are listed on the job's Runs page now. */
export default async function PricesRunsPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/projects/${id}/runs`);
}
