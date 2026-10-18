import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  projectDoc,
  sourcesCol,
  destinationsCol,
  secretsCol,
} from "@/lib/firestore/collections";

async function checkProjectOwner(
  projectId: string,
  uid: string
): Promise<boolean> {
  const snap = await projectDoc(projectId).get();
  return snap.exists && snap.data()?.owner_uid === uid;
}

interface CheckResult {
  name: string;
  ok: boolean;
  status: number | null;
  message: string;
  ms: number;
}

interface SourceCheckResult extends CheckResult {
  careers_url: string;
  content_bytes: number | null;
}

interface DestinationCheckResult extends CheckResult {
  endpoint: string;
  secret_ref: string;
  secret_resolved: boolean;
}

const FETCH_TIMEOUT_MS = 10_000;

/** Lightweight fetch wrapper with a hard timeout. */
async function timedFetch(
  url: string,
  init: RequestInit = {}
): Promise<{ res: Response | null; error: string | null; ms: number }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CaspianScraper-DryRun/1.0)",
        ...(init.headers ?? {}),
      },
    });
    return { res, error: null, ms: Date.now() - start };
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.name === "AbortError"
          ? `timeout after ${FETCH_TIMEOUT_MS / 1000}s`
          : e.message
        : String(e);
    return { res: null, error: msg, ms: Date.now() - start };
  } finally {
    clearTimeout(t);
  }
}

/**
 * POST /api/projects/[id]/dry-run
 *
 * Lightweight wiring check — no actual scraping. Verifies:
 *   1. Each active source URL responds with 2xx
 *   2. Each destination's referenced secret resolves
 *   3. Each destination's list endpoint responds with 2xx given the
 *      auth header built from {secret}
 *
 * Returns a structured report. Synchronous (~5s for a typical project).
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/dry-run">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!(await checkProjectOwner(id, session.uid))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const [sourcesSnap, destsSnap, secretsSnap] = await Promise.all([
    sourcesCol(id).where("active", "==", true).get(),
    destinationsCol(id).get(),
    secretsCol(id).get(),
  ]);

  // Build a lookup of secret_name → value. Read at scrape/check time
  // server-side only; values never leave this request.
  const secretValues = new Map<string, string>();
  for (const d of secretsSnap.docs) {
    const v = d.data().value;
    if (typeof v === "string") secretValues.set(d.id, v);
  }

  // --- Check sources in parallel (capped at 10 concurrent) ----------------
  const sourceDocs = sourcesSnap.docs.slice(0, 100);
  const sourceChecks: SourceCheckResult[] = await Promise.all(
    sourceDocs.map(async (d): Promise<SourceCheckResult> => {
      const data = d.data();
      const name = String(data.name ?? d.id);
      const url = String(data.careers_url ?? "");
      if (!url) {
        return {
          name,
          careers_url: "",
          ok: false,
          status: null,
          ms: 0,
          message: "no careers_url",
          content_bytes: null,
        };
      }
      const { res, error, ms } = await timedFetch(url, { method: "GET" });
      if (!res) {
        return {
          name,
          careers_url: url,
          ok: false,
          status: null,
          ms,
          message: error ?? "fetch failed",
          content_bytes: null,
        };
      }
      let body = "";
      try {
        body = await res.text();
      } catch {
        /* ignore — only used for content_bytes */
      }
      return {
        name,
        careers_url: url,
        ok: res.ok,
        status: res.status,
        ms,
        message: res.ok
          ? "reachable"
          : `${res.status} ${res.statusText || ""}`.trim(),
        content_bytes: body ? body.length : null,
      };
    })
  );

  // --- Check destinations -----------------------------------------------
  const destChecks: DestinationCheckResult[] = await Promise.all(
    destsSnap.docs.map(async (d): Promise<DestinationCheckResult> => {
      const data = d.data();
      const name = String(data.name ?? d.id);
      const baseUrl = String(data.base_url ?? "");
      const listPath = String(data.list_path ?? "");
      const headerName = String(data.auth_header_name ?? "");
      const headerFormat = String(data.auth_header_format ?? "{secret}");
      const secretRef = String(data.secret_ref ?? "");
      const endpoint = baseUrl + listPath;

      const secretValue = secretValues.get(secretRef);
      if (!secretValue) {
        return {
          name,
          endpoint,
          secret_ref: secretRef,
          secret_resolved: false,
          ok: false,
          status: null,
          ms: 0,
          message: secretRef
            ? `secret '${secretRef}' is not set in this project`
            : "destination has no secret_ref configured",
        };
      }

      const headers: Record<string, string> = headerName
        ? { [headerName]: headerFormat.replace("{secret}", secretValue) }
        : {};

      const { res, error, ms } = await timedFetch(endpoint, {
        method: "GET",
        headers,
      });
      if (!res) {
        return {
          name,
          endpoint,
          secret_ref: secretRef,
          secret_resolved: true,
          ok: false,
          status: null,
          ms,
          message: error ?? "fetch failed",
        };
      }
      return {
        name,
        endpoint,
        secret_ref: secretRef,
        secret_resolved: true,
        ok: res.ok,
        status: res.status,
        ms,
        message: res.ok
          ? "auth + endpoint OK"
          : `${res.status} ${res.statusText || ""}`.trim(),
      };
    })
  );

  const sources_ok = sourceChecks.filter((c) => c.ok).length;
  const destinations_ok = destChecks.filter((c) => c.ok).length;
  const allOk =
    sources_ok === sourceChecks.length &&
    destinations_ok === destChecks.length;

  return NextResponse.json({
    ok: allOk,
    ran_at: new Date().toISOString(),
    summary: {
      sources_checked: sourceChecks.length,
      sources_ok,
      destinations_checked: destChecks.length,
      destinations_ok,
    },
    sources: sourceChecks,
    destinations: destChecks,
  });
}
