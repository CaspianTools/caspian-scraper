import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { AiConfigDashboard } from "@/components/aiconfig/AiConfigDashboard";

export const dynamic = "force-dynamic";

/**
 * AI scraper-config hub. Sits inside the authed (app)/layout.tsx (the global
 * AppHeader is rendered above). Three surfaces via a client-side tab switcher:
 * "New scrape" (the ConfigWizard — describe a site, approve the agent's
 * proposed config into a generic source), "My sources" (manage the sources
 * you've created), and "API key" (the write-only Anthropic key the setup agent
 * uses). The page stays a server component doing the auth guard; all
 * interactivity lives in AiConfigDashboard.
 */
export default async function AiConfigPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">AI Setup</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          Describe what you want to scrape and a listing URL. The agent
          inspects the site, proposes an extraction config, and — once you
          approve — creates a generic source that scrapes on its own schedule.
        </p>
      </div>

      <AiConfigDashboard />
    </div>
  );
}
