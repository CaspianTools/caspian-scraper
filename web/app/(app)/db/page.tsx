import { redirect } from "next/navigation";

/** The old Findings DB page is now the Companies database. */
export default function OldFindingsDbPage() {
  redirect("/databases/companies");
}
