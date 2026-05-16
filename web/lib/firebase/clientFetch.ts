"use client";

import { firebaseAuth } from "./client";

/**
 * Authenticated fetch — attaches the current user's Firebase ID token
 * as a Bearer header. API routes verify the token server-side.
 */
export async function authedFetch(
  input: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  const user = firebaseAuth().currentUser;
  if (!user) {
    throw new Error("not signed in");
  }
  const idToken = await user.getIdToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${idToken}`);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(input, { ...init, headers });
}
