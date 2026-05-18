import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { destinationsCol } from "@/lib/firestore/collections";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

interface DestRow {
  id: string;
  name: string;
  base_url: string;
  post_path: string;
  auth_header_name: string;
  secret_ref: string;
}

export default async function DestinationsListPage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id } = await params;

  const snap = await destinationsCol(id).orderBy("created_at", "desc").get();
  const dests: DestRow[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      name: data.name ?? "(unnamed)",
      base_url: data.base_url ?? "",
      post_path: data.post_path ?? "",
      auth_header_name: data.auth_header_name ?? "",
      secret_ref: data.secret_ref ?? "",
    };
  });

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Destinations</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            {dests.length === 0
              ? "No destinations yet."
              : `${dests.length} destination${dests.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <Link
          href={`/projects/${id}/destinations/new`}
          className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          + Add destination
        </Link>
      </div>

      {dests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4 max-w-md mx-auto">
            A destination is the API the scraper POSTs new findings to.
            Configure the base URL, the auth header, and which secret
            holds the API key.
          </p>
          <Link
            href={`/projects/${id}/destinations/new`}
            className="inline-flex items-center h-9 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Add a destination
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">POST endpoint</th>
                <th className="text-left px-4 py-2 font-medium">Auth header</th>
                <th className="text-left px-4 py-2 font-medium">Secret</th>
                <th className="text-left px-4 py-2 font-medium w-px"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {dests.map((d) => (
                <tr
                  key={d.id}
                  className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                >
                  <td className="px-4 py-3 font-medium">{d.name}</td>
                  <td className="px-4 py-3 text-xs font-mono text-zinc-600 dark:text-zinc-400 truncate max-w-xs">
                    {d.base_url}
                    {d.post_path}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-zinc-600 dark:text-zinc-400">
                    {d.auth_header_name}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <code className="text-zinc-600 dark:text-zinc-400">
                      {d.secret_ref}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/projects/${id}/destinations/${d.id}`}
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
