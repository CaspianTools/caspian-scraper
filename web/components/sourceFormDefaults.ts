// Shared types + defaults for the source form. NOT marked "use client"
// so that server components (e.g. the create page) can import the
// factory function without hitting the client/server boundary.

export interface SourceFormInitial {
  name: string;
  kind: "employer" | "agency" | "feed";
  ats: "successfactors" | "jibe" | "unknown";
  careers_url: string;
  active: boolean;
  countries: string[];
  segment: string;
  headquarters: string;
  website: string;
  linkedin: string;
  notes: string;
}

export function emptySourceFormInitial(): SourceFormInitial {
  return {
    name: "",
    kind: "employer",
    ats: "unknown",
    careers_url: "",
    active: true,
    countries: [],
    segment: "",
    headquarters: "",
    website: "",
    linkedin: "",
    notes: "",
  };
}
