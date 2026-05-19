import { z } from "zod";

// ---------------------------------------------------------------------------
// Firestore schemas. Single source of truth shared between the Next.js API
// routes (validation) and the Python scraper (informally — types are
// mirrored manually in scrape.py).
// ---------------------------------------------------------------------------

// Common shapes -------------------------------------------------------------

/**
 * The ATS / parser types the scraper supports. Adding a new value here
 * requires a corresponding entry in `PARSERS` in scrape.py.
 */
export const AtsType = z.enum(["successfactors", "jibe", "unknown"]);
export type AtsType = z.infer<typeof AtsType>;

export const SourceKind = z.enum(["employer", "agency", "feed"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const RunStatus = z.enum(["ok", "error", "auth_halt", "running"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const Verdict = z.enum(["ok", "errors", "zero_found", "no_new"]);
export type Verdict = z.infer<typeof Verdict>;

export const RunRequestStatus = z.enum([
  "pending",
  "running",
  "done",
  "failed",
]);
export type RunRequestStatus = z.infer<typeof RunRequestStatus>;

// /users/{uid} --------------------------------------------------------------

export const QuotaSchema = z.object({
  projects_max: z.number().int().min(0).default(3),
  sources_max_per_project: z.number().int().min(0).default(50),
  runs_per_day_max: z.number().int().min(0).default(50),
});
export type Quota = z.infer<typeof QuotaSchema>;

export const UserDocSchema = z.object({
  email: z.string().email().or(z.literal("")),
  name: z.string().default(""),
  picture: z.string().default(""),
  created_at: z.string().datetime().optional(),
  last_signed_in_at: z.string().datetime().optional(),
  quota: QuotaSchema.optional(),
});
export type UserDoc = z.infer<typeof UserDocSchema>;

// /projects/{projectId} -----------------------------------------------------

// Validate a cron expression. We require ≥1hr granularity (the minute
// field must be a single fixed number, not a wildcard). This caps
// runs/day at 24 even if the user crafts a malicious expression.
const CronExpressionSchema = z.string().refine(
  (s) => {
    const parts = s.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const minutes = parts[0];
    // Disallow * or */N in the minute field — forces ≤1 run per hour
    return /^\d{1,2}$/.test(minutes) && parseInt(minutes, 10) <= 59;
  },
  { message: "cron must have a fixed minute (e.g. '30 4 * * *'); ≥1hr granularity" }
);

export const ProjectCreateSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  schedule_cron: CronExpressionSchema,
  enabled: z.boolean().default(true),
  hse_keywords: z.array(z.string()).max(50).default([]),
});
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;

export const ProjectDocSchema = ProjectCreateSchema.extend({
  owner_uid: z.string().min(1),
  slug: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_run_at: z.string().datetime().nullable().default(null),
});
export type ProjectDoc = z.infer<typeof ProjectDocSchema>;

// Patch (PATCH /api/projects/[id])
export const ProjectPatchSchema = ProjectCreateSchema.partial();
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;

// /projects/{projectId}/sources/{sourceId} ----------------------------------

export const SourceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  kind: SourceKind.default("employer"),
  ats: AtsType,
  careers_url: z.string().url(),
  active: z.boolean().default(true),
  countries: z.array(z.string()).max(20).default([]),
  segment: z.string().max(200).default(""),
  headquarters: z.string().max(120).default(""),
  website: z.string().max(300).default(""),
  linkedin: z.string().max(300).default(""),
  notes: z.string().max(2000).default(""),
});
export type SourceCreate = z.infer<typeof SourceCreateSchema>;

export const SourceDocSchema = SourceCreateSchema.extend({
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_run_summary: z
    .object({
      ts: z.string().datetime(),
      found: z.number().int(),
      published: z.number().int(),
      errors_count: z.number().int(),
    })
    .nullable()
    .default(null),
});
export type SourceDoc = z.infer<typeof SourceDocSchema>;

export const SourcePatchSchema = SourceCreateSchema.partial();
export type SourcePatch = z.infer<typeof SourcePatchSchema>;

// /projects/{projectId}/destinations/{destId} -------------------------------

