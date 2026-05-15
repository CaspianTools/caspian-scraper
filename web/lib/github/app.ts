import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";

// In-process cache of installation tokens. Tokens are valid for ~1 hour;
// we refresh at the 50-minute mark to be safe.
type Cached = { token: string; expiresAt: number; octokit: Octokit };
const tokenCache = new Map<number, Cached>();

const REFRESH_BEFORE_MS = 10 * 60 * 1000; // refresh 10min before expiry

function readPrivateKey(): string {
  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!raw) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is not set. Paste the contents of the PEM " +
        "file from your GitHub App settings (newlines escaped as \\n)."
    );
  }
  return raw.replace(/\\n/g, "\n");
}

function readAppId(): number {
  const id = process.env.GITHUB_APP_ID;
  if (!id) throw new Error("GITHUB_APP_ID is not set.");
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`GITHUB_APP_ID is not a positive integer: ${id}`);
  }
  return n;
}

let _app: App | null = null;
function githubApp(): App {
  if (_app) return _app;
  _app = new App({
    appId: readAppId(),
    privateKey: readPrivateKey(),
  });
  return _app;
}

/**
 * Look up the installation for a given account login. Used during the
 * auth handshake when we get an installation_id back from the install
 * callback and want to confirm which account/repo it points at.
 */
export async function getInstallationMeta(installationId: number) {
  const { octokit: appOctokit } = githubApp();
  const { data } = await appOctokit.request(
    "GET /app/installations/{installation_id}",
    { installation_id: installationId }
  );
  return data;
}

/**
 * Mint or reuse an installation access token for `installationId` and
 * return an Octokit instance bound to it.
 */
export async function octokitForInstallation(
  installationId: number
): Promise<Octokit> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > REFRESH_BEFORE_MS) {
    return cached.octokit;
  }
  const app = githubApp();
  const octokit = (await app.getInstallationOctokit(
    installationId
  )) as unknown as Octokit;
  // Octokit doesn't expose the token's expiry directly here; we cache for
  // 50 minutes which is safely under GitHub's 60-min lifetime.
  tokenCache.set(installationId, {
    token: "managed-by-octokit",
    expiresAt: Date.now() + 50 * 60 * 1000,
    octokit,
  });
  return octokit;
}

/**
 * Convenience: read a file's content + sha from the installation's repo.
 * Returns null on 404 instead of throwing.
 */
export async function getFile(
  installationId: number,
  owner: string,
  repo: string,
  path: string,
  ref = "main"
): Promise<{ content: string; sha: string } | null> {
  const octokit = await octokitForInstallation(installationId);
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
 * Write a file with SHA-CAS. Throws on stale-SHA (caller should catch and
 * surface a 409 to the client).
 */
export async function putFile(
  installationId: number,
  owner: string,
  repo: string,
  path: string,
  content: string,
  expectedSha: string,
  message: string
) {
  const octokit = await octokitForInstallation(installationId);
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
