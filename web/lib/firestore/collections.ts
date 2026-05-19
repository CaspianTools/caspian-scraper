import { adminDb } from "@/lib/firebase/admin";
import type {
  Firestore,
  CollectionReference,
} from "firebase-admin/firestore";

/**
 * Typed collection references. Use these in API routes / server
 * components instead of stringly-typed `adminDb.collection(...)` calls.
 *
 * The Firestore Admin SDK doesn't natively support generic types on
 * collection refs, so these are thin wrappers that document the shape
 * stored at each path. Consumers should still validate writes with the
 * Zod schemas in `./schema.ts`.
 */

function db(): Firestore {
  return adminDb;
}

export function usersCol(): CollectionReference {
  return db().collection("users");
}

export function userDoc(uid: string) {
  return usersCol().doc(uid);
}

export function projectsCol(): CollectionReference {
  return db().collection("projects");
}

export function projectDoc(projectId: string) {
  return projectsCol().doc(projectId);
}

export function sourcesCol(projectId: string): CollectionReference {
  return projectDoc(projectId).collection("sources");
}

export function destinationsCol(projectId: string): CollectionReference {
  return projectDoc(projectId).collection("destinations");
}

export function secretsCol(projectId: string): CollectionReference {
  return projectDoc(projectId).collection("secrets");
}

export function runsCol(projectId: string): CollectionReference {
  return projectDoc(projectId).collection("runs");
}

export function lessonsCol(projectId: string): CollectionReference {
  return projectDoc(projectId).collection("lessons");
}

export function publishedCol(projectId: string): CollectionReference {
  return projectDoc(projectId).collection("published");
}

export function findingsCol(projectId: string): CollectionReference {
  return projectDoc(projectId).collection("findings");
}

export function listingsCol(projectId: string): CollectionReference {
  return projectDoc(projectId).collection("listings");
}

export function canonicalsCol(projectId: string): CollectionReference {
  return projectDoc(projectId).collection("canonicals");
}

export function runRequestsCol(): CollectionReference {
  return db().collection("run_requests");
}

// ---- slug generator -------------------------------------------------------

/**
 * Make a URL-safe slug from a human-readable name. Used as the doc ID
 * for projects so paths are stable + readable. Falls back to a random
 * ID if the slug is empty (e.g. name is all punctuation).
 */
export function makeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `p-${Math.random().toString(36).slice(2, 10)}`;
}
