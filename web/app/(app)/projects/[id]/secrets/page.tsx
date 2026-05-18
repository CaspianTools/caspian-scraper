import { redirect } from "next/navigation";
import { getSessionFromCookie } from "@/lib/auth/session";
import { secretsCol, destinationsCol } from "@/lib/firestore/collections";
import {
  SecretsManager,
  type SecretListItem,
} from "@/components/SecretsManager";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function SecretsPage({ params }: PageProps) {
  const session = await getSessionFromCookie();
  if (!session) redirect("/signin");
  const { id } = await params;

  const [secretsSnap, destsSnap] = await Promise.all([
    secretsCol(id).get(),
    destinationsCol(id).select("name", "secret_ref").get(),
  ]);

  const secrets: SecretListItem[] = secretsSnap.docs.map((d) => {
    const data = d.data();
    const updated = data.updated_at?.toDate?.()
      ? data.updated_at.toDate().toISOString().slice(0, 19) + "Z"
      : typeof data.updated_at === "string"
      ? data.updated_at
      : "";
    return { name: d.id, updated_at: updated };
  });

  // Collect the unique secret_refs that destinations point at — these
  // are the names the user almost certainly wants to add next. Pair
  // each with the destination name(s) referencing it so the dropdown
  // can show context.
  const referenceMap = new Map<string, string[]>();
  for (const d of destsSnap.docs) {
    const data = d.data();
    const ref = (data.secret_ref as string | undefined)?.trim();
    if (!ref) continue;
    const list = referenceMap.get(ref) ?? [];
    list.push((data.name as string) || "(unnamed destination)");
    referenceMap.set(ref, list);
  }
  const referencedNames = Array.from(referenceMap.entries()).map(
    ([name, destinations]) => ({ name, destinations })
  );

  return (
    <>
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Secrets</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-2xl">
          Per-project API keys and tokens. Values are stored encrypted at
          rest and never returned by any read API — the only way to know
          a value is to replace it. Destinations reference secrets by
          name.
        </p>
      </div>
      <SecretsManager
        projectId={id}
        secrets={secrets}
        referencedNames={referencedNames}
      />
    </>
  );
}
