import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { AiConfigDashboard } from "@/components/aiconfig/AiConfigDashboard";

export const dynamic = "force-dynamic";

/**
 * Scrape any website, full width beside the app's SideRail. Two surfaces via a
 * client-side tab switcher: "New scrape" (the ConfigWizard — describe a site,
 * approve the proposed config into a generic source; Use AI is optional) and
 * "My sources". The AI provider key is in /settings. The page stays a server
 * component doing the auth guard; all interactivity lives in AiConfigDashboard.
 */
export default async function AiConfigPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  return (
    <div className="px-6 lg:px-8 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Scrape any website</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
          Describe what you want to scrape and a listing URL. The site is
          inspected, a scraper config is proposed and checked against the live
          page, and — once you approve — a source is created that scrapes on its
          own schedule. Turn on <strong>Use AI</strong>{" "}for sites the automatic
          setup can&apos;t handle.
        </p>
      </div>

      <AiConfigDashboard />
    </div>
  );
}
