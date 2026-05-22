import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import {
  comparisonListingsCol,
  comparisonSourcesCol,
  comparisonCanonicalsCol,
} from "@/lib/firestore/collections";
import {
  ComparisonFindingsView,
  type ComparisonFindingRow,
  type CanonicalOption,
} from "@/components/ComparisonFindingsView";

export const dynamic = "force-dynamic";

function tsToIso(v: unknown): string {
  if (!v) return "";
  const t = v as { toDate?: () => Date };
  if (typeof t.toDate === "function") return t.toDate().toISOString();
  if (typeof v === "string") return v;
  return "";
}

export default async function ComparisonFindingsPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const [listingsSnap, sourcesSnap, canonicalsSnap] = await Promise.all([
    comparisonListingsCol()
      .where("owner_uid", "==", session.uid)
      .orderBy("last_seen_at", "desc")
      .limit(500)
      .get(),
    comparisonSourcesCol().where("owner_uid", "==", session.uid).get(),
    comparisonCanonicalsCol()
      .where("owner_uid", "==", session.uid)
      .orderBy("created_at", "desc")
      .get(),
  ]);

  const retailerName: Record<string, string> = {};
  for (const s of sourcesSnap.docs) {
    retailerName[String(s.data().retailer_id ?? "")] =
      String(s.data().name ?? "");
  }

  const findings: ComparisonFindingRow[] = listingsSnap.docs.map((d) => {
    const data = d.data();
    const retailerId = String(data.retailer_id ?? "");
    return {
      id: d.id,
      retailer_id: retailerId,
      retailer_name:
        retailerName[retailerId] || String(data.retailer_name ?? "") || retailerId,
      product_url: String(data.product_url ?? ""),
      name: String(data.name ?? ""),
      brand: String(data.brand ?? ""),
      gtin: (data.gtin as string | null) ?? null,
      size_value: (data.size_value as number | null) ?? null,
      size_unit: String(data.size_unit ?? ""),
      price_value: Number(data.price_value ?? 0),
      price_currency: String(data.price_currency ?? "AED"),
      unit_price_value: (data.unit_price_value as number | null) ?? null,
      unit_price_basis: String(data.unit_price_basis ?? ""),
      image_url: String(data.image_url ?? ""),
      in_stock:
        data.in_stock === null || data.in_stock === undefined
          ? null
          : Boolean(data.in_stock),
      canonical_id: (data.canonical_id as string | null) ?? null,
      status: String(data.status ?? "new"),
      first_seen_at: tsToIso(data.first_seen_at),
      last_seen_at: tsToIso(data.last_seen_at),
    };
  });

  const canonicals: CanonicalOption[] = canonicalsSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      display_name: String(data.display_name ?? ""),
      brand: String(data.brand ?? ""),
      size_value: (data.size_value as number | null) ?? null,
      size_unit: String(data.size_unit ?? ""),
      gtin: (data.gtin as string | null) ?? null,
    };
  });

  const sourcesCount = sourcesSnap.size;
  const productSourcesEmpty = sourcesCount === 0;

  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Findings</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-2xl">
            Every product scraped across your comparison sources. Linked
            rows participate in the side-by-side <Link href="/comparison/compare" className="underline">Compare</Link> table.
            Unlinked rows need a canonical match (GTIN auto-links; otherwise
            use the inline match action).
          </p>
        </div>
        <Link
          href="/comparison/sources/new"
          className="inline-flex items-center h-9 px-3 rounded-lg bg-black text-white text-sm hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          + Add source
        </Link>
      </div>

      {productSourcesEmpty ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md mx-auto">
            No comparison sources yet. Add one — point it at a retailer
            category page and configure an extraction strategy — and the
            next scheduled scrape will populate this table.
          </p>
          <div className="mt-4">
            <Link
              href="/comparison/sources/new"
              className="inline-flex items-center h-9 px-4 rounded-lg bg-black text-white text-sm hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              Add your first source
            </Link>
          </div>
        </div>
      ) : findings.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md mx-auto">
            {sourcesCount} comparison source{sourcesCount === 1 ? "" : "s"} configured
            but no findings yet. Either the next scrape hasn&apos;t run yet, or
            extraction returned zero — open the most recent <Link href="/comparison/runs" className="underline">run</Link> to see why.
          </p>
        </div>
      ) : (
        <ComparisonFindingsView
          findings={findings}
          canonicals={canonicals}
        />
      )}
    </>
  );
}
