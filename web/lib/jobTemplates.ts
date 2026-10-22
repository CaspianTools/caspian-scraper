/**
 * Jobs are generic: every job is its own scraping project — a description, a
 * record name, the fields its records have, sources of any engine (careers
 * pages, car classifieds, shops, any website, databases it reads from), the
 * databases it saves into, optional modules, relevance rules and AI. A
 * template only pre-fills a new job; everything stays editable.
 *
 * Results of every engine land in one store per job (job_results.py); the
 * job's pages are Results · Sources · Runs · Settings, plus Discover and
 * Compare when those modules are on.
 */

export const JOB_TEMPLATES = ["vacancies", "cars", "prices", "blank"] as const;
export type JobTemplate = (typeof JOB_TEMPLATES)[number];

export interface JobField {
  key: string;
  label: string;
}

export interface JobModules {
  /** Find websites (maps, web, directories) to add as sources. */
  discovery: boolean;
  /** Visit each result's own page (careers pages, listing details). */
  follow_up: boolean;
  /** Match the same item across sources (by product code or name). */
  compare: boolean;
}

export interface SaveTarget {
  database: string;
  only_tags?: string[];
  min_relevance?: number;
}

export interface ReadSpec {
  database: string;
  only_tags?: string[];
}

export interface RelevanceRules {
  /** Words that make a record relevant (any of them). */
  include: string[];
  /** Words that make it irrelevant. */
  exclude: string[];
  /** Below this score (0–100) a record is hidden in Results by default. */
  cutoff: number;
  /** Ask the AI about borderline records. */
  use_ai: boolean;
}

export interface JobSettings {
  template: JobTemplate;
  record_label: { singular: string; plural: string };
  fields: JobField[];
  modules: JobModules;
  saves_to: SaveTarget[];
  reads_from: ReadSpec[];
  relevance: RelevanceRules;
  use_ai: boolean;
  /** USD per run the AI may spend for this job (0 = no cap). */
  ai_spend_cap: number;
}

export interface TemplateInfo {
  label: string;
  blurb: string;
  example: string;
  /** Suggested description for the new job. */
  description: string;
  record_label: { singular: string; plural: string };
  fields: JobField[];
  modules: JobModules;
  /** Which kind of source to add first. */
  first_source: "careers" | "classifieds" | "shop" | "website";
}

const f = (key: string, label: string): JobField => ({ key, label });

export const TEMPLATE_INFO: Record<JobTemplate, TemplateInfo> = {
  vacancies: {
    label: "Vacancies",
    blurb: "Job openings from company careers pages and job boards.",
    example: "HSE jobs in the Gulf",
    description: "Vacancies from the careers pages of companies I pick.",
    record_label: { singular: "vacancy", plural: "vacancies" },
    fields: [f("title", "Title"), f("company", "Company"), f("location", "Location"), f("employment_type", "Type"), f("url", "Link")],
    modules: { discovery: true, follow_up: true, compare: false },
    first_source: "careers",
  },
  cars: {
    label: "Car listings",
    blurb: "Listings from classifieds sites (OpenSooq, Dubizzle, YallaMotor).",
    example: "Used Land Cruisers in Oman",
    description: "Car listings matching what I search for.",
    record_label: { singular: "listing", plural: "listings" },
    fields: [f("title", "Title"), f("price", "Price"), f("currency", "Currency"), f("year", "Year"), f("mileage", "Mileage"), f("location", "Location"), f("url", "Link")],
    modules: { discovery: false, follow_up: true, compare: false },
    first_source: "classifieds",
  },
  prices: {
    label: "Product prices",
    blurb: "The same products' prices across shops, matched side by side.",
    example: "Power tools prices",
    description: "Product prices from several shops.",
    record_label: { singular: "product", plural: "products" },
    fields: [f("title", "Product"), f("brand", "Brand"), f("price", "Price"), f("currency", "Currency"), f("shop", "Shop"), f("url", "Link")],
    modules: { discovery: false, follow_up: false, compare: true },
    first_source: "shop",
  },
  blank: {
    label: "Blank",
    blurb: "Anything else: describe a site and the fields to collect.",
    example: "Tender notices",
    description: "",
    record_label: { singular: "record", plural: "records" },
    fields: [f("title", "Title"), f("url", "Link")],
    modules: { discovery: false, follow_up: false, compare: false },
    first_source: "website",
  },
};

