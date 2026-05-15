import { Octokit } from "@octokit/rest";

/**
 * Build an Octokit instance authed with the user's GitHub OAuth access
 * token (captured from Firebase Auth's GitHub provider at sign-in).
 *
 * The web app uses these per-user tokens for every GitHub call — no
 * GitHub App, no installation tokens. The token's permissions are
 * whatever scopes we asked for at sign-in (repo + workflow).
 */
export function octokitForUser(ghToken: string): Octokit {
  if (!ghToken) {
    throw new Error("octokitForUser called without a GitHub access token");
  }
  return new Octokit({ auth: ghToken });
}

/**
 * Read a file's content + sha from a repo. Returns null on 404.
 */
export async function getFile(
  ghToken: string,
  owner: string,
  repo: string,
  path: string,
  ref = "main"
): Promise<{ content: string; sha: string } | null> {
  const octokit = octokitForUser(ghToken);
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== "file") return null;
    const decoded = Buffer.from(data.content, "base64").toString("utf-8");
    return { content: decoded, sha: data.sha };
  } catch (e) {
    const err = e as { status?: number };
    if (err.status === 404) return null;
    throw e;
  }
}

/**
 * Write a file with SHA-CAS. The caller should catch 422 (stale SHA)
 * and surface a 409 to the client so the UI can show a reconciliation
 * modal.
 */
export async function putFile(
  ghToken: string,
  owner: string,
  repo: string,
  path: string,
  content: string,
  expectedSha: string,
  message: string
) {
  const octokit = octokitForUser(ghToken);
  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    sha: expectedSha,
    branch: "main",
  });
  return { newSha: data.content?.sha ?? "", commitSha: data.commit.sha ?? "" };
}

/**
 * Find the signed-in user's fork of CaspianTools/caspian-scraper.
 * Returns the full repo name (`<login>/caspian-scraper`) or null if no
 * fork exists.
 */
export async function findUserFork(
  ghToken: string,
  upstreamRepo: string
): Promise<{ owner: string; repo: string; full_name: string } | null> {
  const octokit = octokitForUser(ghToken);
  const { data: user } = await octokit.users.getAuthenticated();
  try {
    const { data } = await octokit.repos.get({
      owner: user.login,
      repo: upstreamRepo,
    });
    return {
      owner: user.login,
      repo: upstreamRepo,
      full_name: data.full_name,
    };
  } catch (e) {
    const err = e as { status?: number };
    if (err.status === 404) return null;
    throw e;
  }
}
