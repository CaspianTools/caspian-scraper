import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { FullWidth } from "@/components/shell/SidebarLayout";
import { FindingsDatabase } from "@/components/db/FindingsDatabase";

export const dynamic = "force-dynamic";

/** /db — browse and filter the whole findings database. */
export default async function DbPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  return (
    <FullWidth>
      <FindingsDatabase />
    </FullWidth>
  );
}
