import Link from "next/link";
import { requireJob } from "@/lib/jobs";
import {
  comparisonListingsCol,
  comparisonCanonicalsCol,
} from "@/lib/firestore/collections";
import { pricesJobScope } from "@/app/api/comparison/jobScope";
import {
  ComparisonFindingsView,
  type ComparisonFindingRow,
  type CanonicalOption,
} from "@/components/ComparisonFindingsView";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function tsToIso(v: unknown): string {
  if (!v) return "";
  const t = v as { toDate?: () => Date };
  if (typeof t.toDate === "function") return t.toDate().toISOString();
  if (typeof v === "string") return v;
  return "";
}

/**
 * A prices job's Products page: every product its shops (comparison
 * sources with project_id = this job) returned, with the inline match
 * action that links listings into the Compare table.
 */
export default async function PricesProductsPage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id, "prices");
  const base = `/projects/${job.id}/prices`;

  const [scope, listingsSnap, canonicalsSnap] = await Promise.all([
    pricesJobScope(job.uid, job.id),
    comparisonListingsCol()
      .where("owner_uid", "==", job.uid)
      .orderBy("last_seen_at", "desc")
      .get(),
    comparisonCanonicalsCol()
      .where("owner_uid", "==", job.uid)
      .orderBy("created_at", "desc")
      .get(),
  ]);

  const retailerName: Record<string, string> = {};
  for (const s of scope.sources) {
    retailerName[String(s.data().retailer_id ?? "")] =
      String(s.data().name ?? "");
  }

  const jobListings = listingsSnap.docs.filter((d) => scope.hasListing(d.data()));
  const findings: ComparisonFindingRow[] = jobListings.slice(0, 500).map((d) => {
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

  // Match targets: canonicals that already hold one of this job's listings.
  const jobListingIds = new Set(jobListings.map((d) => d.id));
  const canonicals: CanonicalOption[] = canonicalsSnap.docs
    .filter((d) => {
      const ids = (d.data().listing_ids ?? []) as string[];
      return ids.some((lid) => jobListingIds.has(lid));
    })
    .map((d) => {
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

  const sourcesCount = scope.sources.length;

  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Products</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-2xl">
            Every product found in this job&apos;s shops, with its price.
            Linked products appear side by side in{" "}
            <Link href={`${base}/compare`} className="underline">Compare</Link>.
            Unlinked ones need a match (same GTIN links automatically;
            otherwise use the inline link action).
          </p>
        </div>
        <Link
          href={`${base}/sources/new`}
          className="inline-flex items-center h-9 px-3 rounded-lg bg-brand-600 text-white text-sm hover:bg-brand-500 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
        >
          + Add shop
        </Link>
      </div>

      {sourcesCount === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center bg-white/60 dark:bg-zinc-950/40">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md mx-auto">
            No products yet — add a shop under{" "}
            <Link href={`${base}/sources`} className="underline">Sources</Link>,
            then run the job.
          </p>
          <div className="mt-4">
            <Link
              href={`${base}/sources/new`}
              className="inline-flex items-center h-9 px-4 rounded-lg bg-brand-600 text-white text-sm hover:bg-brand-500 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
            >
              Add your first shop
            </Link>
          </div>
        </div>
      ) : findings.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center bg-white/60 dark:bg-zinc-950/40">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md mx-auto">
            {sourcesCount} shop{sourcesCount === 1 ? "" : "s"} set up but no
            products yet. Run the job from{" "}
            <Link href={`${base}/runs`} className="underline">Runs</Link> —
            or, if it already ran, open the latest run to see why nothing
            was extracted.
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
