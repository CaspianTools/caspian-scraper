import { redirect } from "next/navigation";

/**
 * The old Resources page. Finding websites and picking from the library now
 * happen inside a job (its Sources / Discover); companies live in Databases.
 */
export default function OldResourcesPage() {
  redirect("/");
}
