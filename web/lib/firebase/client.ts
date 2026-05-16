"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
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

/**
 * Sign in with Google via Firebase Authentication. Returns the Firebase
 * user. All app data (employers, lessons, runs) lives in Firestore — the
 * web app never calls the GitHub API.
 */
export async function signInWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(firebaseAuth(), provider);
  return result.user;
}

export async function signOut() {
  await fbSignOut(firebaseAuth());
  await fetch("/api/auth/session-logout", { method: "POST" });
}
