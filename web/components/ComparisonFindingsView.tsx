"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/firebase/clientFetch";

export interface ComparisonFindingRow {
  id: string;
  retailer_id: string;
  retailer_name: string;
  product_url: string;
  name: string;
  brand: string;
  gtin: string | null;
  size_value: number | null;
  size_unit: string;
  price_value: number;
  price_currency: string;
  unit_price_value: number | null;
  unit_price_basis: string;
  image_url: string;
  in_stock: boolean | null;
  canonical_id: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface CanonicalOption {
  id: string;
  display_name: string;
  brand: string;
  size_value: number | null;
  size_unit: string;
  gtin: string | null;
}

interface Props {
  findings: ComparisonFindingRow[];
  canonicals: CanonicalOption[];
}

type StatusFilter = "all" | "new" | "linked" | "stale" | "failed_extract";

function fmtRelative(iso: string): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Math.round((Date.now() - t) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

function statusClasses(s: string): string {
  switch (s) {
    case "linked":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "new":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
    case "stale":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "failed_extract":
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function scoreCanonical(
  listing: ComparisonFindingRow,
  c: CanonicalOption
): number {
  const brandExact =
    listing.brand &&
    c.brand &&
    listing.brand.toLowerCase() === c.brand.toLowerCase()
      ? 1
      : 0;
  const nameSim = jaccard(tokens(listing.name), tokens(c.display_name));
  const sizeMatch =
    listing.size_value != null &&
    c.size_value != null &&
    listing.size_unit.toLowerCase() === c.size_unit.toLowerCase() &&
    Math.abs(listing.size_value - c.size_value) <
      Math.max(0.01, listing.size_value * 0.02)
      ? 1
      : 0;
  return brandExact * 0.4 + nameSim * 0.4 + sizeMatch * 0.2;
}

export function ComparisonFindingsView({ findings, canonicals }: Props) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [retailerFilter, setRetailerFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [matchingId, setMatchingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string>("");

  const retailers = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of findings) m.set(f.retailer_id, f.retailer_name);
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [findings]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return findings.filter((f) => {
      if (statusFilter !== "all" && f.status !== statusFilter) return false;
      if (retailerFilter !== "all" && f.retailer_id !== retailerFilter)
        return false;
      if (q) {
        const blob = `${f.name} ${f.brand} ${f.retailer_name}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [findings, statusFilter, retailerFilter, search]);

  const statusCounts = useMemo(() => {
    const out: Record<string, number> = {
      all: findings.length,
      new: 0,
      linked: 0,
      stale: 0,
      failed_extract: 0,
    };
    for (const f of findings) out[f.status] = (out[f.status] ?? 0) + 1;
    return out;
  }, [findings]);

  async function attachExisting(listingId: string, canonicalId: string) {
    setBusyId(listingId);
    setError("");
    try {
      const res = await authedFetch(
        `/api/comparison/listings/${listingId}/match`,
        {
          method: "POST",
          body: JSON.stringify({ canonical_id: canonicalId }),
        }
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error || `Match failed (${res.status})`);
        return;
      }
      setMatchingId(null);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function createNew(listing: ComparisonFindingRow) {
    setBusyId(listing.id);
    setError("");
    try {
      const res = await authedFetch(
        `/api/comparison/listings/${listing.id}/match`,
        {
          method: "POST",
          body: JSON.stringify({
            create_canonical: {
              display_name: listing.name,
              brand: listing.brand,
              size_value: listing.size_value,
              size_unit: listing.size_unit,
            },
          }),
        }
      );
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error || `Create failed (${res.status})`);
        return;
      }
      setMatchingId(null);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip
          active={statusFilter === "all"}
          onClick={() => setStatusFilter("all")}
          label={`All (${statusCounts.all})`}
        />
        <FilterChip
          active={statusFilter === "linked"}
          onClick={() => setStatusFilter("linked")}
          label={`Linked (${statusCounts.linked})`}
        />
        <FilterChip
          active={statusFilter === "new"}
          onClick={() => setStatusFilter("new")}
          label={`Unlinked (${statusCounts.new})`}
        />
        <FilterChip
          active={statusFilter === "stale"}
          onClick={() => setStatusFilter("stale")}
          label={`Stale (${statusCounts.stale})`}
        />
        {statusCounts.failed_extract > 0 && (
          <FilterChip
            active={statusFilter === "failed_extract"}
            onClick={() => setStatusFilter("failed_extract")}
            label={`Failed (${statusCounts.failed_extract})`}
          />
        )}
        <select
          value={retailerFilter}
          onChange={(e) => setRetailerFilter(e.target.value)}
          className="ml-2 text-sm h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
        >
          <option value="all">All retailers</option>
          {retailers.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, brand, retailer…"
          className="flex-1 min-w-[12rem] text-sm h-9 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
        />
      </div>

      {error && (
        <div className="text-sm text-red-600 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20">
          {error}
        </div>
      )}

      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
        {visible.length === 0 ? (
          <div className="p-10 text-center text-sm text-zinc-500">
            No findings match the current filters.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {visible.map((f) => (
              <li key={f.id} className="px-4 py-3">
                <div className="flex items-start gap-3 flex-wrap">
                  {f.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={f.image_url}
                      alt=""
                      className="w-14 h-14 rounded-lg object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <a
                        href={f.product_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-medium hover:underline truncate"
                      >
                        {f.name || "(unnamed)"}
                      </a>
                      <span
                        className={
                          "text-xs px-2 py-0.5 rounded-full " +
                          statusClasses(f.status)
                        }
                      >
                        {f.status.replace("_", " ")}
                      </span>
                      {f.gtin && (
                        <span className="text-xs text-zinc-500">
                          GTIN {f.gtin}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5 space-x-2">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        {f.retailer_name}
                      </span>
                      {f.brand && <span>· {f.brand}</span>}
                      {f.size_value != null && f.size_unit && (
                        <span>
                          · {f.size_value} {f.size_unit}
                        </span>
                      )}
                      <span>· seen {fmtRelative(f.last_seen_at)}</span>
                      {f.in_stock === false && (
                        <span className="text-red-500">· out of stock</span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-medium tabular-nums">
                      {f.price_value.toFixed(2)} {f.price_currency}
                    </div>
                    {f.unit_price_value != null && (
                      <div className="text-xs text-zinc-500 tabular-nums">
                        {f.unit_price_value.toFixed(2)} {f.price_currency}{" "}
                        {f.unit_price_basis}
                      </div>
                    )}
                  </div>
                </div>

                {/* Inline match action — only for unlinked listings. */}
                {!f.canonical_id && (
                  <div className="mt-2 pl-0 sm:pl-[68px]">
                    {matchingId === f.id ? (
                      <MatchPanel
                        listing={f}
                        canonicals={canonicals}
                        busy={busyId === f.id}
                        onAttach={(cid) => attachExisting(f.id, cid)}
                        onCreate={() => createNew(f)}
                        onCancel={() => setMatchingId(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setMatchingId(f.id)}
                        className="text-xs text-zinc-600 dark:text-zinc-400 hover:underline"
                      >
                        Link to canonical →
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-xs px-3 h-8 rounded-lg border transition-colors " +
        (active
          ? "bg-zinc-900 text-white border-zinc-900 dark:bg-white dark:text-black dark:border-white"
          : "border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-900")
      }
    >
      {label}
    </button>
  );
}

function MatchPanel({
  listing,
  canonicals,
  busy,
  onAttach,
  onCreate,
  onCancel,
}: {
  listing: ComparisonFindingRow;
  canonicals: CanonicalOption[];
  busy: boolean;
  onAttach: (canonicalId: string) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");

  const suggestions = useMemo(() => {
    return canonicals
      .map((c) => ({ c, s: scoreCanonical(listing, c) }))
      .filter((x) => x.s > 0.2)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((x) => x.c);
  }, [canonicals, listing]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return canonicals
      .filter((c) =>
        (c.display_name + " " + c.brand).toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [canonicals, query]);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 p-3 space-y-2">
      {suggestions.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
            Suggestions
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={busy}
                onClick={() => onAttach(c.id)}
                className="text-xs px-3 h-7 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50"
              >
                {c.display_name}
                {c.brand && <span className="text-zinc-500"> · {c.brand}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search existing canonicals…"
          className="flex-1 min-w-0 h-8 px-3 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
        />
        <button
          type="button"
          disabled={busy}
          onClick={onCreate}
          className="text-xs px-3 h-8 rounded-lg bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 disabled:opacity-50"
        >
          {busy ? "…" : "Create new"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-2 h-8 text-zinc-600 dark:text-zinc-400 hover:underline"
        >
          Cancel
        </button>
      </div>

      {filtered.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={busy}
              onClick={() => onAttach(c.id)}
              className="text-xs px-3 h-7 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50"
            >
              {c.display_name}
              {c.brand && <span className="text-zinc-500"> · {c.brand}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
