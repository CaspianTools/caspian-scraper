import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Shops are listed on the job's Sources page now. */
export default async function PricesSourcesPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/projects/${id}/sources`);
}
