"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

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
 * Client Firestore, bound to the same named database the backend uses
 * (FIRESTORE_DATABASE_ID = "scraper"). Only used for realtime reads
 * (onSnapshot) of docs the signed-in user owns — writes still go through
 * the API routes (admin SDK). The database id defaults to "scraper";
 * override with NEXT_PUBLIC_FIRESTORE_DATABASE_ID if ever renamed.
 */
export function firebaseDb(): Firestore {
  const dbId =
    process.env.NEXT_PUBLIC_FIRESTORE_DATABASE_ID?.trim() || "scraper";
  return getFirestore(app(), dbId);
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
