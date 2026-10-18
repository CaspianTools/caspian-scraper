import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { sourcesCol } from "@/lib/firestore/collections";
import { SourcesTable, type SourceRow } from "@/components/SourcesTable";
import { OpenQuickAddButton } from "@/components/quick-add/OpenQuickAddButton";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function SourcesListPage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id } = await params;

  // Ownership is enforced by the parent layout.
  const snap = await sourcesCol(id).orderBy("created_at", "desc").get();
  const sources: SourceRow[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      name: data.name ?? "(unnamed)",
      kind: data.kind ?? "employer",
      ats: data.ats ?? "unknown",
      careers_url: data.careers_url ?? "",
      active: data.active !== false,
      countries: Array.isArray(data.countries) ? data.countries : [],
    };
  });

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Sources</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            {sources.length === 0
              ? "No sources yet."
              : `${sources.length} source${sources.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <OpenQuickAddButton kind="source" projectId={id}>
          + Add source
        </OpenQuickAddButton>
      </div>

      {sources.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4 max-w-md mx-auto">
            A source is one website (or feed) to scrape. Each source has an
            ATS type so the scraper knows how to parse it. Supported today:{" "}
            <code className="text-xs">successfactors</code>,{" "}
            <code className="text-xs">jibe</code>.
          </p>
          <OpenQuickAddButton kind="source" projectId={id} size="sm">
            Add your first source
          </OpenQuickAddButton>
        </div>
      ) : (
        <SourcesTable projectId={id} sources={sources} />
      )}
    </>
  );
}
