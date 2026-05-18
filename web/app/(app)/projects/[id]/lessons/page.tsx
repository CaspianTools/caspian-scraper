import { ComingSoon } from "@/components/ComingSoon";

export default function LessonsPage() {
  return (
    <ComingSoon
      title="Lessons"
      description="Per-source verdicts across runs (ok / errors / zero_found / no_new). Filter by verdict, spot sources that stopped finding matches, surface 3+ consecutive zero_found as actionable."
    />
  );
}
