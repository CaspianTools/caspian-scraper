import Link from "next/link";
import {
  carSourcesCol,
  genericSourcesCol,
  sourcesCol,
} from "@/lib/firestore/collections";
import { listResources } from "@/lib/firestore/resources";
import { databaseRecords, listDatabases } from "@/lib/databases";
import { requireJob } from "@/lib/jobs";
import { pricesJobScope } from "@/app/api/comparison/jobScope";
import { SourcesTable, type SourceRow } from "@/components/SourcesTable";
import { OpenQuickAddButton } from "@/components/quick-add/OpenQuickAddButton";
import { SharedResourcesPanel } from "@/components/resources/SharedResourcesPanel";
import { SourceSection } from "@/components/job-sources/SourceSection";
import { EngineSourcesTable, type EngineSourceRow } from "@/components/job-sources/EngineSourcesTable";
import { ExpandableEmptySection } from "@/components/job-sources/ExpandableEmptySection";
import { ReadsFromEditor, type ReadsFromEntry } from "@/components/job-sources/ReadsFromEditor";
import { addButtonClasses, millis } from "@/components/job-sources/format";
import type { DocumentData } from "@/lib/localdb";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

/** Careers-page platforms the vacancy engine can parse (scrape.PARSERS). */
const SUPPORTED_ATS = new Set(["successfactors", "jibe"]);

/** Records of a database the vacancy engine would scrape for this entry —
 *  the same rule as scrape.database_sources: not hidden, a careers page on a
 *  supported platform, and (when tags are given) any of them, ignoring case. */
function qualifyingCount(records: Record<string, unknown>[], onlyTags: string[]): number {
  const only = new Set(onlyTags.map((t) => t.toLowerCase()));
  return records.filter((r) => {
    if (r.hidden || !r.careers_url) return false;
    if (!SUPPORTED_ATS.has(String(r.ats ?? "").toLowerCase())) return false;
    if (only.size === 0) return true;
    const tags = Array.isArray(r.tags) ? r.tags : [];
    return tags.some((t) => only.has(String(t).toLowerCase()));
  }).length;
}

function lastCount(data: DocumentData, key: string): number {
  const s = data.last_run_summary as Record<string, unknown> | null | undefined;
  return s && typeof s === "object" ? Number(s[key] ?? 0) : 0;
}

/**
 * A job's Sources: everything a run scrapes, by engine — careers pages (the
 * job's own projects/{id}/sources + shared library resource_ids), databases
 * it reads careers pages from (reads_from), classifieds sites (car_sources),
 * shops (comparison_sources) and any-website scrapes (generic_sources), the
 * last three matched by project_id. Each section links to the engine's own
 * add / edit pages.
 */
