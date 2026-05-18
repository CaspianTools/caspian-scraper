import Link from "next/link";

export interface TrendBarRun {
  id: string;
  status: string;
  started_at: string;
  found: number;
  published: number;
  errors_count: number;
}

interface Props {
  projectId: string;
  runs: TrendBarRun[];
}

const HEIGHT = 80;
const BAR_W = 18;
const BAR_GAP = 6;

function statusBarColor(s: string): string {
  switch (s) {
    case "ok":
      return "fill-emerald-500 dark:fill-emerald-400";
    case "partial":
      return "fill-amber-500 dark:fill-amber-400";
    case "running":
      return "fill-blue-400 dark:fill-blue-400";
    case "error":
    case "auth_halt":
      return "fill-red-500 dark:fill-red-400";
    default:
      return "fill-zinc-400 dark:fill-zinc-500";
  }
}

/**
 * Tiny inline-SVG trend chart. One bar per run (oldest left, newest
 * right). Bar height encodes `found` count; colour encodes status.
 * Each bar is a Link to the run detail page; the title attribute
 * gives a hover summary.
 */
export function TrendBars({ projectId, runs }: Props) {
  if (runs.length === 0) {
    return (
      <div className="text-sm text-zinc-500 text-center py-8">
        No runs yet. The first scheduled or ad-hoc run will appear here.
      </div>
    );
  }

  const max = Math.max(1, ...runs.map((r) => r.found));
  const width = runs.length * (BAR_W + BAR_GAP) - BAR_GAP;

  return (
    <svg
      viewBox={`0 0 ${width} ${HEIGHT}`}
      width={width}
      height={HEIGHT}
      className="block max-w-full"
      role="img"
      aria-label={`Trend of the last ${runs.length} runs`}
    >
      {runs.map((r, i) => {
        // For runs with 0 found, still draw a 2px stub so the colour /
        // status is visible.
        const h = Math.max(2, Math.round((r.found / max) * (HEIGHT - 4)));
        const x = i * (BAR_W + BAR_GAP);
        const y = HEIGHT - h;
        const when = r.started_at
          ? r.started_at.replace("T", " ").slice(0, 16) + " UTC"
          : "";
        return (
          <Link
            key={r.id}
            href={`/projects/${projectId}/runs/${r.id}`}
            className="cursor-pointer"
          >
            <g>
              <rect
                x={x}
                y={y}
                width={BAR_W}
                height={h}
                rx={2}
                className={statusBarColor(r.status)}
              />
              <title>
                {`${when} · ${r.status}\n${r.found} found · ${r.published} published · ${r.errors_count} err`}
              </title>
            </g>
          </Link>
        );
      })}
    </svg>
  );
}
