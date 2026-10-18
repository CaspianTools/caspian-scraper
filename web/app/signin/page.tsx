"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithGoogle, signOut } from "@/lib/firebase/client";

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
      if (res.status === 403) {
        // Allowlisted accounts only. Sign back out of Firebase so the user
        // isn't left authenticated with no session — otherwise the Google
        // popup silently reuses the account and a retry looks like a no-op.
        await signOut().catch(() => {});
        throw new Error(
          `${user.email ?? "That account"} isn't authorized for this workspace. ` +
            `Ask the workspace owner to add it.`
        );
      }
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
          Sign in with your Google account to manage employers, browse
          scraper lessons, and monitor runs.
        </p>
        <button
          onClick={onSignIn}
          disabled={busy || !onSignIn}
          className="w-full h-11 rounded-lg bg-white text-zinc-900 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 border border-zinc-300 dark:bg-zinc-900 dark:text-white dark:hover:bg-zinc-800 dark:border-zinc-700 transition-colors flex items-center justify-center gap-3"
        >
          <svg viewBox="0 0 48 48" className="w-5 h-5" aria-hidden="true">
            <path
              fill="#FFC107"
              d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C12.955 4 4 12.955 4 24s8.955 20 20 20s20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
            />
            <path
              fill="#FF3D00"
              d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4C16.318 4 9.656 8.337 6.306 14.691z"
            />
            <path
              fill="#4CAF50"
              d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
            />
            <path
              fill="#1976D2"
              d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
            />
          </svg>
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
