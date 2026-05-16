export function ComingSoon({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
        <div className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md mx-auto">
          {description}
        </div>
        <div className="mt-4 text-xs text-zinc-500">
          Landing in an upcoming phase.
        </div>
      </div>
    </>
  );
}
