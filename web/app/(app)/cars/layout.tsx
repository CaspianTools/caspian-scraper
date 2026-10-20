import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { SidebarHeader, SidebarLayout } from "@/components/shell/SidebarLayout";
import { SidebarNav } from "@/components/shell/SidebarNav";

export const dynamic = "force-dynamic";

/**
 * Cars section layout: the sidebar holds the section title and its nav
 * (Listings / Sources / Runs); pages render in the main area.
 *
 * Car sources reuse the standalone `classifieds/` scraper as their engine
 * (scrape.py:run_car_source) — top-level, per-user, not nested under a project.
 */
export default async function CarsLayout({
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
          <SidebarHeader
            title="Cars"
            subtitle="Car classifieds (OpenSooq / Dubizzle / YallaMotor — Oman)"
          />
          <SidebarNav
            label="Cars"
            items={[
              { href: "/cars", label: "Listings", exact: true },
              { href: "/cars/sources", label: "Sources" },
              { href: "/cars/runs", label: "Runs" },
            ]}
          />
        </>
      }
    >
      {children}
    </SidebarLayout>
  );
}