const OLD_KIND: Record<string, JobTemplate> = { vacancies: "vacancies", cars: "cars", prices: "prices", data: "blank" };

export function jobTemplate(v: unknown): JobTemplate {
  return (JOB_TEMPLATES as readonly string[]).includes(v as string) ? (v as JobTemplate) : "vacancies";
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A job doc's settings with every default filled in (jobs made before
 *  generic jobs: from their old `kind`). */
export function jobSettings(data: Record<string, unknown>): JobSettings {
  const template = data.template ? jobTemplate(data.template) : (OLD_KIND[String(data.kind ?? "")] ?? "vacancies");
  const t = TEMPLATE_INFO[template];
  const label = (data.record_label ?? {}) as { singular?: string; plural?: string };
  const mods = (data.modules ?? {}) as Partial<JobModules>;
  const rel = (data.relevance ?? {}) as Partial<RelevanceRules>;
  const fields = Array.isArray(data.fields)
    ? (data.fields as JobField[]).filter((x) => x && typeof x.key === "string" && x.key)
    : t.fields;
  return {
    template,
    record_label: { singular: label.singular || t.record_label.singular, plural: label.plural || t.record_label.plural },
    fields,
    modules: {
      discovery: typeof mods.discovery === "boolean" ? mods.discovery : t.modules.discovery,
      follow_up: typeof mods.follow_up === "boolean" ? mods.follow_up : t.modules.follow_up,
      compare: typeof mods.compare === "boolean" ? mods.compare : t.modules.compare,
    },
    saves_to: Array.isArray(data.saves_to) ? (data.saves_to as SaveTarget[]) : [],
    reads_from: Array.isArray(data.reads_from) ? (data.reads_from as ReadSpec[]) : [],
    relevance: {
      include: strs(rel.include),
      exclude: strs(rel.exclude),
      cutoff: typeof rel.cutoff === "number" ? rel.cutoff : 0,
      use_ai: rel.use_ai === true,
    },
    use_ai: data.use_ai === true,
    ai_spend_cap: typeof data.ai_spend_cap === "number" ? data.ai_spend_cap : 0,
  };
}

export interface JobNavItem {
  href: string;
  label: string;
  exact?: boolean;
}

/** A job's menu: Results · Sources · Runs · [Discover] · [Compare] · Settings. */
export function jobNav(id: string, s: Pick<JobSettings, "modules">): JobNavItem[] {
  const base = `/projects/${id}`;
  return [
    { href: base, label: "Results", exact: true },
    { href: `${base}/sources`, label: "Sources" },
    { href: `${base}/runs`, label: "Runs" },
    ...(s.modules.discovery ? [{ href: `${base}/discover`, label: "Discover" }] : []),
    ...(s.modules.compare ? [{ href: `${base}/compare`, label: "Compare" }] : []),
    { href: `${base}/settings`, label: "Settings" },
  ];
}

/** Where a new job goes first: add the kind of source its template suggests. */
export function jobFirstStep(id: string, template: JobTemplate): string {
  const base = `/projects/${id}`;
  switch (TEMPLATE_INFO[template].first_source) {
    case "careers":
      return `${base}/sources`;
    case "classifieds":
      return `${base}/cars/sources/new`;
    case "shop":
      return `${base}/prices/sources/new`;
    case "website":
      return `${base}/data`;
  }
}

/** "42 vacancies" / "1 listing". */
export function countLabel(n: number, s: Pick<JobSettings, "record_label">): string {
  return `${n.toLocaleString()} ${n === 1 ? s.record_label.singular : s.record_label.plural}`;
}
