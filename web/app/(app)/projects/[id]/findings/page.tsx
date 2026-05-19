import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import {
  destinationsCol,
  findingsCol,
} from "@/lib/firestore/collections";
import {
  FindingsView,
  type DestinationForFinding,
  type FindingRow,
} from "@/components/FindingsView";

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

export default async function FindingsPage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id } = await params;

  // Ownership enforced by parent layout. Load the most-recent 500
  // findings — covers a few thousand HSE postings comfortably; we can
  // paginate later if it grows.
  const [snap, destSnap] = await Promise.all([
    findingsCol(id).orderBy("last_seen_at", "desc").limit(500).get(),
    destinationsCol(id).get(),
  ]);

  const findings: FindingRow[] = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      title: String(data.title ?? "(untitled)"),
      employer: String(data.employer ?? ""),
      location: String(data.location ?? ""),
      country: String(data.country ?? ""),
      ats: String(data.ats ?? ""),
      source_id: String(data.source_id ?? ""),
      source_name: String(data.source_name ?? ""),
      source_url: String(data.source_url ?? ""),
      status: String(data.status ?? ""),
      first_seen_at: tsToIso(data.first_seen_at),
      last_seen_at: tsToIso(data.last_seen_at),
      attempts: Number(data.attempts ?? 0),
      destination_id: String(data.destination_id ?? ""),
      destination_response_id: String(data.destination_response_id ?? ""),
      destination_slug: String(data.destination_slug ?? ""),
      published_at: tsToIso(data.published_at),
      error: String(data.error ?? ""),
    };
  });

  const destinations: DestinationForFinding[] = destSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      item_url_template: String(data.item_url_template ?? ""),
    };
  });

  return (
    <>
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Findings</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-2xl">
          Every role the scraper has encountered, with the latest upload
          status to the destination. <strong>Published</strong> = uploaded
          successfully. <strong>Duplicate</strong> = already present on
          the destination so we skipped it. <strong>Failed</strong> = post
          was attempted but rejected (validation, auth, etc.) — see the
          error inline.
        </p>
      </div>

      <FindingsView
        projectId={id}
        findings={findings}
        destinations={destinations}
      />
    </>
  );
}
