import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { AppHeader } from "@/components/AppHeader";

export const dynamic = "force-dynamic";

/**
 * Authed route-group layout. Every page under app/(app)/ inherits this:
 * a single auth check + the shared header. Nested layouts (e.g. the
 * project layout) can assume the user is signed in.
 *
 * The parentheses in "(app)" make this a Next.js route group — the
 * folder doesn't appear in URLs.
 */
export default async function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <AppHeader session={session} />
      {children}
    </div>
  );
}
