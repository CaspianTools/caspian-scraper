import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { getDatabase } from "@/lib/databases";
import { FullWidth } from "@/components/shell/SidebarLayout";
import { DatabaseView } from "@/components/databases/DatabaseView";
import { DeleteDatabaseButton } from "@/components/databases/DeleteDatabaseButton";

export const dynamic = "force-dynamic";

/** /databases/[id] — one database's records, paged on the server. */
export default async function DatabasePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id } = await params;
  const db = await getDatabase(session.uid, id);
  if (!db) notFound();

  return (
    <FullWidth>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <Link href="/databases" className="text-xs font-medium text-zinc-500 hover:text-brand-600 dark:hover:text-brand-400">
            ← Databases
          </Link>
          <h1 className="text-xl font-semibold tracking-tight mt-1">{db.name}</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-3xl">
            {db.description && <>{db.description} </>}
            <span className="text-zinc-500">
              {db.count.toLocaleString()} {db.record_label.plural} · <code className="text-xs">{db.file}</code> — commit it to share.
            </span>
          </p>
        </div>
        {db.id !== "companies" && (
          <div className="ml-auto">
            <DeleteDatabaseButton id={db.id} name={db.name} />
          </div>
        )}
      </div>
      <DatabaseView db={{ id: db.id, name: db.name, key: db.key, record_label: db.record_label }} />
    </FullWidth>
  );
}
