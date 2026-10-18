import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { resourceDoc } from "@/lib/firestore/collections";
import { resourceUsage } from "@/lib/firestore/resources";
import { SourceForm } from "@/components/SourceForm";
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
    <main className="max-w-4xl mx-auto px-6 py-10 space-y-4">
      <Link
        href="/resources"
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Resources
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">
        Edit {initial.name || "resource"}
      </h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {usedBy.length === 0 ? (
          "Not used by any job yet."
        ) : (
          <>
            Changes apply to every job that uses it:{" "}
            {usedBy.map((u, i) => (
              <span key={u.id}>
                {i > 0 && ", "}
                <Link href={`/projects/${u.id}/sources`} className="underline">
                  {u.name}
                </Link>
              </span>
            ))}
            . Deleting it detaches it from all of them.
          </>
        )}
      </p>
      <SourceForm
        sourceId={rid}
        apiPath="/api/resources"
        listHref="/resources"
        initial={initial}
      />
    </main>
  );
}
