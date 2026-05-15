import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Routes that are reachable without an authenticated Firebase session.
const PUBLIC_PATHS = [
  "/signin",
  "/api/auth/session-login",
  "/api/auth/session-logout",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

/**
 * Lightweight optimistic auth check. The full token verification happens
 * inside each Route Handler / Server Component via verifySessionCookie.
 * This proxy just shortcuts unauthenticated users to /signin so they
 * don't see a flash of the protected UI.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }
  const sessionCookie = req.cookies.get("__session")?.value;
  if (!sessionCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/signin";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Run on every route except the Next.js internals.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
