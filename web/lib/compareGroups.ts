/**
 * Compare: the same item across a job's sources, matched from the job's
 * results store (job_results.py). Pure and dependency-free, so it can be
 * unit-tested and used on the server or the client.
 *
 * Rules (deterministic):
 *   - hidden records and records whose status is "gone" are skipped;
 *   - records with a product code (gtin) group by it — digits only, leading
 *     zeros dropped, so GTIN-13 and its zero-padded GTIN-14 match;
 *   - records without one group by their normalised title (normTitle). If
 *     that title is also the title of exactly one product-code group, the
 *     record joins that group instead;
 *   - a group is kept when its records come from minSources+ different
 *     `source`s (default 2). Per source the cheapest record is its cell;
 *   - the cheapest cell is the lowest price among cells in the group's most
 *     common currency (prices in other currencies aren't compared).
 *
 * Example:
 *   compareGroups([
 *     { id: "a", title: "Bosch GSB 18V-55 Drill!", source: "Shop A", price: 99, currency: "AED" },
 *     { id: "b", title: "bosch  gsb 18v 55 drill", source: "Shop B", price: "89.5", currency: "AED" },
 *     { id: "c", title: "Something else", source: "Shop B", price: 5 },
 *   ])
 *   → one group "bosch gsb 18v 55 drill", cells for Shop A and Shop B,
 *     cheapest "Shop B"; sources ["Shop A", "Shop B"].
 */

export interface CompareInput {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  source?: unknown;
  shop?: unknown;
  source_id?: unknown;
  price?: unknown;
  currency?: unknown;
  brand?: unknown;
  gtin?: unknown;
  hidden?: unknown;
  status?: unknown;
}

export interface CompareCell {
  id: string;
  title: string;
  url: string;
  price: number | null;
  currency: string;
}

export interface CompareGroup {
  key: string;
  /** How the group was matched. */
  by: "gtin" | "title";
  title: string;
  brand: string;
  gtin: string;
  /** Source name → that source's (cheapest) record. */
  cells: Record<string, CompareCell>;
  /** The sources in this group, in the result's column order. */
  sources: string[];
  /** The source with the cheapest price, or null when none is comparable. */
  cheapest: string | null;
}

export interface CompareResult {
  groups: CompareGroup[];
  /** Every source in a kept group: most groups first, then by name. */
  sources: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** Lowercase, NFKC, punctuation → spaces, spaces collapsed. */
export function normTitle(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Digits only, leading zeros dropped ("" when there are none). */
export function normGtin(v: unknown): string {
  return str(v).replace(/\D+/g, "").replace(/^0+/, "");
}

/** A number from 12.5 / "12.5" / "1,299.00"; null if it isn't one. */
export function parsePrice(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = str(v).replace(/[\s,]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareGroups(records: CompareInput[], { minSources = 2 } = {}): CompareResult {
  interface Item {
    id: string;
    title: string;
    titleKey: string;
    gtin: string;
    source: string;
    rec: CompareInput;
  }
  const items: Item[] = [];
  for (const r of records) {
    if (r.hidden === true || r.status === "gone") continue;
    const source = str(r.source) || str(r.shop) || str(r.source_id);
    if (!source) continue;
    const title = str(r.title);
    const item = { id: str(r.id), title, titleKey: normTitle(title), gtin: normGtin(r.gtin), source, rec: r };
    if (!item.gtin && !item.titleKey) continue;
    items.push(item);
  }
  items.sort((a, b) => byText(a.id, b.id));

  // Titles of the product-code groups: a record without a code joins a code
  // group whose records carry its title, when exactly one does.
  const gtinsByTitle = new Map<string, Set<string>>();
  for (const it of items) {
    if (!it.gtin || !it.titleKey) continue;
    const set = gtinsByTitle.get(it.titleKey) ?? new Set<string>();
    set.add(it.gtin);
    gtinsByTitle.set(it.titleKey, set);
  }

  const buckets = new Map<string, Item[]>();
  for (const it of items) {
    let key: string;
    if (it.gtin) key = `gtin:${it.gtin}`;
    else {
      const codes = gtinsByTitle.get(it.titleKey);
      key = codes && codes.size === 1 ? `gtin:${[...codes][0]}` : `title:${it.titleKey}`;
    }
    const list = buckets.get(key) ?? [];
    list.push(it);
    buckets.set(key, list);
  }

  const groups: CompareGroup[] = [];
  const sourceUse = new Map<string, number>();
  for (const [key, list] of buckets) {
    const cells: Record<string, CompareCell> = {};
    for (const it of list) {
      const cell: CompareCell = {
        id: it.id,
        title: it.title,
        url: str(it.rec.url),
        price: parsePrice(it.rec.price),
        currency: str(it.rec.currency).toUpperCase(),
      };
      const prev = cells[it.source];
      // Per source keep the cheapest record (a priced one beats an unpriced one).
      if (!prev || (cell.price !== null && (prev.price === null || cell.price < prev.price))) cells[it.source] = cell;
    }
    const sources = Object.keys(cells).sort(byText);
    if (sources.length < minSources) continue;

    // Cheapest among the cells in the group's most common currency.
    const currencyCount = new Map<string, number>();
    for (const s of sources) {
      const c = cells[s];
      if (c.price !== null) currencyCount.set(c.currency, (currencyCount.get(c.currency) ?? 0) + 1);
    }
    const currency = [...currencyCount].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0]?.[0];
    let cheapest: string | null = null;
    if (currency !== undefined && (currencyCount.get(currency) ?? 0) >= 2) {
      for (const s of sources) {
        const c = cells[s];
        if (c.price === null || c.currency !== currency) continue;
        if (cheapest === null || c.price < (cells[cheapest].price as number)) cheapest = s;
      }
    }

    const first = list.find((it) => it.title) ?? list[0];
    groups.push({
      key,
      by: key.startsWith("gtin:") ? "gtin" : "title",
      title: first.title,
      brand: list.map((it) => str(it.rec.brand)).find(Boolean) ?? "",
      gtin: list.map((it) => str(it.rec.gtin)).find(Boolean) ?? "",
      cells,
      sources,
      cheapest,
    });
    for (const s of sources) sourceUse.set(s, (sourceUse.get(s) ?? 0) + 1);
  }

  groups.sort((a, b) => b.sources.length - a.sources.length || byText(normTitle(a.title), normTitle(b.title)) || byText(a.key, b.key));
  const sources = [...sourceUse].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).map(([s]) => s);
  return { groups, sources };
}
