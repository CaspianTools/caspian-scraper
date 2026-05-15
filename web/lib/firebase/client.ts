"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GithubAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

let _app: FirebaseApp | null = null;
function app(): FirebaseApp {
  _app ??= getApps()[0] ?? initializeApp(config);
  return _app;
}

export function firebaseAuth() {
  return getAuth(app());
}

export interface GithubSignInResult {
  user: User;
  /** GitHub OAuth user access token. Use to call api.github.com on behalf of the user. */
  ghToken: string;
}

/**
 * Sign in via Firebase Auth's built-in GitHub provider. Returns the
 * Firebase user AND the GitHub access token Firebase received during the
 * OAuth dance. We only get this token at sign-in time — it must be
 * stashed server-side before this function's caller forgets it.
 */
export async function signInWithGithub(): Promise<GithubSignInResult> {
  const provider = new GithubAuthProvider();
  // Scopes we need to manage the scraper repo. `repo` covers both
  // contents read/write and Actions for public+private repos.
  provider.addScope("repo");
  provider.addScope("workflow");
  const result = await signInWithPopup(firebaseAuth(), provider);
  const credential = GithubAuthProvider.credentialFromResult(result);
  if (!credential?.accessToken) {
    throw new Error(
      "Sign-in succeeded but Firebase did not return a GitHub access token. " +
        "Make sure the GitHub provider is enabled in Firebase Auth and the " +
        "OAuth App has access to the repo."
    );
  }
  return { user: result.user, ghToken: credential.accessToken };
}

export async function signOut() {
  await fbSignOut(firebaseAuth());
  // Server-side cookie cleanup too.
  await fetch("/api/auth/session-logout", { method: "POST" });
}
