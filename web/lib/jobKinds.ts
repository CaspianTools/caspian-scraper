/**
 * Job types. Every job collects one kind of thing, chosen when it's created;
 * the job's pages, menu and wording follow it ("Vacancies" in a vacancy job,
 * "Cars" in a car job). The engines differ underneath:
 *
 *   vacancies  the job's own sources + shared resources → findings     (projects/{id}/…)
 *   cars       car_sources with project_id → car_listings, car_runs
 *   prices     comparison_sources with project_id → comparison_listings, comparison_runs
 *   data       generic_sources with project_id → generic_records, generic_runs
 *
 * A job without a `kind` is a vacancy job (jobs made before types existed).
 */

export const JOB_KINDS = ["vacancies", "cars", "prices", "data"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface JobKindInfo {
  /** Shown on the job's badge and in the type picker. */
  label: string;
  /** What the job collects, plural — the results page's name. */
  items: string;
  /** One line for the type picker. */
  blurb: string;
  /** Placeholder for the job's name. */
  example: string;
}

export const JOB_KIND_INFO: Record<JobKind, JobKindInfo> = {
  vacancies: {
    label: "Vacancies",
    items: "Vacancies",
    blurb: "Job openings from company careers pages and job boards.",
    example: "HSE Jobs Middle East",
  },
  cars: {
    label: "Cars",
    items: "Cars",
    blurb: "Car listings from classifieds sites (OpenSooq, Dubizzle, YallaMotor).",
    example: "Used SUVs in Oman",
  },
  prices: {
    label: "Prices",
    items: "Products",
    blurb: "Product prices from several shops, matched side by side.",
    example: "Power tools prices",
  },
  data: {
    label: "Website data",
    items: "Records",
    blurb: "Anything else: describe a site and what to collect from it.",
    example: "Tender notices",
  },
};

export function jobKind(v: unknown): JobKind {
  return (JOB_KINDS as readonly string[]).includes(v as string) ? (v as JobKind) : "vacancies";
}

export interface JobNavItem {
  href: string;
  label: string;
  exact?: boolean;
}

/** Path of a job's main results page — where a job opens. */
export function jobHome(id: string, kind: JobKind): string {
  const base = `/projects/${id}`;
  switch (kind) {
    case "vacancies":
      return base;
    case "cars":
      return `${base}/cars`;
    case "prices":
      return `${base}/prices`;
    case "data":
      return `${base}/data`;
  }
}

/** Where to add the first website(s) right after creating a job. */
export function jobFirstStep(id: string, kind: JobKind): string {
  const base = `/projects/${id}`;
  switch (kind) {
    case "vacancies":
      return base;
    case "cars":
      return `${base}/cars/sources/new`;
    case "prices":
      return `${base}/prices/sources/new`;
    case "data":
      return `${base}/data`;
  }
}

/** The job sidebar's menu, by type. */
export function jobNav(id: string, kind: JobKind): JobNavItem[] {
  const base = `/projects/${id}`;
  const settings = { href: `${base}/settings`, label: "Settings" };
  switch (kind) {
    case "vacancies":
      return [
        { href: base, label: "Overview", exact: true },
        { href: `${base}/findings`, label: "Vacancies" },
        { href: `${base}/sources`, label: "Sources" },
        { href: `${base}/runs`, label: "Runs" },
        { href: `${base}/lessons`, label: "Lessons" },
        settings,
      ];
    case "cars":
      return [
        { href: `${base}/cars`, label: "Cars", exact: true },
        { href: `${base}/cars/sources`, label: "Sources" },
        { href: `${base}/cars/runs`, label: "Runs" },
        settings,
      ];
    case "prices":
      return [
        { href: `${base}/prices`, label: "Products", exact: true },
        { href: `${base}/prices/compare`, label: "Compare" },
        { href: `${base}/prices/sources`, label: "Sources" },
        { href: `${base}/prices/runs`, label: "Runs" },
        settings,
      ];
    case "data":
      return [
        { href: `${base}/data`, label: "Sources & records", exact: true },
        settings,
      ];
  }
}
