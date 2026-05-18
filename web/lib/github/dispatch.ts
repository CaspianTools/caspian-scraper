// Fire-and-forget GitHub Actions workflow_dispatch helper.
//
// Used to trigger the scrape-due workflow instantly when a user clicks
// "Run scrape now" in the web UI. The fallback path is still the cron
// tick every 15 min — this just shaves up to 15 min off ad-hoc latency.
//
// Authentication: a fine-grained Personal Access Token with
// Actions:read+write on the caspian-scraper repo, stored as the
// GH_DISPATCH_TOKEN secret in Firebase App Hosting. If unset, dispatch
// is silently skipped.

const REPO_OWNER = "CaspianTools";
const REPO_NAME = "caspian-scraper";
const WORKFLOW_FILE = "scrape-due.yml";

export interface DispatchResult {
  attempted: boolean;
  ok?: boolean;
  status?: number;
  error?: string;
}

/**
 * Trigger a workflow_dispatch on scrape-due.yml. Never throws — returns
 * a result the caller can log or surface. Always returns
 * `{ attempted: false }` when GH_DISPATCH_TOKEN is unset (queueing in
 * Firestore is enough; the cron will pick it up).
 */
export async function dispatchScrapeWorkflow(opts: {
  projectId: string;
  dryRun?: boolean;
  /** When set, the runner marks /run_requests/<id> done at finalise. */
  requestId?: string;
}): Promise<DispatchResult> {
  const token = process.env.GH_DISPATCH_TOKEN?.trim();
  if (!token) return { attempted: false };

  const url =
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}` +
    `/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `token ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          project_id: opts.projectId,
          dry_run: opts.dryRun ? "true" : "false",
          ...(opts.requestId ? { request_id: opts.requestId } : {}),
        },
      }),
    });
    // GitHub returns 204 No Content on success.
    if (res.status === 204) {
      return { attempted: true, ok: true, status: 204 };
    }
    const body = await res.text().catch(() => "");
    return {
      attempted: true,
      ok: false,
      status: res.status,
      error: body.slice(0, 200),
    };
  } catch (e) {
    return {
      attempted: true,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
