import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Products are on the job's Results page now. */
export default async function PricesProductsPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/projects/${id}`);
}
