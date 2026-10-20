import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { resourceDoc } from "@/lib/firestore/collections";
import { resourceUsage } from "@/lib/firestore/resources";
import { SourceForm } from "@/components/SourceForm";
import { SidebarHeader, SidebarLayout } from "@/components/shell/SidebarLayout";
import type { SourceFormInitial } from "@/components/sourceFormDefaults";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ rid: string }>;
}

export default async function EditResourcePage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { rid } = await params;

  const [snap, usage] = await Promise.all([
    resourceDoc(rid).get(),
    resourceUsage(session.uid),
  ]);
  if (!snap.exists || snap.get("owner_uid") !== session.uid) notFound();
  const data = snap.data() ?? {};
  const usedBy = usage.get(rid) ?? [];

  const initial: SourceFormInitial = {
    name: data.name ?? "",
    kind: (data.kind as SourceFormInitial["kind"]) ?? "employer",
    ats: (data.ats as SourceFormInitial["ats"]) ?? "unknown",
    careers_url: data.careers_url ?? "",
    active: data.active !== false,
    countries: Array.isArray(data.countries) ? data.countries : [],
    segment: data.segment ?? "",
    headquarters: data.headquarters ?? "",
    website: data.website ?? "",
    linkedin: data.linkedin ?? "",
    notes: data.notes ?? "",
  };

  return (
    <SidebarLayout
      sidebar={
        <>
          <SidebarHeader
            back={{ href: "/resources", label: "Resources" }}
            title={initial.name || "Resource"}
            subtitle="Shared resource"
          />
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Used by</p>
            {usedBy.length === 0 ? (
              <p className="text-sm text-zinc-500">No job yet.</p>
            ) : (
              <nav className="flex flex-col gap-0.5">
                {usedBy.map((u) => (
                  <Link
                    key={u.id}
                    href={`/projects/${u.id}/sources`}
                    className="text-sm px-3 py-2 rounded-lg text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900 truncate"
                  >
                    {u.name}
                  </Link>
                ))}
              </nav>
            )}
            {usedBy.length > 0 && (
              <p className="text-xs text-zinc-500">
                Changes apply to every job above. Deleting it detaches it from all of them.
              </p>
            )}
          </div>
        </>
      }
    >
      <div className="max-w-3xl space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Edit {initial.name || "resource"}</h2>
        <SourceForm sourceId={rid} apiPath="/api/resources" listHref="/resources" initial={initial} />
      </div>
    </SidebarLayout>
  );
}
