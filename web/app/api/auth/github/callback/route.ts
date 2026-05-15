import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie, adminDb } from "@/lib/firebase/admin";
import { getInstallationMeta } from "@/lib/github/app";

/**
 * GitHub redirects users here after they install the App on their fork.
 *
 *   GET /api/auth/github/callback?installation_id=N&setup_action=install
 *
 * Firebase session is conveyed via a __session cookie set by
 * /api/auth/session-login after the client signs in with Google.
 *
 * On success: writes {installation_id, fork} into /users/{uid} in
 * Firestore, then redirects to /.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const installationIdRaw = url.searchParams.get("installation_id");
  if (!installationIdRaw) {
    return NextResponse.json(
      { error: "missing installation_id" },
      { status: 400 }
    );
  }
  const installationId = Number(installationIdRaw);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return NextResponse.json(
      { error: "invalid installation_id" },
      { status: 400 }
    );
  }

  const decoded = await verifySessionCookie(
    req.cookies.get("__session")?.value
  );
  if (!decoded) {
    return NextResponse.redirect(new URL("/signin", url));
  }

  // Verify the installation actually exists and figure out the fork.
  const meta = await getInstallationMeta(installationId);
  const login = meta.account && "login" in meta.account
    ? meta.account.login
    : null;
  if (!login) {
    return NextResponse.json(
      { error: "installation has no account login" },
      { status: 400 }
    );
  }
  const fork = `${login}/caspian-scraper`;

  await adminDb.collection("users").doc(decoded.uid).set(
    {
      email: decoded.email ?? "",
      installation_id: installationId,
      fork,
      installed_at: new Date().toISOString(),
    },
    { merge: true }
  );

  return NextResponse.redirect(new URL("/", url));
}
