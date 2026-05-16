import { ComingSoon } from "@/components/ComingSoon";

export default function DestinationsPage() {
  return (
    <ComingSoon
      title="Destinations"
      description="API endpoints to POST scraped findings to. Each destination has a base URL, an auth header config, and references a secret holding the API key. The scraper builds payloads using a field map you configure here."
    />
  );
}
