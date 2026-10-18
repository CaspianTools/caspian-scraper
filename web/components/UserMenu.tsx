"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { signOut } from "@/lib/firebase/client";
import type { UserSession } from "@/lib/auth/session";

interface Props {
  session: Pick<UserSession, "email" | "name" | "picture">;
}

export function UserMenu({ session }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      router.push("/signin");
      router.refresh();
    } finally {
      setSigningOut(false);
      setOpen(false);
    }
  }

  const initial = (session.name || session.email || "?").trim().charAt(0).toUpperCase();
  const label = session.name || session.email || "Signed in";

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open user menu"
        onClick={() => setOpen((v) => !v)}
        className="w-9 h-9 rounded-full overflow-hidden ring-2 ring-transparent hover:ring-zinc-300 dark:hover:ring-zinc-700 transition focus:outline-none focus:ring-zinc-400 dark:focus:ring-zinc-500"
      >
        {session.picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={session.picture}
            alt=""
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="w-full h-full bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 flex items-center justify-center text-sm font-medium">
            {initial}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 w-72 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-xl z-50 overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
            <div className="font-medium text-sm truncate" title={label}>
              {label}
            </div>
            {session.email && session.name && session.email !== session.name && (
              <div className="text-xs text-zinc-500 truncate" title={session.email}>
                {session.email}
              </div>
            )}
          </div>
          <ul className="py-1 text-sm">
            <li>
              <Link
                href="/"
                onClick={() => setOpen(false)}
                className="block px-4 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-900"
                role="menuitem"
              >
                Projects
              </Link>
            </li>
            <li>
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="block w-full text-left px-4 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
                role="menuitem"
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
