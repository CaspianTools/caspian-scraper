import { z } from "zod";

// ---------------------------------------------------------------------------
// Firestore schemas. Single source of truth shared between the Next.js API
// routes (validation) and the Python scraper (informally — types are
// mirrored manually in scrape.py).
// ---------------------------------------------------------------------------

// Common shapes -------------------------------------------------------------

/**
 * The ATS / parser types the per-project job scraper supports. Adding a
 * new value here requires a corresponding entry in `PARSERS` in scrape.py.
 *
 * Product extraction has moved to the top-level Comparison surface
 * (/comparison_sources/{sid}) — it uses its own `extraction` config
 * (see ExtractionConfigSchema below) and does NOT go through this enum.
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

// ---------------------------------------------------------------------------
// Comparison (top-level, per-user product-comparison surface)
// ---------------------------------------------------------------------------
//
// Lives entirely outside the /projects hierarchy. Every doc carries
// owner_uid; API routes filter by it. Phase A of plan v2 — see
// C:/Users/fuadj/.claude/plans/can-we-use-the-pure-narwhal.md
//
// /comparison_sources/{sid}      — operator-configured retailer source
// /comparison_listings/{lid}     — per-retailer scraped product record
// /comparison_canonicals/{cid}   — one row in the side-by-side compare table
// /comparison_runs/{rid}         — per-source-per-tick scrape run

// ----- ExtractionConfig (per-source strategy) ------------------------------

const LinkDiscoverySitemap = z.object({
  mode: z.literal("sitemap"),
  sitemap_url: z.string().url(),
  href_includes: z.string().max(120).optional(),
});

const LinkDiscoveryCss = z.object({
  mode: z.literal("css"),
  link_selector: z.string().min(1).max(500),
  href_includes: z.string().max(120).optional(),
  next_page_selector: z.string().max(500).optional(),
  max_pages: z.number().int().min(1).max(20).default(5),
});

const LinkDiscoveryCategorySeeds = z.object({
  mode: z.literal("category_seeds"),
  seed_urls: z.array(z.string().url()).min(1).max(50),
  link_selector: z.string().min(1).max(500),
  href_includes: z.string().max(120).optional(),
  max_pages: z.number().int().min(1).max(20).default(3),
});

export const LinkDiscoverySchema = z.discriminatedUnion("mode", [
  LinkDiscoverySitemap,
  LinkDiscoveryCss,
  LinkDiscoveryCategorySeeds,
]);
export type LinkDiscovery = z.infer<typeof LinkDiscoverySchema>;

const ExtractorJsonLd = z.object({ type: z.literal("jsonld_product") });
const ExtractorMicrodata = z.object({ type: z.literal("microdata") });
const ExtractorOgMeta = z.object({ type: z.literal("og_meta") });
const ExtractorCss = z.object({
  type: z.literal("css"),
  name_selector: z.string().min(1).max(500),
  price_selector: z.string().min(1).max(500),
  currency: z.string().length(3),
  brand_selector: z.string().max(500).optional(),
  size_selector: z.string().max(500).optional(),
  image_selector: z.string().max(500).optional(),
  gtin_selector: z.string().max(500).optional(),
  in_stock_selector: z.string().max(500).optional(),
  in_stock_text_match: z.string().max(120).optional(),
});

export const ExtractorSchema = z.discriminatedUnion("type", [
  ExtractorJsonLd,
  ExtractorMicrodata,
  ExtractorOgMeta,
  ExtractorCss,
]);
export type Extractor = z.infer<typeof ExtractorSchema>;

export const ExtractionConfigSchema = z.object({
  link_discovery: LinkDiscoverySchema,
  extractors: z.array(ExtractorSchema).min(1).max(6),
  user_agent: z.string().max(500).optional(),
  wait_for_selector: z.string().max(500).optional(),
  request_delay_ms: z.number().int().min(0).max(60000).default(1500),
  respect_robots: z.boolean().default(true),
});
export type ExtractionConfig = z.infer<typeof ExtractionConfigSchema>;

// ----- /comparison_sources/{sid} -------------------------------------------

export const ComparisonSourceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  // Stable slug used as the retailer key in listings + comparison columns
  retailer_id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_-]+$/, "lowercase letters, digits, dash, underscore only"),
  home_url: z.string().url(),
  start_urls: z.array(z.string().url()).min(1).max(20),
  extraction: ExtractionConfigSchema,
  schedule_cron: CronExpressionSchema,
  active: z.boolean().default(true),
  notes: z.string().max(2000).default(""),
});
export type ComparisonSourceCreate = z.infer<
  typeof ComparisonSourceCreateSchema
>;

export const ComparisonSourceDocSchema = ComparisonSourceCreateSchema.extend({
  owner_uid: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_run_at: z.string().datetime().nullable().default(null),
  last_run_summary: z
    .object({
      ts: z.string().datetime(),
      found: z.number().int(),
      extracted: z.number().int(),
      errors_count: z.number().int(),
    })
    .nullable()
    .default(null),
});
export type ComparisonSourceDoc = z.infer<typeof ComparisonSourceDocSchema>;

export const ComparisonSourcePatchSchema =
  ComparisonSourceCreateSchema.partial();
export type ComparisonSourcePatch = z.infer<typeof ComparisonSourcePatchSchema>;

// ----- /comparison_listings/{lid} ------------------------------------------
// lid = sha1(retailer_id + "|" + product_url) — write-once, stable

export const ComparisonListingDocSchema = z.object({
  owner_uid: z.string(),
  source_id: z.string(),
  retailer_id: z.string(),
  retailer_name: z.string().default(""),
  product_url: z.string().url(),
  name: z.string(),
  brand: z.string().default(""),
  gtin: z.string().nullable().default(null),
  size_value: z.number().nullable().default(null),
  size_unit: z.string().default(""),
  price_value: z.number(),
  price_currency: z.string().length(3),
  unit_price_value: z.number().nullable().default(null),
  unit_price_basis: z.string().default(""),
  in_stock: z.boolean().nullable().default(null),
  image_url: z.string().default(""),
  canonical_id: z.string().nullable().default(null),
  status: z
    .enum(["new", "linked", "stale", "failed_extract"])
    .default("new"),
  first_seen_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
  raw_blob: z.unknown().optional(),
});
export type ComparisonListingDoc = z.infer<typeof ComparisonListingDocSchema>;

// ----- /comparison_canonicals/{cid} ----------------------------------------
// cid = gtin when known, else c-<base36-time>+<6-rand>

export const ComparisonCanonicalDocSchema = z.object({
  owner_uid: z.string(),
  display_name: z.string(),
  brand: z.string().default(""),
  size_value: z.number().nullable().default(null),
  size_unit: z.string().default(""),
  gtin: z.string().nullable().default(null),
  listing_ids: z.array(z.string()).default([]),
  retailer_ids: z.array(z.string()).default([]),
  created_at: z.string().datetime(),
  confirmed_by: z.string().default(""),
});
export type ComparisonCanonicalDoc = z.infer<
  typeof ComparisonCanonicalDocSchema
>;

// ----- /comparison_runs/{rid} ----------------------------------------------

export const ComparisonRunDocSchema = z.object({
  owner_uid: z.string(),
  source_id: z.string().nullable().default(null),
  source_name: z.string().default(""),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable(),
  duration_seconds: z.number().int().min(0),
  status: RunStatus,
  trigger: z.string(),
  dry_run: z.boolean().default(false),
  totals: z.object({
    checked: z.number().int().min(0),
    found: z.number().int().min(0),
    extracted: z.number().int().min(0),
    skipped_duplicate: z.number().int().min(0),
    errors_count: z.number().int().min(0),
  }),
  errors: z.array(z.string()).default([]),
  diagnostics: z
    .object({
      links_discovered: z.number().int().min(0).default(0),
      pages_visited: z.number().int().min(0).default(0),
      extractor_hits: z.record(z.string(), z.number()).default({}),
      http_errors: z.record(z.string(), z.number()).default({}),
    })
    .optional(),
});
export type ComparisonRunDoc = z.infer<typeof ComparisonRunDocSchema>;

// ---------------------------------------------------------------------------
// Cars (car-classifieds surface, top-level, per-user)
//
// Reuses the standalone `classifieds/` scraper as the extraction engine
// (scrape.py:run_car_source). Unlike comparison, a car source needs NO
// extraction config — the site adapter (OpenSooq/…) is purpose-built.
// ---------------------------------------------------------------------------

export const CarSiteKey = z.enum(["opensooq", "dubizzle", "yallamotor"]);
export type CarSite = z.infer<typeof CarSiteKey>;

// ----- /car_sources/{sid} --------------------------------------------------

export const CarSourceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  site: CarSiteKey,
  country: z.string().length(2).default("om"),
  city: z.string().max(80).default(""),
  category: z.string().max(40).default("cars"),
  query: z.string().max(200).default(""),
  max_listings: z.number().int().min(1).max(200).default(50),
  with_details: z.boolean().default(true),
  schedule_cron: CronExpressionSchema,
  active: z.boolean().default(true),
  notes: z.string().max(2000).default(""),
});
export type CarSourceCreate = z.infer<typeof CarSourceCreateSchema>;

export const CarSourceDocSchema = CarSourceCreateSchema.extend({
  owner_uid: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_run_at: z.string().datetime().nullable().default(null),
  last_run_summary: z
    .object({
      ts: z.string().datetime(),
      found: z.number().int(),
      new: z.number().int(),
      errors_count: z.number().int(),
    })
    .nullable()
    .default(null),
});
export type CarSourceDoc = z.infer<typeof CarSourceDocSchema>;

export const CarSourcePatchSchema = CarSourceCreateSchema.partial();
export type CarSourcePatch = z.infer<typeof CarSourcePatchSchema>;

// ----- /car_listings/{uid} -------------------------------------------------
// uid = "<site>:<listing_id>" (classifieds.models.Listing.uid) — write-once

export const CarSellerSchema = z.object({
  name: z.string().default(""),
  profile_url: z.string().default(""),
  phone: z.string().default(""),
  member_since: z.string().default(""),
});

export const CarListingDocSchema = z.object({
  uid: z.string(),
  site: z.string(),
  listing_id: z.string().default(""),
  url: z.string(),
  title: z.string().default(""),
  description: z.string().default(""),
  price_raw: z.string().default(""),
  price_value: z.number().nullable().default(null),
  currency: z.string().default(""),
  images: z.array(z.string()).default([]),
  seller: CarSellerSchema.default({
    name: "",
    profile_url: "",
    phone: "",
    member_since: "",
  }),
  location: z.string().default(""),
  posted_at: z.string().default(""),
  // Free-form car facts (make/model/year/km/…) — key/value strings.
  attributes: z.record(z.string(), z.string()).default({}),
  scraped_at: z.string().default(""),
  extras: z.record(z.string(), z.unknown()).default({}),
  owner_uid: z.string(),
  source_id: z.string(),
  status: z.enum(["new", "seen"]).default("new"),
  first_seen_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
});
export type CarListingDoc = z.infer<typeof CarListingDocSchema>;

// ----- /car_runs/{rid} -----------------------------------------------------

export const CarRunDocSchema = z.object({
  owner_uid: z.string(),
  source_id: z.string().nullable().default(null),
  source_name: z.string().default(""),
  site: z.string().default(""),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable(),
  duration_seconds: z.number().int().min(0),
  status: RunStatus,
  trigger: z.string(),
  dry_run: z.boolean().default(false),
  totals: z.object({
    found: z.number().int().min(0),
    new: z.number().int().min(0),
    updated: z.number().int().min(0),
    errors_count: z.number().int().min(0),
  }),
  errors: z.array(z.string()).default([]),
  overrun: z.boolean().default(false),
});
export type CarRunDoc = z.infer<typeof CarRunDocSchema>;

// ----- API payloads --------------------------------------------------------

// POST /api/comparison/sources/test
export const ComparisonTestSchema = z.object({
  extraction: ExtractionConfigSchema,
  sample_url: z.string().url().optional(),
  start_urls: z.array(z.string().url()).max(20).optional(),
});
export type ComparisonTest = z.infer<typeof ComparisonTestSchema>;

// POST /api/comparison/listings/[lid]/match
export const ComparisonListingMatchSchema = z.union([
  z.object({ canonical_id: z.string().min(1) }),
  z.object({
    create_canonical: z.object({
      display_name: z.string().min(1).max(200),
      brand: z.string().max(120).default(""),
      size_value: z.number().nullable().default(null),
      size_unit: z.string().max(20).default(""),
    }),
  }),
]);
export type ComparisonListingMatch = z.infer<
  typeof ComparisonListingMatchSchema
>;

// /run_requests/{requestId} -------------------------------------------------

// /run_requests/{requestId} — one is built either for a project run or a
// comparison-source run. Exactly one of project_id / comparison_source_id
// must be set (refined at the API-route level since both validation paths
// flow through the same collection).

export const RunRequestCreateSchema = z.object({
  project_id: z.string().min(1).optional(),
  comparison_source_id: z.string().min(1).optional(),
  car_source_id: z.string().min(1).optional(),
});
export type RunRequestCreate = z.infer<typeof RunRequestCreateSchema>;

export const RunRequestDocSchema = z.object({
  project_id: z.string().default(""),
  comparison_source_id: z.string().default(""),
  car_source_id: z.string().default(""),
  requested_by_uid: z.string(),
  status: RunRequestStatus,
  created_at: z.string().datetime(),
  picked_up_at: z.string().datetime().nullable().default(null),
  finished_at: z.string().datetime().nullable().default(null),
  run_id: z.string().default(""),
});
export type RunRequestDoc = z.infer<typeof RunRequestDocSchema>;
