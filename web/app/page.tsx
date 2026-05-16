import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-black p-6">
      <div className="max-w-5xl mx-auto">
        <header className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              HSE Scraper
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Signed in as <strong>{session.email}</strong>
            </p>
          </div>
        </header>
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-8">
          <h2 className="text-lg font-medium mb-2">Welcome</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Dashboard pages land here in the next phase. Employers,
            lessons, and runs will be backed by the dedicated{" "}
            <code className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900">
              scraper
            </code>{" "}
            Firestore database.
          </p>
        </div>
      </div>
    </main>
  );
}
