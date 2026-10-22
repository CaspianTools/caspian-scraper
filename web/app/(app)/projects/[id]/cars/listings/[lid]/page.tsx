import Link from "next/link";
import { notFound } from "next/navigation";
import { carListingDoc, carSourcesCol } from "@/lib/firestore/collections";
import { jobSourceIds, requireJob } from "@/lib/jobs";
import { CarGallery } from "@/components/CarGallery";
import type { DocumentData } from "@/lib/localdb";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; lid: string }>;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function tsToIso(v: unknown): string {
  if (!v) return "";
  const t = v as { toDate?: () => Date };
  if (typeof t.toDate === "function") return t.toDate().toISOString();
  if (typeof v === "string") return v;
  return "";
}

function fmtAbsolute(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// Preferred order + friendly labels for the spec grid.
const ATTR_LABELS: Record<string, string> = {
  make: "Make",
  model: "Model",
  trim: "Trim",
  year: "Year",
  kilometers: "Kilometers",
  body_type: "Body Type",
  transmission: "Transmission",
  fuel: "Fuel",
  engine_size: "Engine Size",
  seats: "Seats",
  exterior_color: "Exterior Color",
  interior_color: "Interior Color",
  condition: "Condition",
  body_condition: "Body Condition",
  regional_specs: "Regional Specs",
  license: "License",
  insurance: "Insurance",
  payment_method: "Payment Method",
};
const ATTR_ORDER = Object.keys(ATTR_LABELS);

function labelFor(key: string): string {
  return (
    ATTR_LABELS[key] ||
    key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export default async function CarListingDetailPage({ params }: PageProps) {
  const { id, lid } = await params;
  const job = await requireJob(id, "cars");

  // The doc id is "<site>:<listing_id>" (e.g. "opensooq:284135018"); the colon
  // is percent-encoded in the URL and may or may not be decoded back into the
  // route param, so try the decoded form first, then the raw one.
  let data: DocumentData | undefined;
  for (const cand of Array.from(new Set([safeDecode(lid), lid]))) {
    const snap = await carListingDoc(cand).get();
    if (snap.exists) {
      data = snap.data();
      break;
    }
  }
  if (!data || data.owner_uid !== job.uid) notFound();
  // Only a listing scraped by one of this job's sources.
  const sourceIds = await jobSourceIds(carSourcesCol(), job);
  if (!sourceIds.has(String(data.source_id ?? ""))) notFound();

  const title = String(data.title ?? "(untitled)");
  const site = String(data.site ?? "");
  const url = String(data.url ?? "");
  const location = String(data.location ?? "");
  const description = String(data.description ?? "");
  const images: string[] = Array.isArray(data.images)
    ? (data.images as unknown[]).map(String)
    : [];
  const attributes = (data.attributes ?? {}) as Record<string, unknown>;
  const seller = (data.seller ?? {}) as Record<string, unknown>;
  const extras = (data.extras ?? {}) as Record<string, unknown>;

  const priceRaw = String(data.price_raw ?? "");
  const priceValue = data.price_value;
  const currency = String(data.currency ?? "");
  const price =
    priceRaw ||
    (typeof priceValue === "number"
      ? `${priceValue.toLocaleString()} ${currency}`.trim()
      : "");

  const specEntries: [string, string][] = [
    ...ATTR_ORDER.filter((k) => attributes[k]).map(
      (k) => [k, String(attributes[k])] as [string, string]
    ),
    ...Object.entries(attributes)
      .filter(([k, v]) => !ATTR_ORDER.includes(k) && v)
      .map(([k, v]) => [k, String(v)] as [string, string]),
  ];

  const sellerName = String(seller.name ?? "");
  const sellerPhone = String(seller.phone ?? "");
  const sellerProfile = String(seller.profile_url ?? "");
  const sellerSince = String(seller.member_since ?? "");
  const phoneMasked = extras.phone_masked === true;

  return (
    <>
      <Link
        href={`/projects/${job.id}/cars`}
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Cars
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          <div className="flex items-center gap-2 flex-wrap mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {price && (
              <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                {price}
              </span>
            )}
            {location && <span>· {location}</span>}
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {site}
            </span>
          </div>
        </div>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center h-10 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shrink-0 shadow-sm shadow-brand-600/20"
          >
            View on {site || "source"} ↗
          </a>
        )}
      </div>

      <CarGallery images={images} title={title} />

      <div className="grid lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 shadow-card">
          <h3 className="font-medium mb-4">Specifications</h3>
          {specEntries.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No structured specs captured for this listing.
            </p>
          ) : (
            <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
              {specEntries.map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-baseline justify-between gap-3 border-b border-zinc-100 dark:border-zinc-800 pb-2"
                >
                  <dt className="text-sm text-zinc-500">{labelFor(k)}</dt>
                  <dd className="text-sm font-medium text-right">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 space-y-3 shadow-card">
          <h3 className="font-medium">Seller</h3>
          <div className="text-sm space-y-2">
            <div>
              <div className="text-xs text-zinc-500">Name</div>
              <div className="font-medium">{sellerName || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Phone</div>
              <div className="font-medium font-mono">{sellerPhone || "—"}</div>
              {sellerPhone && phoneMasked && (
                <div className="mt-1 text-xs font-sans text-zinc-500">
                  OpenSooq masks the last digits.{" "}
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-600 dark:text-brand-400 hover:underline underline-offset-2"
                    >
                      Reveal the full number on the ad ↗
                    </a>
                  )}
                </div>
              )}
            </div>
            {sellerSince && (
              <div>
                <div className="text-xs text-zinc-500">Member since</div>
                <div className="font-medium">{sellerSince}</div>
              </div>
            )}
            {sellerProfile && (
              <a
                href={sellerProfile}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-sm text-brand-600 dark:text-brand-400 hover:underline underline-offset-2"
              >
                View seller profile ↗
              </a>
            )}
          </div>

          <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800 text-xs text-zinc-500 space-y-1">
            <div>Posted: {String(data.posted_at ?? "—")}</div>
            <div>First seen: {fmtAbsolute(tsToIso(data.first_seen_at))}</div>
            <div>Last seen: {fmtAbsolute(tsToIso(data.last_seen_at))}</div>
            {data.listing_id ? <div>Ad ID: {String(data.listing_id)}</div> : null}
          </div>
        </section>
      </div>

      {description && (
        <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-5 shadow-card">
          <h3 className="font-medium mb-2">Description</h3>
          <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words">
            {description}
          </p>
        </section>
      )}
    </>
  );
}
