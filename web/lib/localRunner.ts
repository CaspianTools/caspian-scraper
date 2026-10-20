import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Starts the Python scraper on this computer for "Run now" buttons — the
 * local replacement for the GitHub Actions workflow_dispatch the hosted app
 * used. Fire-and-forget: the process runs detached and writes its output to
 * local-data/logs/, and the scraper itself marks the /run_requests doc
 * running → done/failed, which the UI already polls.
 */

const REPO_ROOT = process.env.CASPIAN_REPO_ROOT ?? path.resolve(process.cwd(), "..");
const LOG_DIR = path.join(REPO_ROOT, "local-data", "logs");

export interface RunStartResult {
  attempted: boolean;
  ok?: boolean;
  error?: string;
  /** Repo-relative log file of the started run. */
  log?: string;
}

function pythonExe(): string {
  const win = path.join(REPO_ROOT, ".venv", "Scripts", "python.exe");
  const unix = path.join(REPO_ROOT, ".venv", "bin", "python");
  if (fs.existsSync(win)) return win;
  if (fs.existsSync(unix)) return unix;
  return process.platform === "win32" ? "python" : "python3";
}

function start(args: string[], env: Record<string, string>, label: string): RunStartResult {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = path.join(LOG_DIR, `${stamp}-${label}.log`);
    const fd = fs.openSync(logFile, "a");
    // Strip anything that would flip the scraper into Firestore mode.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, PYTHONUNBUFFERED: "1" };
    delete childEnv.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    delete childEnv.GOOGLE_APPLICATION_CREDENTIALS;
    const child = spawn(pythonExe(), args, {
      cwd: REPO_ROOT,
      env: childEnv,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
    child.on("error", () => {});
    child.unref();
    fs.closeSync(fd);
    return { attempted: true, ok: true, log: path.relative(REPO_ROOT, logFile) };
  } catch (e) {
    return { attempted: true, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One scrape of a single job / car / comparison / generic source. */
export function startScrape(opts: {
  projectId?: string;
  carSourceId?: string;
  comparisonSourceId?: string;
  genericSourceId?: string;
  /** When set, the scraper marks /run_requests/<id> running → done. */
  requestId?: string;
  dryRun?: boolean;
}): RunStartResult {
  const [key, id, label] = opts.projectId
    ? ["ONLY_PROJECT_ID", opts.projectId, "job"]
    : opts.carSourceId
      ? ["ONLY_CAR_SOURCE_ID", opts.carSourceId, "cars"]
      : opts.comparisonSourceId
        ? ["ONLY_COMPARISON_SOURCE_ID", opts.comparisonSourceId, "comparison"]
        : ["ONLY_GENERIC_SOURCE_ID", opts.genericSourceId ?? "", "generic"];
  if (!id) return { attempted: false, error: "nothing to run" };
  return start(
    ["scrape.py"],
    {
      [key]: id,
      ...(opts.requestId ? { REQUEST_ID: opts.requestId } : {}),
      DRY_RUN: opts.dryRun ? "true" : "false",
    },
    `${label}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`
  );
}

/** The AI scraper-config wizard runner (`python -m aiconfig --job <id>`). */
export function startAiconfig(jobId: string): RunStartResult {
  return start(["-m", "aiconfig", "--job", jobId], {}, `aiconfig-${jobId}`);
}

/**
 * Run a Python module to completion and parse its stdout as JSON — for
 * request/response helpers such as `python -m aiconfig.discover`. `input` is
 * written to stdin as JSON. Rejects on a non-zero exit, bad JSON or timeout.
 */
export function runPythonJson(
  args: string[],
  input: unknown,
  timeoutMs = 240_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
    delete childEnv.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    delete childEnv.GOOGLE_APPLICATION_CREDENTIALS;
    const child = spawn(pythonExe(), args, { cwd: REPO_ROOT, env: childEnv, windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err.trim().split("\n").slice(-3).join(" ") || `exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("the helper returned invalid JSON"));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
