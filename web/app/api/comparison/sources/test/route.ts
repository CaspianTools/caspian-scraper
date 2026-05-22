import { NextRequest, NextResponse } from "next/server";
import { getSessionFromBearer } from "@/lib/auth/session";
import {
  ComparisonTestSchema,
  type ExtractionConfig,
} from "@/lib/firestore/schema";

/**
 * POST /api/comparison/sources/test
 *
 * Runs a lightweight extraction against a sample URL without persisting
 * anything. Used by the source-create form's "Test" button so operators
 * can iterate on selectors in seconds instead of waiting for the next
 * cron tick.
 *
 * Coverage:
 *   - jsonld_product, og_meta: fully validated here (regex over static HTML).
 *   - css, microdata: NOT validated here. Real CSS-selector evaluation
 *     needs a JS-rendered DOM (Playwright) which isn't available in this
 *     Next.js handler. Such configs come back with `note:` so the operator
 *     knows the response doesn't prove their CSS selectors work.
 *
 * Anti-bot HTTP errors (403/429) from the origin are surfaced directly so
 * the operator sees them immediately (A101-style failures).
 */

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function POST(req: NextRequest) {
  const session = await getSessionFromBearer(req.headers.get("authorization"));
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = ComparisonTestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid test config", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { extraction, sample_url, start_urls } = parsed.data;

  const urlToTest =
    sample_url || (start_urls && start_urls[0]) || undefined;
  if (!urlToTest) {
    return NextResponse.json(
      { error: "must provide sample_url or start_urls" },
      { status: 400 }
    );
  }

  const ua = extraction.user_agent || DEFAULT_UA;

  let resp: Response;
  try {
    resp = await fetch(urlToTest, {
      headers: { "User-Agent": ua, Accept: "text/html,*/*" },
      redirect: "follow",
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      http_status: 0,
      error: `fetch failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
  }

  if (!resp.ok) {
    return NextResponse.json({
      ok: false,
      http_status: resp.status,
      error:
        resp.status === 403
          ? "Upstream returned 403 — site is blocking automated access. Proxy support arrives in Phase C."
          : `Upstream returned HTTP ${resp.status}`,
    });
  }

  const html = await resp.text();
  return NextResponse.json(runExtractors(extraction, html, urlToTest, resp.status));
}

function runExtractors(
  extraction: ExtractionConfig,
  html: string,
  url: string,
  http_status: number
) {
  const tried: string[] = [];
  let cssListed = false;
  for (const ex of extraction.extractors) {
    tried.push(ex.type);
    if (ex.type === "jsonld_product") {
      const listing = tryExtractJsonLd(html, url);
      if (listing) {
        return { ok: true, extractor: ex.type, http_status, listing, tried };
      }
    } else if (ex.type === "og_meta") {
      const listing = tryExtractOgMeta(html, url);
      if (listing) {
        return { ok: true, extractor: ex.type, http_status, listing, tried };
      }
    } else if (ex.type === "css" || ex.type === "microdata") {
      cssListed = cssListed || ex.type === "css";
      // Not testable from this endpoint — scheduled scrape will try it.
    }
  }
  return {
    ok: false,
    http_status,
    error:
      "No testable extractor produced a product. JSON-LD and OG meta were checked; nothing matched.",
    note: cssListed
      ? "Your config also lists a `css` extractor. This endpoint cannot validate CSS selectors (requires a rendered DOM) — they will be tried during the next scheduled scrape."
      : undefined,
    tried,
  };
}

// ---------------------------------------------------------------------------
// Extractor implementations — regex over static HTML. Lightweight; lives
// here rather than going through Playwright so the round-trip is fast.
// ---------------------------------------------------------------------------

interface MinimalProductPreview {
  retailer_id: string;
  product_url: string;
  name: string;
  brand: string;
  gtin: string | null;
  price_value: number;
  price_currency: string;
  size_value: number | null;
  size_unit: string;
  image_url: string;
}

const SIZE_RE =
  /(\d+(?:[.,]\d+)?)\s*(kilogram[s]?|kg|gram[s]?|g|milligram[s]?|mg|millilit(?:er|re)s?|ml|centilit(?:er|re)s?|cl|lit(?:er|re)s?|l|each|ea|piece[s]?|pcs|adet|unit)\b/i;

function parseSize(text: string): { value: number | null; unit: string } {
  if (!text) return { value: null, unit: "" };
  const m = text.match(SIZE_RE);
  if (!m) return { value: null, unit: "" };
  const n = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return { value: null, unit: "" };
  return { value: n, unit: m[2] };
}

function tryExtractJsonLd(
  html: string,
  url: string
): MinimalProductPreview | null {
  const scripts = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
  ];
  for (const m of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const node = findProductNode(data);
    if (!node) continue;

    const name = String(node.name ?? "").trim();
    if (!name) continue;
    const offer = pickOffer(node);
    if (!offer) continue;
    const priceRaw =
      offer.price ?? offer.lowPrice ?? offer.highPrice ?? null;
    const price =
      typeof priceRaw === "number"
        ? priceRaw
        : parseFloat(String(priceRaw ?? "").replace(",", "."));
    if (!Number.isFinite(price) || price <= 0) continue;

    const brand =
      typeof node.brand === "string"
        ? node.brand
        : (node.brand as { name?: string } | undefined)?.name ?? "";
    const gtin =
      (node.gtin13 as string | undefined) ||
      (node.gtin14 as string | undefined) ||
      (node.gtin12 as string | undefined) ||
      (node.gtin8 as string | undefined) ||
      (node.gtin as string | undefined) ||
      null;
    const image = Array.isArray(node.image)
      ? (node.image[0] as string)
      : (node.image as string | undefined) ?? "";
    const { value: size_value, unit: size_unit } = parseSize(name);

    return {
      retailer_id: "(test)",
      product_url: url,
      name,
      brand: String(brand).trim(),
      gtin: gtin ? String(gtin) : null,
      price_value: price,
      price_currency:
        String(offer.priceCurrency ?? "").toUpperCase() || "USD",
      size_value,
      size_unit,
      image_url: image,
    };
  }
  return null;
}

type JsonLdNode = Record<string, unknown> & {
  "@type"?: string | string[];
  "@graph"?: unknown[];
  name?: string;
  brand?: string | { name?: string };
  gtin?: string;
  gtin13?: string;
  gtin12?: string;
  gtin14?: string;
  gtin8?: string;
  offers?: unknown;
  image?: unknown;
};

function findProductNode(blob: unknown): JsonLdNode | null {
  const isProduct = (n: unknown): n is JsonLdNode => {
    if (!n || typeof n !== "object") return false;
    const t = (n as JsonLdNode)["@type"];
    if (typeof t === "string") return t.toLowerCase() === "product";
    if (Array.isArray(t))
      return t.some((x) => typeof x === "string" && x.toLowerCase() === "product");
    return false;
  };

  const visit = (n: unknown): JsonLdNode | null => {
    if (!n || typeof n !== "object") return null;
    if (isProduct(n)) return n as JsonLdNode;
    const graph = (n as JsonLdNode)["@graph"];
    if (Array.isArray(graph)) {
      for (const g of graph) {
        const f = visit(g);
        if (f) return f;
      }
    }
    return null;
  };

  if (Array.isArray(blob)) {
    for (const item of blob) {
      const f = visit(item);
      if (f) return f;
    }
    return null;
  }
  return visit(blob);
}

function pickOffer(
  node: JsonLdNode
): Record<string, unknown> | null {
  const o = node.offers;
  if (!o) return null;
  if (Array.isArray(o)) {
    return (o[0] as Record<string, unknown>) ?? null;
  }
  if (typeof o === "object") {
    const obj = o as Record<string, unknown>;
    const t = String(obj["@type"] ?? "").toLowerCase();
    if (t === "aggregateoffer") {
      const inner = obj.offers;
      if (Array.isArray(inner) && inner.length) {
        return (inner[0] as Record<string, unknown>) ?? null;
      }
      return obj;
    }
    return obj;
  }
  return null;
}

function tryExtractOgMeta(
  html: string,
  url: string
): MinimalProductPreview | null {
  const meta = (key: string): string => {
    // Three attribute orderings; meta tag attrs are unordered in HTML.
    const re1 = new RegExp(
      `<meta[^>]+property=["']${escapeRe(key)}["'][^>]+content=["']([^"']+)["']`,
      "i"
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRe(key)}["']`,
      "i"
    );
    const re3 = new RegExp(
      `<meta[^>]+name=["']${escapeRe(key)}["'][^>]+content=["']([^"']+)["']`,
      "i"
    );
    const re4 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapeRe(key)}["']`,
      "i"
    );
    return (
      html.match(re1)?.[1] ||
      html.match(re2)?.[1] ||
      html.match(re3)?.[1] ||
      html.match(re4)?.[1] ||
      ""
    );
  };
  const name = meta("og:title") || meta("twitter:title");
  if (!name) return null;
  const priceStr = meta("product:price:amount") || meta("og:price:amount");
  if (!priceStr) return null;
  const price = parseFloat(priceStr.replace(",", "."));
  if (!Number.isFinite(price) || price <= 0) return null;

  const { value: size_value, unit: size_unit } = parseSize(name);
  return {
    retailer_id: "(test)",
    product_url: url,
    name,
    brand: meta("product:brand") || meta("og:brand") || "",
    gtin: null,
    price_value: price,
    price_currency: (
      meta("product:price:currency") ||
      meta("og:price:currency") ||
      "USD"
    ).toUpperCase(),
    size_value,
    size_unit,
    image_url: meta("og:image") || "",
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
