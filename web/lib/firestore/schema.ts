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

// "partial" is written by the project/comparison/car/generic run writers in
// scrape.py when a run has some errors but also some successful extractions.
export const RunStatus = z.enum([
  "ok",
  "error",
  "auth_halt",
  "running",
  "partial",
]);
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

// Generic, any-schema extractor. The AI (or a human) defines an arbitrary
// {fieldName -> selectorExpr} map; the parser emits a flat record dict.
// Selector grammar (scrape.py:_eval_selector — split on the LAST "@"):
//   "h1.title"       -> inner_text of the first match
//   "sel@text"       -> inner_text (explicit)
//   "sel@html"       -> inner_html
//   "time@datetime"  -> value of the `datetime` attribute
// This is what powers /generic_sources; product configs never list it, so
// the comparison pipeline still only ever produces ProductListing.
const ExtractorFields = z.object({
  type: z.literal("fields"),
  fields: z
    .record(z.string(), z.string().min(1).max(500))
    .refine((o) => Object.keys(o).length > 0, "at least one field"),
  // Fields that must be non-empty for a record to count as a hit.
  // Defaults to every declared field when omitted.
  required_fields: z.array(z.string()).max(50).optional(),
});

export const ExtractorSchema = z.discriminatedUnion("type", [
  ExtractorJsonLd,
  ExtractorMicrodata,
  ExtractorOgMeta,
  ExtractorCss,
  ExtractorFields,
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
// Generic sources (any-schema surface, top-level, per-user)
//
// The AI-driven config feature (python -m aiconfig) writes these. Unlike the
// product-specific comparison surface, a generic source declares its OWN
// output field schema and can run one of two strategies:
//   mode:"config"   selector/field-map driven — runs ConfigurableProductParser
//                   with an ExtractionConfig (usually a `fields` extractor);
//                   goes live on the next cron tick, no code change.
//   mode:"adapter"  references a generated Python module in adapters/ by key;
//                   needs that module merged to `main` first (a code change),
//                   so adapter sources are created active:false until merge.
// See scrape.py:run_generic_source.
// ---------------------------------------------------------------------------

export const GenericFieldType = z.enum(["string", "number", "bool", "url"]);
export type GenericFieldType = z.infer<typeof GenericFieldType>;

export const GenericFieldSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/, "lowercase letters, digits, underscore only"),
  type: GenericFieldType.default("string"),
  required: z.boolean().default(false),
});
export type GenericFieldSpec = z.infer<typeof GenericFieldSpecSchema>;

const GenericStrategyConfig = z.object({
  mode: z.literal("config"),
  extraction: ExtractionConfigSchema,
});
const GenericStrategyAdapter = z.object({
  mode: z.literal("adapter"),
  adapter_key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/, "lowercase letters, digits, underscore only"),
  adapter_pr_url: z.string().url().optional(),
});
export const GenericStrategySchema = z.discriminatedUnion("mode", [
  GenericStrategyConfig,
  GenericStrategyAdapter,
]);
export type GenericStrategy = z.infer<typeof GenericStrategySchema>;

export const GenericSourceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  // Stable prefix for record uids (like comparison's retailer_id).
  source_key: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_-]+$/, "lowercase letters, digits, dash, underscore only"),
  record_schema: z.array(GenericFieldSpecSchema).min(1).max(40),
  strategy: GenericStrategySchema,
  start_urls: z.array(z.string().url()).min(1).max(20),
  schedule_cron: CronExpressionSchema,
  destination_id: z.string().max(200).optional(),
  active: z.boolean().default(true),
  notes: z.string().max(2000).default(""),
});
export type GenericSourceCreate = z.infer<typeof GenericSourceCreateSchema>;

export const GenericSourceDocSchema = GenericSourceCreateSchema.extend({
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
  // How the source was created — useful for the wizard/CLI audit trail.
  origin: z
    .object({
      via: z.enum(["cli", "wizard"]),
      config_job_id: z.string().optional(),
    })
    .optional(),
});
export type GenericSourceDoc = z.infer<typeof GenericSourceDocSchema>;

export const GenericSourcePatchSchema = GenericSourceCreateSchema.partial();
export type GenericSourcePatch = z.infer<typeof GenericSourcePatchSchema>;

// ----- /generic_records/{uid} ----------------------------------------------
// uid = "{source_key}:{sha1(url)[:32]}" — write-once, upsert on re-scrape.

export const GenericRecordDocSchema = z.object({
  uid: z.string(),
  owner_uid: z.string(),
  source_id: z.string(),
  source_key: z.string(),
  url: z.string().url(),
  data: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["new", "seen"]).default("new"),
  first_seen_at: z.string().datetime(),
  last_seen_at: z.string().datetime(),
});
export type GenericRecordDoc = z.infer<typeof GenericRecordDocSchema>;

// ----- /generic_runs/{rid} -------------------------------------------------

