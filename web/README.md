# caspian-scraper web (Phase 1: scaffold + auth)

Next.js 16 app deployed to Firebase App Hosting. Replaces the static
dashboard at [../docs/](../docs/) over a 4-phase rollout. See the parent
[plan](../C:/Users/fuadj/.claude/plans/script-faisl-to-run-zesty-wind.md)
for the full architecture.

## Status

Phase 1 (this commit): scaffold + auth handshake. Sign in with Google,
install the GitHub App on your fork, land on a placeholder dashboard.

Subsequent phases: read-only feature parity, employers CRUD, lessons
browser, retire `docs/`.

## One-time setup

You'll need to create **two cloud resources** before this app runs:

### 1. Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Project name: `caspian-scraper` (or anything; the actual project ID is what matters).
3. Enable **Authentication** → **Sign-in method** → **Google** → Enable.
4. Enable **Firestore** → Production mode → pick a region close to you.
5. Project Settings → **General** → "Your apps" → **Web** → register an app named "caspian-scraper-web". Copy the config values; you'll paste them into `.env.local`.
6. Project Settings → **Service accounts** → **Generate new private key** → download JSON. You'll paste three fields from this JSON into `.env.local`.
7. Deploy the security rules: from `web/`, run `npx firebase deploy --only firestore:rules`.

### 2. GitHub App

1. Go to [github.com/settings/apps/new](https://github.com/settings/apps/new).
2. **App name**: `caspian-scraper-app` (must match `NEXT_PUBLIC_GITHUB_APP_SLUG` in your env).
3. **Homepage URL**: your deployed app URL (use `http://localhost:3000` for dev).
4. **Callback URL**: `<homepage>/api/auth/github/callback` (e.g. `http://localhost:3000/api/auth/github/callback`).
5. **Setup URL**: same as callback URL. Check "Redirect on update".
6. **Webhook**: disable for now (we don't ship a webhook handler in Phase 1).
7. **Permissions**:
   - Repository → **Contents**: Read & write
   - Repository → **Actions**: Read & write
   - Repository → **Secrets**: Read & write
   - Repository → **Workflows**: Read & write
   - Repository → **Metadata**: Read (mandatory)
8. **Where can this GitHub App be installed?** → "Any account" (so other users can install on their forks).
9. Create the app. From the app's settings page, note the **App ID** (numeric) and click **Generate a private key** to download the PEM file.

### 3. Fill in `.env.local`

```bash
cp .env.local.example .env.local
# Edit .env.local with values from steps 1 and 2 above.
```

For `GITHUB_APP_PRIVATE_KEY` and `FIREBASE_PRIVATE_KEY`, paste the entire
PEM contents as a single line with `\n` in place of newlines. Easy way:

```powershell
# From PowerShell
$pem = Get-Content path\to\caspian-scraper-app.pem -Raw
$escaped = $pem.Replace("`r`n", "\n").Replace("`n", "\n")
"GITHUB_APP_PRIVATE_KEY=`"$escaped`""
```

## Local dev

```bash
cd web
npm run dev
# → http://localhost:3000
```

Sign in with Google → click "Install on GitHub" → pick your fork →
GitHub redirects back to `/api/auth/github/callback` → you land on `/`
with your fork + installation_id stored in Firestore.

## Deploy to Firebase App Hosting

1. Install Firebase CLI: `npm install -g firebase-tools`.
2. `firebase login`.
3. From the repo root: `firebase init apphosting` (choose `web/` as the
   app root, pick your project, region near you).
4. Create secrets in Google Secret Manager for each `secret:` reference
   in [apphosting.yaml](apphosting.yaml). The Firebase CLI can help:
   `firebase apphosting:secrets:set GITHUB_APP_ID --project <project-id>`.
5. Deploy: `firebase deploy --only apphosting`.
6. Update your GitHub App's Callback/Setup URLs to point at the
   deployed domain.

## Architecture in a nutshell

- **Auth**: Firebase Auth (Google) on the frontend, session cookie minted
  by `/api/auth/session-login`. GitHub App on the backend mints
  installation tokens per user via `lib/github/app.ts`.
- **Tenancy**: multi-tenant. Each Firebase UID maps to one GitHub App
  installation_id (= one fork) in Firestore at `/users/{uid}`.
- **Source of truth**: the GitHub repo. Firestore holds only the
  uid↔installation_id mapping and per-user UI prefs.
- **Writes**: every mutation goes through a server-side Route Handler
  that mints a fresh installation token. Browser never sees a GitHub
  token.

## Files

```
web/
├── apphosting.yaml          Firebase App Hosting config
├── firestore.rules          Firestore security rules
├── .env.local.example       Template for local dev env vars
├── proxy.ts                 Auth redirect for un-signed-in users
├── app/
│   ├── layout.tsx           Root layout
│   ├── page.tsx             Protected home (Phase 2 will add real content)
│   ├── signin/page.tsx      Google sign-in
│   └── api/auth/
│       ├── session-login/   POST: trade ID token for session cookie
│       ├── session-logout/  POST: clear session cookie
│       └── github/callback/ GET: link installation_id to Firebase UID
└── lib/
    ├── firebase/
    │   ├── admin.ts         Server-side: verifyIdToken, mintSessionCookie
    │   └── client.ts        Client-side: signInWithGoogle, signOut
    └── github/
        ├── app.ts           Installation-token minting + getFile / putFile
        └── config.ts        Public constants (app slug, upstream repo)
```
