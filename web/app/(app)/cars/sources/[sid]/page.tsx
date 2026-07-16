import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { carSourcesCol } from "@/lib/firestore/collections";
import { CarSourceForm } from "@/components/CarSourceForm";
import type {
  CarSourceFormInitial,
  CarSiteValue,
} from "@/components/carSourceFormDefaults";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ sid: string }>;
}

export default async function EditCarSourcePage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { sid } = await params;

  const snap = await carSourcesCol().doc(sid).get();
  if (!snap.exists) notFound();
  const data = snap.data();
  if (!data || data.owner_uid !== session.uid) notFound();

  const site = String(data.site ?? "opensooq") as CarSiteValue;
  const initial: CarSourceFormInitial = {
    name: String(data.name ?? ""),
    site,
    country: String(data.country ?? "om"),
    city: String(data.city ?? ""),
    category: String(data.category ?? "cars"),
    query: String(data.query ?? ""),
    max_listings: Number(data.max_listings ?? 50),
    with_details: data.with_details !== false,
    posted_within_days: Number(data.posted_within_days ?? 1),
    schedule_cron: String(data.schedule_cron ?? "30 4 * * *"),
    active: data.active !== false,
    notes: String(data.notes ?? ""),
  };

  return (
    <>
      <Link
        href="/cars/sources"
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Sources
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">
        Edit {initial.name || "source"}
      </h2>
      <CarSourceForm initial={initial} sourceId={sid} />
    </>
  );
}
