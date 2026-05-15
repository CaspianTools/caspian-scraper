# caspian-scraper web (Phase 1: scaffold + auth)

Next.js 16 app deployed to Firebase App Hosting. Replaces the static
dashboard at [../docs/](../docs/) over a 4-phase rollout.

## Status

Phase 1 (this commit): scaffold + auth. Sign in with GitHub via Firebase
Auth, land on a protected home page that detects your fork of
caspian-scraper.

Subsequent phases: read-only feature parity, employers CRUD, lessons
browser, retire `docs/`.

## Auth model

**No custom GitHub App.** We use Firebase Authentication's built-in
**GitHub provider**, which is itself wired up using a standard GitHub
OAuth App. At sign-in, Firebase returns:

1. A Firebase user identity (used for Firestore access + session cookie).
2. The user's GitHub OAuth access token, with the scopes we requested
   (`repo` + `workflow`).

We capture that access token at sign-in time and stash it in the user's
Firestore doc. Every server-side route reads it back and calls the
GitHub REST API on the user's behalf — no installation tokens, no
GitHub App private key.

```
[Browser]                    [Firebase Auth]     [GitHub OAuth]   [Our /api]
  Sign in with GitHub  ───────────▶
                              OAuth popup ─────────▶ user approves
                              ◀────────────────────── code + access_token
   user + ghToken     ◀─────
   POST /api/auth/session-login {idToken, ghToken} ────────────────▶
                                                                   verify idToken
                                                                   store ghToken in
                                                                   /users/{uid}
                                                                   Set-Cookie __session
   ◀───────────────────────────────────────────────────────────────
   subsequent fetches use the cookie; server reads ghToken from Firestore
```

## One-time setup

You need to set up two cloud resources.

### 1. Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Project name: `caspian-scraper` (or anything; the project ID is what matters).
3. **Authentication** → **Sign-in method** → enable **GitHub**.
   - Firebase will show you a callback URL like:
     `https://<project-id>.firebaseapp.com/__/auth/handler`.
   - **Copy that URL** — you'll paste it into GitHub in step 2.
4. **Firestore** → Create database → Production mode → pick a region.
5. **Project Settings** → **General** → "Your apps" → register a **Web** app.
   Copy the config values into `.env.local` (see step 3).
6. **Project Settings** → **Service accounts** → **Generate new private key** (JSON).
   You'll paste three fields from this JSON into `.env.local`.
7. From `web/`, deploy the security rules:
   `npx firebase deploy --only firestore:rules --project <project-id>`.

### 2. GitHub OAuth App (Firebase Auth provider)

This is a **GitHub OAuth App**, *not* a GitHub App (different things on
GitHub). Setup is simpler.

1. Go to [github.com/settings/applications/new](https://github.com/settings/applications/new) (Settings → Developer settings → OAuth Apps → New OAuth App).
2. **Application name**: `caspian-scraper-web`.
3. **Homepage URL**: your app URL (`http://localhost:3000` for dev).
4. **Authorization callback URL**: paste the URL Firebase showed you in
   step 1.3 (looks like `https://<project-id>.firebaseapp.com/__/auth/handler`).
5. Click Register. On the next page note the **Client ID** and generate a
   **Client secret**.
6. Back in Firebase Auth → GitHub provider, paste the Client ID + Client
   secret. Save.
7. (Important) On the GitHub OAuth App page, you can later add additional
   callback URLs for staging/production Firebase Auth domains.

### 3. Fill in `.env.local`

```bash
cp .env.local.example .env.local
# Edit .env.local with values from step 1.
```

For `FIREBASE_PRIVATE_KEY`, paste the PEM as a single line with `\n` in
place of newlines:

```powershell
# From PowerShell
$pem = Get-Content path\to\firebase-adminsdk-*.json | ConvertFrom-Json
$pem.private_key.Replace("`n", "\n")
```

## Local dev

```bash
cd web
npm run dev
# → http://localhost:3000
```

1. Land on `/signin`.
2. Click **Sign in with GitHub** → GitHub OAuth popup → approve.
3. Browser is sent to `/` → app detects your fork of caspian-scraper
   under your GitHub username → placeholder dashboard.

If no fork is found, you'll be prompted to create one.

## Deploy to Firebase App Hosting

1. Install Firebase CLI: `npm install -g firebase-tools`.
2. `firebase login`.
3. From the repo root: `firebase init apphosting` (choose `web/` as the
   app root, pick your project).
4. Create secrets in Google Secret Manager for each `secret:` reference
   in [apphosting.yaml](apphosting.yaml):
   `firebase apphosting:secrets:set FIREBASE_PROJECT_ID --project <project-id>`.
5. Deploy: `firebase deploy --only apphosting`.
6. Once you have the production domain, **add it as an additional
   callback URL** on the GitHub OAuth App page (step 2.4 above).

## Files

```
web/
├── apphosting.yaml          Firebase App Hosting config
├── firestore.rules          Firestore security rules
├── .env.local.example       Template for local dev env vars
├── proxy.ts                 Auth-aware redirect for un-signed-in users
├── app/
│   ├── layout.tsx           Root layout
│   ├── page.tsx             Protected home (Phase 2 will add real content)
│   ├── signin/page.tsx      GitHub sign-in
│   └── api/auth/
│       ├── session-login/   POST: trade ID token + ghToken for session cookie
│       └── session-logout/  POST: clear session cookie
└── lib/
    ├── auth/session.ts      getSessionFromCookie / getSessionFromBearer
    ├── firebase/
    │   ├── admin.ts         Server-side: verifyIdToken, verifySessionCookie
    │   └── client.ts        Client-side: signInWithGithub, signOut
    └── github/
        ├── app.ts           Per-user Octokit, getFile / putFile, findUserFork
        └── config.ts        Public constants (upstream repo)
```
