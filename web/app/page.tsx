import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { findUserFork } from "@/lib/github/app";
import { adminDb } from "@/lib/firebase/admin";
import { UPSTREAM_REPO } from "@/lib/github/config";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  // Resolve the user's fork on first visit (or refresh once a day).
  let fork = session.fork;
  if (!fork) {
    fork =
      (await findUserFork(session.ghToken, UPSTREAM_REPO.repo)) ?? undefined;
    if (fork) {
      await adminDb
        .collection("users")
        .doc(session.uid)
        .set({ fork }, { merge: true });
    }
  }

  if (!fork) {
    const forkUrl = `https://github.com/${UPSTREAM_REPO.owner}/${UPSTREAM_REPO.repo}/fork`;
    return (
      <main className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-black p-6">
        <div className="w-full max-w-lg rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-8 shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">
            One more step
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
            Signed in as <strong>{session.email}</strong>. We can&apos;t
            find a fork of{" "}
            <code className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900">
              {UPSTREAM_REPO.owner}/{UPSTREAM_REPO.repo}
            </code>{" "}
            under your GitHub account. Create one, then come back and
            refresh.
          </p>
          <a
            href={forkUrl}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center justify-center w-full h-11 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors"
          >
            Fork on GitHub
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-black p-6">
      <div className="max-w-5xl mx-auto">
        <header className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              HSE Scraper
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              fork: <code className="text-xs">{fork.full_name}</code>
            </p>
          </div>
          <span className="text-xs text-zinc-500">{session.email}</span>
        </header>
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-8">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Dashboard pages land here in Phase 2.
          </p>
        </div>
      </div>
    </main>
  );
}
