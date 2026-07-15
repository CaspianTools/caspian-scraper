import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { carListingsCol } from "@/lib/firestore/collections";

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

const FETCH_CAP = 3000;

export default async function CarListingsPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");

  const snap = await carListingsCol()
    .where("owner_uid", "==", session.uid)
    .limit(FETCH_CAP)
    .get();

  const rows = snap.docs
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
      return {
        id: d.id,
        title: String(data.title ?? "(untitled)"),
        url: String(data.url ?? ""),
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
          <h2 className="text-xl font-semibold tracking-tight">Listings</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            {rows.length === 0
              ? "No listings yet."
              : `${rows.length} listing${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <Link
          href="/cars/sources/new"
          className="inline-flex items-center h-10 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          + Add source
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4 max-w-md mx-auto">
            Car listings appear here once a source scrapes. Add a source
            (site + country + optional query + schedule) and trigger Run-now
            to pull OpenSooq/Dubizzle/YallaMotor cars for Oman.
          </p>
          <Link
            href="/cars/sources/new"
            className="inline-flex items-center h-9 px-4 rounded-lg bg-black text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Add your first source
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
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
                  <td className="px-4 py-3 max-w-xs">
                    {r.url ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium hover:underline line-clamp-1"
                      >
                        {r.title}
                      </a>
                    ) : (
                      <span className="font-medium line-clamp-1">{r.title}</span>
                    )}
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
