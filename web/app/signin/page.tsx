"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithGoogle } from "@/lib/firebase/client";

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
      const user = await signInWithGoogle();
      const idToken = await user.getIdToken();
      const res = await fetch("/api/auth/session-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        throw new Error(`session-login failed: ${res.status}`);
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
          Sign in with your Google account, then install the
          caspian-scraper GitHub App on your fork.
        </p>
        <button
          onClick={onSignIn}
          disabled={busy || !onSignIn}
          className="w-full h-11 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors"
        >
          {busy ? "Signing in…" : "Sign in with Google"}
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