export default async function SourcesListPage({ params }: PageProps) {
  const { id } = await params;
  const job = await requireJob(id);
  const base = `/projects/${job.id}`;

  const [snap, library, databases, carSnap, priceScope, genericSnap] = await Promise.all([
    sourcesCol(id).orderBy("created_at", "desc").get(),
    listResources(job.uid),
    listDatabases(job.uid),
    carSourcesCol().where("owner_uid", "==", job.uid).get(),
    pricesJobScope(job.uid, job.id),
    genericSourcesCol().where("owner_uid", "==", job.uid).get(),
  ]);

  // ----- Careers pages -----
  const rawIds = job.data.resource_ids;
  const attachedIds: string[] = Array.isArray(rawIds) ? rawIds : [];
  const sources: SourceRow[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      name: data.name ?? "(unnamed)",
      kind: data.kind ?? "employer",
      ats: data.ats ?? "unknown",
      careers_url: data.careers_url ?? "",
      active: data.active !== false,
      countries: Array.isArray(data.countries) ? data.countries : [],
    };
  });

  // ----- From databases -----
  const readsFrom: ReadsFromEntry[] = job.settings.reads_from.map((spec) => {
    const db = databases.find((d) => d.id === spec.database);
    let records: Record<string, unknown>[] = [];
    try {
      records = databaseRecords(spec.database);
    } catch {
      records = [];
    }
    const onlyTags = Array.isArray(spec.only_tags) ? spec.only_tags : [];
    return {
      database: spec.database,
      only_tags: onlyTags,
      name: db?.name ?? spec.database,
      // The scraper reads db/<id>.jsonl even without a config entry.
      exists: !!db || records.length > 0,
      qualifying: qualifyingCount(records, onlyTags),
    };
  });

  // ----- Classifieds sites / shops / any website -----
  const byCreated = (a: DocumentData, b: DocumentData) => millis(b.created_at) - millis(a.created_at);

  const carRows: EngineSourceRow[] = carSnap.docs
    .filter((d) => d.data().project_id === job.id)
    .sort((a, b) => byCreated(a.data(), b.data()))
    .map((d) => {
      const data = d.data();
      return {
        id: d.id,
        href: `${base}/cars/sources/${d.id}`,
        name: String(data.name ?? "(unnamed)"),
        detail: data.query ? `“${String(data.query)}”` : "",
        site: String(data.site ?? ""),
        active: data.active !== false,
        lastRunMs: millis(data.last_run_at),
        lastCount: lastCount(data, "found"),
      };
    });

  const shopRows: EngineSourceRow[] = priceScope.sources.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      href: `${base}/prices/sources/${d.id}`,
      name: String(data.name ?? "(unnamed)"),
      detail: String(data.home_url ?? ""),
      site: String(data.retailer_id ?? ""),
      active: data.active !== false,
      lastRunMs: millis(data.last_run_at),
      lastCount: lastCount(data, "extracted"),
    };
  });

  const webRows: EngineSourceRow[] = genericSnap.docs
    .filter((d) => d.data().project_id === job.id)
    .sort((a, b) => byCreated(a.data(), b.data()))
    .map((d) => {
      const data = d.data();
      const urls = Array.isArray(data.start_urls) ? (data.start_urls as unknown[]).map(String) : [];
      let host = "";
      try {
        host = urls[0] ? new URL(urls[0]).hostname : "";
      } catch {
        host = "";
      }
      return {
        id: d.id,
        href: `${base}/data/sources/${d.id}`,
        name: String(data.name ?? "(unnamed)"),
        detail: urls[0] ? urls[0] + (urls.length > 1 ? ` (+${urls.length - 1} more)` : "") : "",
        site: host,
        active: data.active !== false,
        lastRunMs: millis(data.last_run_at),
        lastCount: lastCount(data, "found"),
      };
    });

  const careersCount = sources.length + attachedIds.length;
  const total = careersCount + readsFrom.length + carRows.length + shopRows.length + webRows.length;

  const careersBlurb = (
    <>
      Company careers pages on a platform the scraper can read (
      <code className="text-xs">successfactors</code>, <code className="text-xs">jibe</code>):
      websites from the shared library, plus pages only this job uses.
    </>
  );
  const careersAdd = (
    <OpenQuickAddButton kind="source" projectId={id} variant="secondary" size="sm">
      + Add careers page
    </OpenQuickAddButton>
  );
  // The shared-library panel is also where library websites are attached.
  const sharedPanel = (
    <SharedResourcesPanel
      projectId={id}
      library={library}
      attachedIds={attachedIds}
      ownSourcesCount={sources.length}
    />
  );

  return (
    <>
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Sources</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-2xl">
          {total === 0
            ? "Nothing to scrape yet — add a source of any kind below."
            : "Everything this job scrapes. Each run goes through every active source below and gathers what it finds into Results."}
        </p>
      </div>

      {careersCount === 0 ? (
        <ExpandableEmptySection
          title="Careers pages"
          blurb={careersBlurb}
          action={careersAdd}
          expandLabel="Attach from library…"
        >
          {sharedPanel}
        </ExpandableEmptySection>
      ) : (
        <SourceSection title="Careers pages" count={careersCount} blurb={careersBlurb} action={careersAdd}>
          {sharedPanel}
          {sources.length === 0 ? (
            <p className="text-sm text-zinc-500 px-1">
              No careers pages of this job&apos;s own — it only uses shared resources.
            </p>
          ) : (
            <>
              <h4 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 px-1 pt-1">
                Only this job ({sources.length})
              </h4>
              <SourcesTable projectId={id} sources={sources} />
            </>
          )}
        </SourceSection>
      )}

      <ReadsFromEditor
        projectId={id}
        entries={readsFrom}
        databases={databases.map((d) => ({ id: d.id, name: d.name, count: d.count }))}
      />

      <SourceSection
        title="Classifieds sites"
        count={carRows.length}
        empty={carRows.length === 0}
        blurb="Listings from car classifieds (OpenSooq, Dubizzle, YallaMotor) for a country, city and search."
        action={
          <Link href={`${base}/cars/sources/new`} className={addButtonClasses}>
            + Add classifieds site
          </Link>
        }
      >
        <EngineSourcesTable rows={carRows} siteLabel="Site" countLabel="Found" />
      </SourceSection>

      <SourceSection
        title="Shops"
        count={shopRows.length}
        empty={shopRows.length === 0}
        blurb="A shop's category or listing pages and how to read a product from them; the same product is matched across shops."
        action={
          <Link href={`${base}/prices/sources/new`} className={addButtonClasses}>
            + Add shop
          </Link>
        }
      >
        <EngineSourcesTable rows={shopRows} siteLabel="Retailer" countLabel="Extracted" />
      </SourceSection>

      <SourceSection
        title="Any website"
        count={webRows.length}
        empty={webRows.length === 0}
        blurb="Describe a site and the fields to collect; the scraper setup is proposed, checked against the live page and saved once you approve it."
        action={
          <Link href={`${base}/data`} className={addButtonClasses}>
            + New website scrape
          </Link>
        }
      >
        <EngineSourcesTable rows={webRows} siteLabel="Site" countLabel="Found" />
      </SourceSection>
    </>
  );
}
