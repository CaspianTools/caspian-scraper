import { redirect } from "next/navigation";

// Sign-in is disabled in local mode (lib/auth/session.ts). Old links and
// bookmarks to /signin land on the app instead.
export default function SignInPage() {
  redirect("/");
}
