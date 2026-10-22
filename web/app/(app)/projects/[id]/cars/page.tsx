import Link from "next/link";
import { carListingsCol, carSourcesCol } from "@/lib/firestore/collections";
import { jobSourceIds, requireJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

function millis(v: unknown): number {
  const t = v as { toMillis?: () => number };
  if (t && typeof t.toMillis === "function") return t.toMillis();
  if (typeof v === "string") {
    const p = Date.parse(v);
    return Number.isNaN(p) ? 0 : p;
  }
  return 0;
}

function fmtRelative(ms: number): string {
  if (!ms) return "—";
  const delta = Math.round((Date.now() - ms) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

/** Case-insensitive attribute lookup against a list of candidate keys. */
function attr(attrs: Record<string, unknown>, ...keys: string[]): string {
  const lowerMap: Record<string, string> = {};
  for (const k of Object.keys(attrs)) {
    const val = attrs[k];
    if (typeof val === "string") lowerMap[k.toLowerCase()] = val;
  }
  for (const want of keys) {
    if (lowerMap[want]) return lowerMap[want];
  }
  return "";
}

/** A small CDN-resized thumbnail from an OpenSooq image URL (the size lives
 * in the path); falls back to the original URL for anything else. */
function carThumb(url: string): string {
  return url.replace(
    /(https:\/\/opensooq-images\.os-cdn\.com\/previews\/)\d+x\d+(\/)/,
    "$1200x0$2"
  );
}

const FETCH_CAP = 3000;

interface PageProps {
  params: Promise<{ id: string }>;
}

/** A car job's results: the listings its sources (car_sources with this
 *  project_id) have scraped, matched by the listing's `source_id`. */
export default async function CarListingsPage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id, "cars");
  const base = `/projects/${job.id}/cars`;
  const sourceIds = await jobSourceIds(carSourcesCol(), job);

  const snap = await carListingsCol()
    .where("owner_uid", "==", job.uid)
    .limit(FETCH_CAP)
    .get();

  const rows = snap.docs
    .filter((d) => sourceIds.has(String(d.data().source_id ?? "")))
    .map((d) => {
      const data = d.data();
      const attrs = (data.attributes ?? {}) as Record<string, unknown>;
      const make = attr(attrs, "make", "brand", "manufacturer");
      const model = attr(attrs, "model", "trim");
      const year = attr(attrs, "year", "make year", "model year");
      const km = attr(attrs, "kilometers", "mileage", "km", "kilometres");
      const priceRaw = String(data.price_raw ?? "");
      const priceValue = data.price_value;
      const currency = String(data.currency ?? "");
      const price =
        priceRaw ||
        (typeof priceValue === "number"
          ? `${priceValue.toLocaleString()} ${currency}`.trim()
          : "");
      const imgList = Array.isArray(data.images) ? (data.images as unknown[]) : [];
      const image = imgList.length ? String(imgList[0]) : "";
      return {
        id: d.id,
        title: String(data.title ?? "(untitled)"),
        url: String(data.url ?? ""),
        image,
        site: String(data.site ?? ""),
        car: [make, model].filter(Boolean).join(" "),
        year,
        km,
        price,
        location: String(data.location ?? ""),
        seenMs: millis(data.last_seen_at),
      };
    })
    .sort((a, b) => b.seenMs - a.seenMs)
    .slice(0, 500);

  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Cars</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            {rows.length === 0
              ? "No cars yet."
              : `${rows.length} car${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <Link
          href={`${base}/sources/new`}
          className="inline-flex items-center h-10 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
        >
          + Add source
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center bg-white/60 dark:bg-zinc-950/40">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4 max-w-md mx-auto">
            No cars yet — add a website under Sources, then run the job.
          </p>
          <Link
            href={`${base}/sources/new`}
            className="inline-flex items-center h-9 px-4 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-500 dark:bg-brand-500 dark:text-white dark:hover:bg-brand-400 shadow-sm shadow-brand-600/20"
          >
            Add your first source
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 dark:bg-zinc-900/60 text-[11px] font-medium uppercase tracking-wider text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className="text-left px-4 py-2 font-medium w-20">Photo</th>
                <th className="text-left px-4 py-2 font-medium">Title</th>
                <th className="text-left px-4 py-2 font-medium">Car</th>
                <th className="text-left px-4 py-2 font-medium">Year</th>
                <th className="text-right px-4 py-2 font-medium">Mileage</th>
                <th className="text-right px-4 py-2 font-medium">Price</th>
                <th className="text-left px-4 py-2 font-medium">Location</th>
                <th className="text-left px-4 py-2 font-medium">Seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3">
                    <Link
                      href={`${base}/listings/${encodeURIComponent(r.id)}`}
                      className="block"
                    >
                      {r.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={carThumb(r.image)}
                          alt=""
                          loading="lazy"
                          className="w-16 h-12 object-cover rounded-md bg-zinc-100 dark:bg-zinc-800"
                        />
                      ) : (
                        <div className="w-16 h-12 rounded-md bg-zinc-100 dark:bg-zinc-800" />
                      )}
                    </Link>
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <Link
                      href={`${base}/listings/${encodeURIComponent(r.id)}`}
                      className="font-medium hover:underline line-clamp-1"
                    >
                      {r.title}
                    </Link>
                    <div className="text-xs text-zinc-500">{r.site}</div>
                  </td>
                  <td className="px-4 py-3">{r.car || "—"}</td>
                  <td className="px-4 py-3 tabular-nums">{r.year || "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.km || "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {r.price || "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {r.location || "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {fmtRelative(r.seenMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
