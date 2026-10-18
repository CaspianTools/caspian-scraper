"""Few-shot extraction-config examples embedded in the agent system prompt.

The first three are lifted verbatim from web/components/ComparisonSourceForm.tsx
`loadPreset` (jsonld / bim / carrefour) so the AI mirrors patterns that already
run in production. The last is a GENERIC `fields` example — the any-schema path
the AI uses for non-product intents (articles, listings, grants, jobs, ...).
"""

from __future__ import annotations

PRESET_JSONLD = {
    "link_discovery": {
        "mode": "css",
        "link_selector": "a[href*='/p/']",
        "next_page_selector": "a[rel='next']",
        "max_pages": 5,
    },
    "extractors": [{"type": "jsonld_product"}, {"type": "og_meta"}],
    "request_delay_ms": 1500,
    "respect_robots": True,
}

PRESET_CSS_PRODUCT = {
    "link_discovery": {
        "mode": "css",
        "link_selector": "a[href*='/aktuel-urunler/'][href$='/aktuel.aspx']",
        "next_page_selector": "a[aria-label='Next'], a.next",
        "max_pages": 5,
    },
    "extractors": [
        {"type": "og_meta"},
        {
            "type": "css",
            "name_selector": "h1, .product-title",
            "price_selector": ".product-price, .price",
            "currency": "TRY",
            "image_selector": "img.product-image, .product-photo img",
        },
    ],
    "request_delay_ms": 2000,
    "respect_robots": True,
}

# Generic any-schema example: scrape an article/blog archive. Note the selector
# grammar — plain selector = inner_text, "sel@attr" = attribute, "sel@html" =
# inner HTML. required_fields gates what counts as a real record.
PRESET_FIELDS_GENERIC = {
    "link_discovery": {
        "mode": "css",
        "link_selector": "a[href*='/blog/']",
        "next_page_selector": "a[rel='next']",
        "max_pages": 3,
    },
    "extractors": [
        {
            "type": "fields",
            "fields": {
                "title": "h1.headline",
                "published": "time.published@datetime",
                "author": "a.byline",
                "body": "article .content",
            },
            "required_fields": ["title"],
        }
    ],
    "request_delay_ms": 1500,
    "respect_robots": True,
}

PRESETS = {
    "jsonld_product_only": PRESET_JSONLD,
    "og_plus_css_product": PRESET_CSS_PRODUCT,
    "generic_fields_article": PRESET_FIELDS_GENERIC,
}
