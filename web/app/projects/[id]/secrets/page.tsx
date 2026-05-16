import { ComingSoon } from "@/components/ComingSoon";

export default function SecretsPage() {
  return (
    <ComingSoon
      title="Secrets"
      description="Per-project API keys and tokens. Stored in Firestore with strict access rules — write-only from this UI, never displayed back. Destinations reference secrets by name."
    />
  );
}
