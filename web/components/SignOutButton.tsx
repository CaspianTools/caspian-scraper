"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/firebase/client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await signOut();
        router.push("/signin");
      }}
      className="text-xs px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
    >
      Sign out
    </button>
  );
}
