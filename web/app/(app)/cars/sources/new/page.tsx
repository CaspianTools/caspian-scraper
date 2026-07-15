import Link from "next/link";
import { CarSourceForm } from "@/components/CarSourceForm";
import { emptyCarSourceInitial } from "@/components/carSourceFormDefaults";

export const dynamic = "force-dynamic";

export default function NewCarSourcePage() {
  return (
    <>
      <Link
        href="/cars/sources"
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Sources
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">Add car source</h2>
      <CarSourceForm initial={emptyCarSourceInitial()} />
    </>
  );
}
