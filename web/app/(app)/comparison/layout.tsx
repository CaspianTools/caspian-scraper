import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { SidebarHeader, SidebarLayout } from "@/components/shell/SidebarLayout";
import { SidebarNav } from "@/components/shell/SidebarNav";

export const dynamic = "force-dynamic";

/**
 * Comparison section layout: the sidebar holds the section title and its nav
 * (Findings / Compare / Sources / Runs); pages render in the main area.
 */
export default async function ComparisonLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  return (
    <SidebarLayout
      sidebar={
        <>
          <SidebarHeader title="Comparison" subtitle="Cross-retailer product prices" />
          <SidebarNav
            label="Comparison"
            items={[
              { href: "/comparison", label: "Findings", exact: true },
              { href: "/comparison/compare", label: "Compare" },
              { href: "/comparison/sources", label: "Sources" },
              { href: "/comparison/runs", label: "Runs" },
            ]}
          />
        </>
      }
    >
      {children}
    </SidebarLayout>
  );
}
