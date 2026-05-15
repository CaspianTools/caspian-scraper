import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifySessionCookie, adminDb } from "@/lib/firebase/admin";
import { GITHUB_APP_SLUG } from "@/lib/github/config";

export const dynamic = "force-dynamic";

async function loadUserState() {
  const cookieStore = await cookies();
  const session = cookieStore.get("__session")?.value;
  const decoded = await verifySessionCookie(session);
  if (!decoded) return null;
  const snap = await adminDb.collection("users").doc(decoded.uid).get();
  return { uid: decoded.uid, email: decoded.email ?? "", data: snap.data() };
}

export default async function Home() {
  const state = await loadUserState();
  if (!state) redirect("/signin");

  const fork = state.data?.fork as string | undefined;
  const installationId = state.data?.installation_id as number | undefined;

  if (!installationId || !fork) {
    const installUrl = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;
    return (
      <main className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-black p-6">
        <div className="w-full max-w-lg rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-8 shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">
            One more step
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
            Signed in as <strong>{state.email}</strong>. Now install the
            caspian-scraper GitHub App on your fork of{" "}
            <code className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900">
              CaspianTools/caspian-scraper
            </code>{" "}
            so we can read your data and trigger runs on your behalf.
          </p>
          <a
            href={installUrl}
            className="inline-flex items-center justify-center w-full h-11 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors"
          >
            Install on GitHub
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
              fork: <code className="text-xs">{fork}</code>
            </p>
          </div>
          <span className="text-xs text-zinc-500">{state.email}</span>
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
