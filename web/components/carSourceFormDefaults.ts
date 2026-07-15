// Shared types + defaults for the car-source form. NOT marked "use client"
// so server components (the create + edit pages) can call the factory
// without hitting the client/server boundary.

export type CarSiteValue = "opensooq" | "dubizzle" | "yallamotor";

export const CAR_SITES: { value: CarSiteValue; label: string }[] = [
  { value: "opensooq", label: "OpenSooq (Oman)" },
  { value: "dubizzle", label: "Dubizzle (Oman)" },
  { value: "yallamotor", label: "YallaMotor (Oman)" },
];

export interface CarSourceFormInitial {
  name: string;
  site: CarSiteValue;
  country: string;
  city: string;
  category: string;
  query: string;
  max_listings: number;
  with_details: boolean;
  schedule_cron: string;
  active: boolean;
  notes: string;
}

export function emptyCarSourceInitial(): CarSourceFormInitial {
  return {
    name: "",
    site: "opensooq",
    country: "om",
    city: "",
    category: "cars",
    query: "",
    max_listings: 50,
    with_details: true,
    schedule_cron: "30 4 * * *",
    active: true,
    notes: "",
  };
}
