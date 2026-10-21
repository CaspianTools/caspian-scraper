import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { FullWidth } from "@/components/shell/SidebarLayout";
import { KeySettings } from "@/components/settings/KeySettings";

export const dynamic = "force-dynamic";

const DATA_PLACES: [string, string][] = [
  ["data/", "Jobs and the resource library — committed, shared with git."],
  ["db/", "The findings database (companies found by Find websites) — committed."],
  ["local-data/", "Runs, findings, lessons, logs and the AI key — this computer only."],
];

/** /settings — the AI provider + key, and where this computer keeps its data. */
export default async function SettingsPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  return (
    <FullWidth>
      <div className="max-w-4xl space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Everything runs on this computer, with no sign-in.
          </p>
        </div>

        <KeySettings canManage={session.isSuperAdmin} />

        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6 space-y-3">
          <h3 className="text-sm font-semibold tracking-tight">Where data lives</h3>
          <dl className="text-sm divide-y divide-zinc-100 dark:divide-zinc-800">
            {DATA_PLACES.map(([dir, what]) => (
              <div key={dir} className="py-2 flex flex-col sm:flex-row sm:gap-4">
                <dt className="font-mono text-xs sm:w-28 shrink-0 pt-0.5">{dir}</dt>
                <dd className="text-zinc-600 dark:text-zinc-400">{what}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </FullWidth>
  );
}
