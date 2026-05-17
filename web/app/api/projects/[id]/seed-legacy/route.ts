import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionFromBearer } from "@/lib/auth/session";
import { projectDoc, sourcesCol } from "@/lib/firestore/collections";

interface LegacyEmployer {
  name?: string;
  kind?: string;
  ats?: string;
  careers_url?: string;
  active?: boolean;
  countries?: unknown;
  headquarters?: string;
  segment?: string;
  website?: string;
  linkedin?: string;
  notes?: string;
}

const ALLOWED_ATS = new Set(["successfactors", "jibe", "unknown"]);
const ALLOWED_KIND = new Set(["employer", "agency", "feed"]);
const FIRESTORE_BATCH_MAX = 400; // Hard limit is 500; leave headroom.

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * POST /api/projects/[id]/seed-legacy
 *
 * One-off helper: bulk-import the legacy employers.json from the repo
 * root into this project's sources collection. Idempotent — skips
 * entries whose careers_url already exists in the project.
 *
 * Bypasses the per-project source quota (this is a one-time admin
 * operation). Returns counts of added / skipped / invalid.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/seed-legacy">
) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await ctx.params;

  const psnap = await projectDoc(id).get();
  if (!psnap.exists || psnap.data()?.owner_uid !== session.uid) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Read the legacy file from the repo root. process.cwd() during
  // `next dev` and on App Hosting is the web/ directory, so go up one.
  const repoRoot = path.resolve(process.cwd(), "..");
  const employersPath = path.join(repoRoot, "employers.json");
  let raw: string;
  try {
    raw = await fs.readFile(employersPath, "utf-8");
  } catch {
    return NextResponse.json(
      {
        error:
          "employers.json not found at repo root. Has it been archived?",
      },
      { status: 404 }
    );
  }

  let legacy: LegacyEmployer[];
  try {
    legacy = JSON.parse(raw);
    if (!Array.isArray(legacy)) throw new Error("not an array");
  } catch (e) {
    return NextResponse.json(
      { error: `employers.json not parseable: ${(e as Error).message}` },
      { status: 500 }
    );
  }

  // Build the set of careers_urls already in the project so we don't
  // duplicate entries if the button is clicked twice.
  const existing = await sourcesCol(id).select("careers_url").get();
  const existingUrls = new Set<string>(
    existing.docs
      .map((d) => (d.data().careers_url as string) || "")
      .filter(Boolean)
  );

  let added = 0;
  let skippedDuplicate = 0;
  let skippedInvalid = 0;

  // Stage entries into one or more batched commits.
  let batch = adminDb.batch();
  let batchCount = 0;

  async function flush() {
    if (batchCount === 0) return;
    await batch.commit();
    batch = adminDb.batch();
    batchCount = 0;
  }

  for (const e of legacy) {
    const careersUrl = String(e.careers_url ?? "").trim();
    if (!careersUrl || !isValidUrl(careersUrl)) {
      skippedInvalid++;
      continue;
    }
    if (existingUrls.has(careersUrl)) {
      skippedDuplicate++;
      continue;
    }

    const ats = ALLOWED_ATS.has(String(e.ats)) ? String(e.ats) : "unknown";
    const kind = ALLOWED_KIND.has(String(e.kind))
      ? String(e.kind)
      : "employer";
    const countries = Array.isArray(e.countries)
      ? (e.countries.filter((c) => typeof c === "string") as string[])
      : [];

    const ref = sourcesCol(id).doc();
    batch.set(ref, {
      name: String(e.name ?? "").trim() || "(unnamed)",
      kind,
      ats,
      careers_url: careersUrl,
      active: Boolean(e.active),
      countries,
      segment: String(e.segment ?? ""),
      headquarters: String(e.headquarters ?? ""),
      website: String(e.website ?? ""),
      linkedin: String(e.linkedin ?? ""),
      notes: String(e.notes ?? ""),
      last_run_summary: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });
    existingUrls.add(careersUrl);
    added++;
    batchCount++;

    if (batchCount >= FIRESTORE_BATCH_MAX) {
      await flush();
    }
  }
  await flush();

  return NextResponse.json({
    ok: true,
    total: legacy.length,
    added,
    skipped_duplicate: skippedDuplicate,
    skipped_invalid: skippedInvalid,
  });
}
