import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import {
  comparisonCanonicalsCol,
  comparisonListingsCol,
  comparisonSourcesCol,
} from "@/lib/firestore/collections";

export const dynamic = "force-dynamic";

interface ListingCell {
  retailer_id: string;
  retailer_name: string;
  price_value: number;
  price_currency: string;
  unit_price_value: number | null;
  unit_price_basis: string;
  product_url: string;
  in_stock: boolean | null;
}

interface CanonicalRow {
  id: string;
  display_name: string;
  brand: string;
  size_value: number | null;
  size_unit: string;
  gtin: string | null;
  cells_by_retailer: Record<string, ListingCell>;
  best_unit_price: number | null;
}

export default async function ComparisonComparePage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const [canonicalsSnap, sourcesSnap] = await Promise.all([
    comparisonCanonicalsCol()
      .where("owner_uid", "==", session.uid)
      .orderBy("created_at", "desc")
      .limit(500)
      .get(),
    comparisonSourcesCol().where("owner_uid", "==", session.uid).get(),
  ]);

  const retailerName: Record<string, string> = {};
  for (const s of sourcesSnap.docs) {
    retailerName[String(s.data().retailer_id ?? "")] = String(
      s.data().name ?? ""
    );
  }

  if (canonicalsSnap.empty) {
    return (
      <>
        <h2 className="text-xl font-semibold tracking-tight">Compare</h2>
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md mx-auto">
            No canonical products yet. Once two retailers carry the same
            item — auto-linked by GTIN, or manually linked from{" "}
            <Link href="/comparison" className="underline">Findings</Link> —
            it appears here as one row with side-by-side prices.
          </p>
        </div>
      </>
    );
  }

  // Batch-fetch every referenced listing in chunks of 10.
  const allListingIds = new Set<string>();
  for (const d of canonicalsSnap.docs) {
    const ids = (d.data().listing_ids ?? []) as string[];
    for (const lid of ids) allListingIds.add(lid);
  }
  const ids = Array.from(allListingIds);
  const listingsById = new Map<string, FirebaseFirestore.DocumentData>();
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    if (chunk.length === 0) continue;
    const chunkSnap = await comparisonListingsCol()
      .where(
        "__name__",
        "in",
        chunk.map((lid) => comparisonListingsCol().doc(lid))
      )
      .get();
    for (const ld of chunkSnap.docs) {
      if (ld.data().owner_uid !== session.uid) continue;
      listingsById.set(ld.id, ld.data());
    }
  }

  const retailersInUse = new Set<string>();
  const rows: CanonicalRow[] = canonicalsSnap.docs.map((d) => {
    const data = d.data();
    const linkedIds = (data.listing_ids ?? []) as string[];
    const cells: Record<string, ListingCell> = {};
    let bestUnit: number | null = null;
    for (const lid of linkedIds) {
      const ld = listingsById.get(lid);
      if (!ld) continue;
      const rid = String(ld.retailer_id ?? "");
      if (!rid) continue;
      retailersInUse.add(rid);
      const unit = (ld.unit_price_value as number | null) ?? null;
      if (unit != null && (bestUnit == null || unit < bestUnit)) bestUnit = unit;
      cells[rid] = {
        retailer_id: rid,
        retailer_name:
          retailerName[rid] || String(ld.retailer_name ?? "") || rid,
        price_value: Number(ld.price_value ?? 0),
        price_currency: String(ld.price_currency ?? "AED"),
        unit_price_value: unit,
        unit_price_basis: String(ld.unit_price_basis ?? ""),
        product_url: String(ld.product_url ?? ""),
        in_stock:
          ld.in_stock === null || ld.in_stock === undefined
            ? null
            : Boolean(ld.in_stock),
      };
    }
    return {
      id: d.id,
      display_name: String(data.display_name ?? ""),
      brand: String(data.brand ?? ""),
      size_value: (data.size_value as number | null) ?? null,
      size_unit: String(data.size_unit ?? ""),
      gtin: (data.gtin as string | null) ?? null,
      cells_by_retailer: cells,
      best_unit_price: bestUnit,
    };
  });

  const retailerCols = Array.from(retailersInUse).sort((a, b) =>
    (retailerName[a] || a).localeCompare(retailerName[b] || b)
  );

  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Compare</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            {rows.length} canonical product{rows.length === 1 ? "" : "s"} ×{" "}
            {retailerCols.length} retailer
            {retailerCols.length === 1 ? "" : "s"}. Best unit-price per row
            is highlighted.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
              <th className="text-left px-4 py-2 font-medium text-zinc-700 dark:text-zinc-300">
                Product
              </th>
              {retailerCols.map((rid) => (
                <th
                  key={rid}
                  className="text-left px-4 py-2 font-medium text-zinc-700 dark:text-zinc-300 whitespace-nowrap"
                >
                  {retailerName[rid] || rid}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-zinc-100 dark:border-zinc-800 last:border-0"
              >
                <td className="px-4 py-3 align-top">
                  <div className="font-medium">
                    {row.display_name || "(unnamed)"}
                  </div>
                  <div className="text-xs text-zinc-500 mt-0.5 space-x-2">
                    {row.brand && <span>{row.brand}</span>}
                    {row.size_value != null && row.size_unit && (
                      <span>
                        · {row.size_value} {row.size_unit}
                      </span>
                    )}
                    {row.gtin && <span>· GTIN {row.gtin}</span>}
                  </div>
                </td>
                {retailerCols.map((rid) => {
                  const cell = row.cells_by_retailer[rid];
                  if (!cell) {
                    return (
                      <td
                        key={rid}
                        className="px-4 py-3 align-top text-zinc-300 dark:text-zinc-700"
                      >
                        —
                      </td>
                    );
                  }
                  const isBest =
                    cell.unit_price_value != null &&
                    row.best_unit_price != null &&
                    cell.unit_price_value === row.best_unit_price &&
                    retailerCols.length > 1;
                  return (
                    <td
                      key={rid}
                      className={
                        "px-4 py-3 align-top " +
                        (isBest ? "bg-emerald-50 dark:bg-emerald-900/20" : "")
                      }
                    >
                      <a
                        href={cell.product_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-medium tabular-nums hover:underline"
                      >
                        {cell.price_value.toFixed(2)} {cell.price_currency}
                      </a>
                      {cell.unit_price_value != null && (
                        <div className="text-xs text-zinc-500 mt-0.5 tabular-nums">
                          {cell.unit_price_value.toFixed(2)}{" "}
                          {cell.price_currency} {cell.unit_price_basis}
                        </div>
                      )}
                      {cell.in_stock === false && (
                        <div className="text-xs text-red-500 mt-0.5">
                          out of stock
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
