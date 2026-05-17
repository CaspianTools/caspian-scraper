import Link from "next/link";
import { redirect } from "next/navigation";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getSessionFromCookie } from "@/lib/auth/session";
import { sourcesCol } from "@/lib/firestore/collections";
import { SeedLegacyButton } from "@/components/SeedLegacyButton";

export const dynamic = "force-dynamic";

async function legacyFileExists(): Promise<boolean> {
  try {
    await fs.access(path.resolve(process.cwd(), "..", "employers.json"));
    return true;
  } catch {
    return false;
  }
}

interface PageProps {
  params: Promise<{ id: string }>;
}

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  ats: string;
  careers_url: string;
  active: boolean;
  countries: string[];
}

export default async function SourcesListPage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id } = await params;

  // Ownership is enforced by the parent layout.
  const [snap, hasLegacy] = await Promise.all([
    sourcesCol(id).orderBy("created_at", "desc").get(),
    legacyFileExists(),
  ]);
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
        <Link
          href={`/projects/${id}/sources/new`}
          className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          + Add source
        </Link>
      </div>

      {hasLegacy && <SeedLegacyButton projectId={id} /> }

      {sources.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4 max-w-md mx-auto">
            A source is one website (or feed) to scrape. Each source has an
            ATS type so the scraper knows how to parse it. Supported today:{" "}
            <code className="text-xs">successfactors</code>,{" "}
            <code className="text-xs">jibe</code>.
          </p>
          <Link
            href={`/projects/${id}/sources/new`}
            className="inline-flex items-center h-9 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Add your first source
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">ATS</th>
                <th className="text-left px-4 py-2 font-medium">Kind</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Countries</th>
                <th className="text-left px-4 py-2 font-medium w-px"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {sources.map((s) => (
                <tr
                  key={s.id}
                  className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{s.name}</div>
                    <div
                      className="text-xs text-zinc-500 truncate max-w-md"
                      title={s.careers_url}
                    >
                      {s.careers_url}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs text-zinc-600 dark:text-zinc-400">
                      {s.ats}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {s.kind}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        "text-xs px-2 py-0.5 rounded-full " +
                        (s.active
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400")
                      }
                    >
                      {s.active ? "active" : "paused"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                    {s.countries.length > 0
                      ? s.countries.slice(0, 3).join(", ") +
                        (s.countries.length > 3
                          ? ` +${s.countries.length - 3}`
                          : "")
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/projects/${id}/sources/${s.id}`}
                      className="text-sm text-zinc-700 dark:text-zinc-300 hover:underline"
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
