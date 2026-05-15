"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithGithub } from "@/lib/firebase/client";

export default function SignInPage() {
  return (
    <Suspense fallback={<SignInShell busy={false} />}>
      <SignInContent />
    </Suspense>
  );
}

function SignInContent() {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSignIn() {
    setErr(null);
    setBusy(true);
    try {
      const { user, ghToken } = await signInWithGithub();
      const idToken = await user.getIdToken();
      const res = await fetch("/api/auth/session-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, ghToken }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`session-login failed (${res.status}): ${body}`);
      }
      const next = params.get("next") || "/";
      router.push(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return <SignInShell busy={busy} err={err} onSignIn={handleSignIn} />;
}

function SignInShell({
  busy,
  err,
  onSignIn,
}: {
  busy: boolean;
  err?: string | null;
  onSignIn?: () => void;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-black p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight mb-2">
          HSE Scraper
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
          Sign in with your GitHub account. We&apos;ll use your fork of
          caspian-scraper to read your data and trigger scraper runs.
        </p>
        <button
          onClick={onSignIn}
          disabled={busy || !onSignIn}
          className="w-full h-11 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors flex items-center justify-center gap-2"
        >
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className="w-5 h-5"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M12 0C5.373 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.6.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.084-.729.084-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"
            />
          </svg>
          {busy ? "Signing in…" : "Sign in with GitHub"}
        </button>
        {err && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">
            {err}
          </p>
        )}
      </div>
    </main>
  );
}
