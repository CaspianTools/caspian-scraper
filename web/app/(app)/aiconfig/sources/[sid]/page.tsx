import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { GenericSourceDetail } from "@/components/aiconfig/GenericSourceDetail";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ sid: string }>;
}

/**
 * Generic-source detail. Auth-guarded like every other (app) page; the
 * ownership check + all data loading happen client-side in
 * GenericSourceDetail via the /api/generic/sources/[sid] routes (which
 * enforce owner == session.uid and 404 otherwise).
 */
export default async function GenericSourcePage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { sid } = await params;

  return (
    <div className="max-w-4xl mx-auto px-6 py-6">
      <GenericSourceDetail sid={sid} />
    </div>
  );
}