export const GenericRunDocSchema = z.object({
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
export type GenericRunDoc = z.infer<typeof GenericRunDocSchema>;

// ---------------------------------------------------------------------------
// Config jobs (AI scraper-config wizard, top-level, per-user)
//
// The web chat wizard writes /config_jobs/{id}; a GitHub Actions job running
// `python -m aiconfig --job <id>` reads it, drives the browser, and writes
// back its progress (turns/status/proposed_config/…); the wizard UI
// subscribes to the doc via client onSnapshot. On Approve the API route
// materialises `proposed_config` into a real /generic_sources/{sid} doc.
//
// Mirrored manually in the Python `aiconfig` package — keep the two in sync.
// ---------------------------------------------------------------------------

export const ConfigJobStatus = z.enum([
  "queued",
  "inspecting",
  "proposing_config",
  "previewing",
  "escalating_adapter",
  "generating_adapter",
  "validating",
  "proposed",
  "approved",
  "failed",
]);
export type ConfigJobStatus = z.infer<typeof ConfigJobStatus>;

// One line of the agent/user chat transcript.
export const ConfigJobTurnSchema = z.object({
  role: z.enum(["agent", "user", "system"]),
  text: z.string(),
  ts: z.string(),
});
export type ConfigJobTurn = z.infer<typeof ConfigJobTurnSchema>;

// Present only when the job escalated to the adapter path (generated Python
// module + PR). The source is created active:false until the PR merges.
export const ConfigJobAdapterSchema = z.object({
  key: z.string(),
  pr_url: z.string(),
  branch: z.string(),
  ast_gate: z.object({
    passed: z.boolean(),
    findings: z.array(z.string()).default([]),
  }),
  validation_report: z.string(),
});
export type ConfigJobAdapter = z.infer<typeof ConfigJobAdapterSchema>;

export const ConfigJobDiagnosticsSchema = z.object({
  pages_visited: z.number().int().min(0).optional(),
  extractor_hits: z.record(z.string(), z.number()).optional(),
  http_errors: z.record(z.string(), z.number()).optional(),
  escalation_reason: z.string().optional(),
});
export type ConfigJobDiagnostics = z.infer<typeof ConfigJobDiagnosticsSchema>;

// Owner-suppliable fields (what the wizard form POSTs).
export const ConfigJobCreateSchema = z.object({
  // Natural-language description of what to scrape.
  intent: z.string().min(1).max(4000),
  // Primary listing URL to inspect.
  url: z.string().url(),
  // Optional extra sample/detail URLs the agent may inspect.
  sample_urls: z.array(z.string().url()).max(20).default([]),
  // Optional shorthand schema, e.g. "title:string,deadline:string,amount:number".
  record_schema_hint: z.string().max(2000).default(""),
});
export type ConfigJobCreate = z.infer<typeof ConfigJobCreateSchema>;

export const ConfigJobDocSchema = ConfigJobCreateSchema.extend({
  owner_uid: z.string().min(1),
  status: ConfigJobStatus,
  // Which resolution path the agent took. null until it decides.
  path: z.enum(["config", "adapter"]).nullable().default(null),
  turns: z.array(ConfigJobTurnSchema).default([]),
  // Draft GenericSource the agent proposes; validated again on Approve.
  proposed_config: GenericSourceCreateSchema.nullable().default(null),
  sample_records: z.array(z.record(z.string(), z.unknown())).default([]),
  diagnostics: ConfigJobDiagnosticsSchema.default({}),
  adapter: ConfigJobAdapterSchema.nullable().default(null),
  created_at: z.string().datetime().nullable().default(null),
  updated_at: z.string().datetime().nullable().default(null),
  dispatched_at: z.string().datetime().nullable().default(null),
  finished_at: z.string().datetime().nullable().default(null),
  error: z.string().default(""),
});
export type ConfigJobDoc = z.infer<typeof ConfigJobDocSchema>;

// ---------------------------------------------------------------------------
// Per-user AI provider + key (/aiconfig_keys/{uid}) — write-only, admin-SDK
// only. Mirrored in aiconfig/providers (Python). The agent supports Anthropic,
// OpenAI, Google Gemini, or any OpenAI-compatible endpoint (base_url).
// ---------------------------------------------------------------------------

export const AiProvider = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "openai_compatible",
]);
export type AiProvider = z.infer<typeof AiProvider>;

export const AiKeyWriteSchema = z
  .object({
    provider: AiProvider.default("anthropic"),
    model: z.string().max(120).default(""),
    // Only used for openai_compatible (OpenRouter/Groq/DeepSeek/local/…).
    base_url: z.string().max(300).default(""),
    value: z.string().min(1).max(4096),
  })
  .refine(
    (d) => d.provider !== "openai_compatible" || d.base_url.trim().length > 0,
    { message: "an OpenAI-compatible provider needs a base URL", path: ["base_url"] }
  );
export type AiKeyWrite = z.infer<typeof AiKeyWriteSchema>;

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
  // Only keep listings first posted within the last N days (by creation
  // date). 1 = today's new listings only; 0 = no date filter.
  posted_within_days: z.number().int().min(0).max(30).default(1),
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
  generic_source_id: z.string().min(1).optional(),
});
export type RunRequestCreate = z.infer<typeof RunRequestCreateSchema>;

export const RunRequestDocSchema = z.object({
  project_id: z.string().default(""),
  comparison_source_id: z.string().default(""),
  car_source_id: z.string().default(""),
  generic_source_id: z.string().default(""),
  requested_by_uid: z.string(),
  status: RunRequestStatus,
  created_at: z.string().datetime(),
  picked_up_at: z.string().datetime().nullable().default(null),
  finished_at: z.string().datetime().nullable().default(null),
  run_id: z.string().default(""),
});
export type RunRequestDoc = z.infer<typeof RunRequestDocSchema>;
