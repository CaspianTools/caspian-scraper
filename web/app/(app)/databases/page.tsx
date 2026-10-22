import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { listDatabases } from "@/lib/databases";
import { FullWidth } from "@/components/shell/SidebarLayout";
import { NewDatabaseButton } from "@/components/databases/NewDatabaseButton";

export const dynamic = "force-dynamic";

/**
 * /databases — named record databases that jobs grow and read from
 * (data/databases/<id>.json + db/<id>.jsonl, committed).
 */
export default async function DatabasesPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const dbs = await listDatabases(session.uid);

  return (
    <FullWidth>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Databases</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-2xl">
            Collections that jobs grow as they run and read from as sources — companies, vacancies,
            listings, anything. Each is committed to git (<code className="text-xs">db/&lt;id&gt;.jsonl</code>),
            so every computer that pulls the repo shares it.
          </p>
        </div>
        <div className="ml-auto">
          <NewDatabaseButton />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {dbs.map((d) => (
          <Link
            key={d.id}
            href={`/databases/${d.id}`}
            className="group flex flex-col rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 shadow-card hover:shadow-card-hover hover:border-zinc-300 dark:hover:border-zinc-700 transition-all"
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="w-9 h-9 rounded-lg bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-600/10 dark:bg-brand-500/10 dark:text-brand-300 flex items-center justify-center shrink-0"
              >
                <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                  <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
                  <path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold tracking-tight truncate group-hover:text-brand-700 dark:group-hover:text-brand-300">{d.name}</h3>
                <p className="text-xs text-zinc-500">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">{d.count.toLocaleString()}</span> {d.record_label.plural}
                </p>
              </div>
            </div>
            {d.description && <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400 line-clamp-2">{d.description}</p>}
            <p className="mt-3 text-[11px] font-mono text-zinc-400">{d.file}</p>
          </Link>
        ))}
      </div>
    </FullWidth>
  );
}
