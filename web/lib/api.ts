"use client";

/**
 * fetch() for the app's own API routes. There is no sign-in (the app runs
 * locally — see lib/auth/session.ts), so this only sets the JSON content type.
 */
export async function apiFetch(
  input: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(input, { ...init, headers });
}
