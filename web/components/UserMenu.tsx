/**
 * Sign-in is disabled (lib/auth/session.ts), so instead of an account menu
 * the header shows that this is the local, single-operator app.
 */
export function UserMenu() {
  return (
    <span
      title="Running on this computer — no sign-in. Data lives in data/ (committed) and local-data/ (this computer only)."
      className="text-xs px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
    >
      Local
    </span>
  );
}
