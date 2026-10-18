// Shared types + defaults for the comparison-source form. NOT marked
// "use client" so server components (the create + edit pages) can call
// the factory function without hitting the client/server boundary.

export interface ExtractionConfigInput {
  link_discovery:
    | {
        mode: "css";
        link_selector: string;
        href_includes?: string;
        next_page_selector?: string;
        max_pages?: number;
      }
    | {
        mode: "sitemap";
        sitemap_url: string;
        href_includes?: string;
      }
    | {
        mode: "category_seeds";
        seed_urls: string[];
        link_selector: string;
        href_includes?: string;
        max_pages?: number;
      };
  extractors: Array<
    | { type: "jsonld_product" }
    | { type: "microdata" }
    | { type: "og_meta" }
    | {
        type: "css";
        name_selector: string;
        price_selector: string;
        currency: string;
        brand_selector?: string;
        size_selector?: string;
        image_selector?: string;
        gtin_selector?: string;
        in_stock_selector?: string;
        in_stock_text_match?: string;
      }
  >;
  user_agent?: string;
  wait_for_selector?: string;
  request_delay_ms?: number;
  respect_robots?: boolean;
}

export interface ComparisonSourceFormInitial {
  name: string;
  retailer_id: string;
  home_url: string;
  start_urls: string[];
  extraction: ExtractionConfigInput;
  schedule_cron: string;
  active: boolean;
  notes: string;
}

export function emptyComparisonSourceInitial(): ComparisonSourceFormInitial {
  return {
    name: "",
    retailer_id: "",
    home_url: "",
    start_urls: [""],
    extraction: {
      link_discovery: {
        mode: "css",
        link_selector: "a[href*='/p/']",
        next_page_selector: "a[rel='next']",
        max_pages: 5,
      },
      extractors: [{ type: "jsonld_product" }, { type: "og_meta" }],
      request_delay_ms: 1500,
      respect_robots: true,
    },
    schedule_cron: "30 4 * * *",
    active: true,
    notes: "",
  };
}