export const DestinationCreateSchema = z.object({
  name: z.string().min(1).max(80),
  base_url: z.string().url(),
  list_path: z.string().min(1).max(300),
  post_path: z.string().min(1).max(300),
  auth_header_name: z.string().min(1).max(80),
  // Format string for the auth header value. The literal token
  // "{secret}" (curly braces) is replaced with the resolved secret
  // value at scrape time. Examples:
  //   "{secret}"           bare key
  //   "Bearer {secret}"    bearer token
  //   "Basic {secret}"     pre-encoded basic
  auth_header_format: z.string().min(1).max(120).default("{secret}"),
  // Name of the secret in /projects/{id}/secrets to use for substitution.
  secret_ref: z.string().min(1).max(80),
  /** Field mapping for the role payload (free-form for now). */
  field_map: z.record(z.string(), z.string()).default({}),
  // Optional public URL pattern for an item, e.g.
  // "https://entirelysafe.com/vacancies/{slug}". The literal "{slug}"
  // token is substituted with the finding's doc ID at display time.
  // Used by the Findings tab to show an "open on destination" link.
  item_url_template: z.string().max(500).default(""),
});
export type DestinationCreate = z.infer<typeof DestinationCreateSchema>;

export const DestinationDocSchema = DestinationCreateSchema.extend({
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type DestinationDoc = z.infer<typeof DestinationDocSchema>;

export const DestinationPatchSchema = DestinationCreateSchema.partial();
export type DestinationPatch = z.infer<typeof DestinationPatchSchema>;

// /projects/{projectId}/secrets/{name} --------------------------------------

export const SecretWriteSchema = z.object({
  /** API key / token. Max 4 KB (also enforced in firestore.rules). */
  value: z.string().min(1).max(4096),
});
export type SecretWrite = z.infer<typeof SecretWriteSchema>;

// /projects/{projectId}/runs/{runId} ----------------------------------------

export const RunDocSchema = z.object({
  started_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable(),
  duration_seconds: z.number().int().min(0),
  status: RunStatus,
  trigger: z.string(),
  totals: z.object({
    checked: z.number().int().min(0),
    found: z.number().int().min(0),
    published: z.number().int().min(0),
    skipped_duplicate: z.number().int().min(0),
    errors_count: z.number().int().min(0),
  }),
  errors: z.array(z.string()).default([]),
});
export type RunDoc = z.infer<typeof RunDocSchema>;

// /projects/{projectId}/lessons/{auto-id} -----------------------------------

export const LessonDocSchema = z.object({
  run_id: z.string(),
  ts: z.string().datetime(),
  source_id: z.string(),
  source_name: z.string(),
  ats: AtsType,
  careers_url: z.string(),
  verdict: Verdict,
  found: z.number().int().min(0),
  published: z.number().int().min(0),
  skipped_duplicate: z.number().int().min(0),
  errors: z.array(z.string()).default([]),
});
export type LessonDoc = z.infer<typeof LessonDocSchema>;

// /projects/{projectId}/published/{slug} ------------------------------------

export const PublishedDocSchema = z.object({
  title: z.string(),
  employer: z.string(),
  location: z.string().default(""),
  country: z.string().default(""),
  ats: AtsType,
  published_at: z.string().datetime(),
  destination_id: z.string(),
  destination_response_id: z.string().default(""),
  source_id: z.string(),
  source_url: z.string(),
});
export type PublishedDoc = z.infer<typeof PublishedDocSchema>;

// /run_requests/{requestId} -------------------------------------------------

export const RunRequestCreateSchema = z.object({
  project_id: z.string().min(1),
});
export type RunRequestCreate = z.infer<typeof RunRequestCreateSchema>;

export const RunRequestDocSchema = z.object({
  project_id: z.string(),
  requested_by_uid: z.string(),
  status: RunRequestStatus,
  created_at: z.string().datetime(),
  picked_up_at: z.string().datetime().nullable().default(null),
  finished_at: z.string().datetime().nullable().default(null),
  run_id: z.string().default(""),
});
export type RunRequestDoc = z.infer<typeof RunRequestDocSchema>;
