import Link from "next/link";
import { ComparisonSourceForm } from "@/components/ComparisonSourceForm";
import { emptyComparisonSourceInitial } from "@/components/comparisonSourceFormDefaults";

export const dynamic = "force-dynamic";

export default function NewComparisonSourcePage() {
  return (
    <>
      <Link
        href="/comparison/sources"
        className="text-sm text-zinc-600 dark:text-zinc-400 hover:underline inline-block"
      >
        ← Sources
      </Link>
      <h2 className="text-xl font-semibold tracking-tight">Add comparison source</h2>
      <ComparisonSourceForm initial={emptyComparisonSourceInitial()} />
    </>
  );
}
