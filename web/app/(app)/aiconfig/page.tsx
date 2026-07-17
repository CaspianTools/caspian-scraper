import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { ConfigWizard } from "@/components/ConfigWizard";

export const dynamic = "force-dynamic";

/**
 * AI scraper-config wizard. Sits inside the authed (app)/layout.tsx (the
 * global AppHeader is rendered above). The user describes what to scrape;
 * the Python `aiconfig` agent inspects the site and proposes a generic
 * source config, which the user can approve into /generic_sources.
 */
export default async function AiConfigPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          AI config wizard
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          Describe what you want to scrape and a listing URL. The agent
          inspects the site, proposes an extraction config, and — once you
          approve — creates a generic source that scrapes on its own schedule.
        </p>
      </div>

      <ConfigWizard />
    </div>
  );
}
