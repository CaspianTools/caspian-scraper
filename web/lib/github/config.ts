// Public, non-sensitive GitHub App identity. The slug is the URL part of
// github.com/apps/<slug>. Only used to build the user-facing install URL.
export const GITHUB_APP_SLUG =
  process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? "caspian-scraper-app";

export const UPSTREAM_REPO = {
  owner: "CaspianTools",
  repo: "caspian-scraper",
} as const;
