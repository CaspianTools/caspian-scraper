import { localDb, type Firestore } from "@/lib/localdb";

/**
 * The app's database handle. The app runs locally with no Firebase project,
 * so this is the file-backed store in lib/localdb.ts (shared with the Python
 * scraper). The name is kept so every `adminDb` importer stays unchanged.
 */
export const adminDb: Firestore = localDb;
