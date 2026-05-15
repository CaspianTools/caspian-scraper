import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

// Service-account credentials. In production (App Hosting), set these as
// secrets in apphosting.yaml. For local dev, drop them in web/.env.local.
//
// Lazy-initialized so `next build` can import this module without env vars
// (the build collects page metadata without executing handlers).
let _app: App | null = null;
function adminApp(): App {
  if (_app) return _app;
  const existing = getApps()[0];
  if (existing) {
    _app = existing;
    return _app;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase admin not configured. Set FIREBASE_PROJECT_ID, " +
        "FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY (see web/.env.local.example)."
    );
  }
  _app = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
  return _app;
}

export const adminAuth: Auth = new Proxy({} as Auth, {
  get: (_t, p) => Reflect.get(getAuth(adminApp()), p),
});
export const adminDb: Firestore = new Proxy({} as Firestore, {
  get: (_t, p) => Reflect.get(getFirestore(adminApp()), p),
});

/**
 * Verify a Firebase ID token from an Authorization: Bearer header.
 * Use for mutating API routes (write endpoints).
 */
export async function verifyIdToken(authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return null;
  try {
    return await adminAuth.verifyIdToken(token);
  } catch {
    return null;
  }
}

/**
 * Verify a Firebase session cookie. Use for top-level navigations
 * (e.g., the OAuth callback where no Authorization header is possible).
 */
export async function verifySessionCookie(cookie: string | undefined) {
  if (!cookie) return null;
  try {
    return await adminAuth.verifySessionCookie(cookie, true);
  } catch {
    return null;
  }
}

/**
 * Trade a fresh ID token for a session cookie. Called from
 * /api/auth/session-login after the client signs in with Google.
 */
export async function mintSessionCookie(idToken: string, expiresInMs: number) {
  return adminAuth.createSessionCookie(idToken, { expiresIn: expiresInMs });
}
