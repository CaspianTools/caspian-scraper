"use client";

import { firebaseAuth } from "./client";

/**
 * Authenticated fetch — attaches the current user's Firebase ID token
 * as a Bearer header. API routes verify the token server-side.
 *
 * On page load the Firebase client SDK restores auth state from
 * IndexedDB asynchronously, so we MUST await authStateReady() before
 * reading currentUser — otherwise the first fetch right after a
 * navigation sees `currentUser === null` even when the user is signed
 * in, which presents as "signed out" in the UI while the server cookie
 * still shows their email.
 *
 * If after the SDK is ready there's still no user, that's a real
 * sign-out: the client tells the server to clear its cookie too, and
 * sends the user back to /signin. Prevents the "ghost session" state
 * where the server says signed in but the client doesn't.
 */
export async function authedFetch(
  input: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  const auth = firebaseAuth();
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) {
    // Genuine sign-out detected on the client. Resync the server side
    // by clearing the cookie, then send the user to /signin so they
    // get a fresh session.
    try {
      await fetch("/api/auth/session-logout", { method: "POST" });
    } catch {
      /* ignore — we redirect either way */
    }
    if (typeof window !== "undefined") {
      const next = encodeURIComponent(
        window.location.pathname + window.location.search
      );
      window.location.href = `/signin?next=${next}`;
    }
    throw new Error("session expired — redirecting to sign-in");
  }
  const idToken = await user.getIdToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${idToken}`);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(input, { ...init, headers });
}
