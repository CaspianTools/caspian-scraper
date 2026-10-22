/**
 * Company findings — the shape the app shows for a company record (from
 * find_websites.py to_finding, or toFinding() here for a database row) and the
 * filter rules for them. Pure, so the same rules run in the browser (search
 * results) and on the server (a database's paged list).
 */

/** One company, as the app shows it. */
export interface Finding {
  id: string;
  name: string;
  website: string;
  careers_url: string;
  description: string;
  countries: string[];
  industries: string[];
  types: string[];
  sources: string[];
  known: boolean;
  ats: "successfactors" | "jibe" | "unknown";
  checked: boolean;
  reachable: boolean | null;
  scrapable: boolean;
  hidden: boolean;
  /** Labels people gave it (absent in results saved before tags existed). */
  tags?: string[];
  /** 0–100 against the job's relevance rules (when it has any). */
  relevance?: number;
  /** A job result's change since the last run: new / changed / unchanged / gone. */
  change?: string;
}

export const tagsOf = (f: { tags?: string[] }): string[] => f.tags ?? [];
export const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const SOURCE_LABEL: Record<string, string> = {
  google_maps: "Google Maps",
  google: "Google",
  duckduckgo: "DuckDuckGo",
  wikidata: "Wikidata",
  osm: "OpenStreetMap",
  web: "Web",
  db: "In database",
};
export const ATS_LABEL: Record<string, string> = { successfactors: "SuccessFactors", jibe: "Jibe / iCIMS" };
const SUPPORTED_ATS = new Set(["successfactors", "jibe"]);

export type StatusKey = "scrapable" | "careers" | "unchecked" | "none" | "broken";
export const STATUS_LABEL: Record<StatusKey, string> = {
  scrapable: "Will be scraped",
  careers: "Careers page found",
  unchecked: "Not checked yet",
  none: "No careers page found",
  broken: "Careers page didn't open",
};
export function statusOf(f: Finding): StatusKey {
  if (f.scrapable) return "scrapable";
  if (!f.checked) return "unchecked";
  if (f.reachable === false) return "broken";
  return f.careers_url ? "careers" : "none";
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A company database record as a Finding (mirrors find_websites.to_finding). */
export function toFinding(rec: Record<string, unknown>): Finding {
  const ats = (typeof rec.ats === "string" ? rec.ats : "unknown") as Finding["ats"];
  const checked = Boolean(rec.checked_at);
  const reachable = checked ? (typeof rec.reachable === "boolean" ? rec.reachable : null) : null;
  const careers = typeof rec.careers_url === "string" ? rec.careers_url : "";
  return {
    id: String(rec.id),
    name: String(rec.name || rec.id),
    website: typeof rec.website === "string" ? rec.website : "",
    careers_url: careers,
    description: typeof rec.description === "string" ? rec.description : "",
    countries: strs(rec.countries),
    industries: strs(rec.industries),
    types: strs(rec.types),
    sources: strs(rec.sources),
    known: true,
    ats,
    checked,
    reachable,
    scrapable: Boolean(reachable) && SUPPORTED_ATS.has(ats) && Boolean(careers),
    hidden: Boolean(rec.hidden),
    tags: strs(rec.tags),
  };
}

// ---- filters ------------------------------------------------------------------

export const FACET_KEYS = ["change", "tag", "country", "category", "source", "status"] as const;
export type FacetKey = (typeof FACET_KEYS)[number];
export type Filters = Record<FacetKey, Set<string>>;
export const emptyFilters = (): Filters => ({
  change: new Set(), tag: new Set(), country: new Set(), category: new Set(), source: new Set(), status: new Set(),
});
/** Several tags picked: a company needs any one of them, or all of them. */
export type TagMode = "any" | "all";
export const UNTAGGED = "(untagged)";

export function facetValues(f: Finding, key: FacetKey): string[] {
  switch (key) {
    case "change":
      return [f.change ?? "(none)"];
    case "tag":
      return tagsOf(f).length ? tagsOf(f) : [UNTAGGED];
    case "country":
      return f.countries.length ? f.countries : ["(no country)"];
    case "category": {
      const v = [...f.types, ...f.industries].map((x) => x.trim()).filter(Boolean);
      return v.length ? Array.from(new Set(v.map((x) => x.charAt(0).toUpperCase() + x.slice(1)))) : ["(none)"];
    }
    case "source":
      return [...f.sources, ...(f.known ? ["db"] : [])];
    case "status":
      return [statusOf(f)];
  }
}
export const FACET_LABEL: Record<FacetKey, string> = {
  change: "Change", tag: "Tags", country: "Country", category: "Category", source: "Source", status: "Status",
};
const CHANGE_LABEL: Record<string, string> = { new: "New", changed: "Changed", unchanged: "Unchanged", gone: "Gone" };
export const optionLabel = (key: FacetKey, v: string) =>
  key === "source"
    ? (SOURCE_LABEL[v] ?? v)
    : key === "status"
      ? STATUS_LABEL[v as StatusKey]
      : key === "change"
        ? (CHANGE_LABEL[v] ?? v)
        : v;

export interface FilterState {
  filters: Filters;
  tagMode: TagMode;
  text: string;
}

/** Does a finding pass the filters (ignoring facet `skip`, for its counts)? */
export function matches(x: Finding, s: FilterState, skip?: FacetKey): boolean {
  for (const key of FACET_KEYS) {
    if (key === skip || s.filters[key].size === 0) continue;
    const vals = facetValues(x, key);
    if (key === "tag" && s.tagMode === "all") {
      if (![...s.filters.tag].every((v) => vals.includes(v))) return false;
    } else if (!vals.some((v) => s.filters[key].has(v))) return false;
  }
  const needle = s.text.trim().toLowerCase();
  if (!needle) return true;
  return [x.name, x.website, x.description, ...x.countries, ...x.types, ...x.industries, ...tagsOf(x)]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/** Option counts per facet, each counted within the other filters. */
export function facetCounts(rows: Finding[], s: FilterState): Record<FacetKey, [string, number][]> {
  const out = {} as Record<FacetKey, [string, number][]>;
  for (const key of FACET_KEYS) {
    const counts = new Map<string, number>();
    for (const x of rows) {
      if (!matches(x, s, key)) continue;
      for (const v of facetValues(x, key)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    out[key] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
  return out;
}

export type Sort = "relevance" | "name" | "sources";

export function sortFindings(rows: Finding[], sort: Sort): Finding[] {
  const out = [...rows];
  if (sort === "name") out.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === "sources") out.sort((a, b) => b.sources.length - a.sources.length);
  else out.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  return out;
}

/** Every tag in use (one spelling each), sorted. */
export function allTagsOf(rows: { tags?: string[] }[]): string[] {
  const m = new Map<string, string>();
  for (const x of rows) for (const t of tagsOf(x)) if (!m.has(t.toLowerCase())) m.set(t.toLowerCase(), t);
  return [...m.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Filters ⇄ URL query (for the server-paged database list). */
export function filtersToQuery(s: FilterState): URLSearchParams {
  const q = new URLSearchParams();
  if (s.text.trim()) q.set("q", s.text.trim());
  for (const key of FACET_KEYS) for (const v of s.filters[key]) q.append(`f.${key}`, v);
  if (s.tagMode === "all") q.set("tagMode", "all");
  return q;
}

export function filtersFromQuery(q: URLSearchParams): FilterState {
  const filters = emptyFilters();
  for (const key of FACET_KEYS) for (const v of q.getAll(`f.${key}`)) filters[key].add(v);
  return { filters, tagMode: q.get("tagMode") === "all" ? "all" : "any", text: q.get("q") ?? "" };
}
