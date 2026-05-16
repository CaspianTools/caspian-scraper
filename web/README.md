# caspian-scraper web

Next.js 16 admin UI for the HSE scraper, deployed to Firebase App Hosting
inside the `caspian-tools` Firebase project. The web app and the Python
scraper share **Firestore** as the single source of truth for employers,
runs, and lessons — no per-file JSON in the repo, no GitHub API calls.

## Architecture

```
┌─────────────────────┐                ┌──────────────────────┐
│  Browser (Next.js)  │                │  GitHub Actions cron │
│  Google sign-in     │                │  scrape.py daily run │
└──────────┬──────────┘                └──────────┬───────────┘
           │                                      │
           │  Firebase Auth ID token              │  service-account JSON
           │                                      │  (Firebase Admin SDK)
           ▼                                      ▼
   ┌────────────────────────────────────────────────────┐
   │       Firestore database  (caspian-tools/scraper)  │
   │       /employers, /lessons, /runs, /users          │
   └────────────────────────────────────────────────────┘
```

- **Auth**: Firebase Authentication, **Google sign-in only**.
- **Data**: dedicated Firestore database named `scraper` inside the
  `caspian-tools` project. Schema:
  - `/employers/{id}` — one doc per employer (replaces `employers.json`)
  - `/lessons/{auto-id}` — append-only run-level log (replaces
    `state/lessons.jsonl`)
  - `/runs/{auto-id}` — per-run summary (replaces `docs/data.json`)
  - `/users/{uid}` — profile doc, optional allowlist
- **No GitHub API**. The web app neither reads from nor writes to
  GitHub. The scraper still lives in this repo and runs as a GitHub
  Actions cron, but it writes its output directly to Firestore via the
  Firebase Admin SDK.

## One-time setup

You're filling four blanks: a Firebase web app config, a service-account
credential, an enabled Google sign-in provider, and a dedicated Firestore
database.

### 1. Register a Web app in the `caspian-tools` Firebase project

1. https://console.firebase.google.com/ → **caspian-tools** project
2. ⚙️ Project settings → **General** → "Your apps" → **`</>`** (Web)
3. App nickname: `caspian-scraper-web`. **Do not** check "Firebase
   Hosting" (we use App Hosting, not Hosting).
4. Click Register. Copy the `firebaseConfig` block. The 4 fields you need:
   - `apiKey` → `NEXT_PUBLIC_FIREBASE_API_KEY`
   - `authDomain` → `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
   - `projectId` → `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
   - `appId` → `NEXT_PUBLIC_FIREBASE_APP_ID`

### 2. Enable Google sign-in

1. Authentication → Sign-in method
2. Click **Google** → Enable
3. Project support email: pick yours → Save
4. (No other providers needed for the scraper app.)

### 3. Generate a service-account JSON

1. ⚙️ Project settings → **Service accounts** tab
2. Click **Generate new private key** → Generate key → a `.json` file
   downloads
3. Extract three fields into `.env.local`:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY` (paste the multi-line PEM as
     a single line with `\n` instead of newlines)

Delete the downloaded JSON when you're done; the values are now in
`.env.local`.

### 4. Create the dedicated `scraper` Firestore database

Firebase projects can hold multiple Firestore databases. We use a
dedicated one for clean separation from anything else in caspian-tools.

1. Build → Firestore Database
2. **Create database** (or "+" / "Add database" if one already exists)
3. Database ID: `scraper` (must match `FIRESTORE_DATABASE_ID`)
4. Location: pick the region closest to your users (cannot change later)
5. Start in **Production mode**
6. Click Create

### 5. Fill `.env.local`

```bash
cp .env.local.example .env.local
# Edit with values from steps 1 + 3.
```

For `FIREBASE_PRIVATE_KEY`, paste the PEM with explicit `\n` escapes:

```powershell
$pem = (Get-Content path\to\firebase-adminsdk-*.json | ConvertFrom-Json).private_key
$pem.Replace("`n", "\n")
```

## Local dev

```bash
cd web
npm run dev
# → http://localhost:3000
```

1. Land on `/signin`.
2. Click **Sign in with Google** → Google OAuth popup → approve.
3. Redirected to `/` → placeholder dashboard, signed in.

## Deploy to Firebase App Hosting

1. `npm install -g firebase-tools`
2. `firebase login`
3. From repo root: `firebase init apphosting` (app root: `web/`, project:
   `caspian-tools`)
4. Create secrets in Google Secret Manager for each `secret:` reference
   in [apphosting.yaml](apphosting.yaml):
   `firebase apphosting:secrets:set FIREBASE_PROJECT_ID --project caspian-tools`
   (and repeat for the other 7).
5. `firebase deploy --only apphosting`.
6. Add the deployed domain to **Authentication → Settings → Authorized
   domains** so Google sign-in works in production.

## Files

```
web/
├── apphosting.yaml          Firebase App Hosting backend config
├── firestore.rules          Firestore security rules
├── .env.local.example       Template for local env vars
├── proxy.ts                 Auth-aware middleware (redirect to /signin)
├── app/
│   ├── layout.tsx           Root layout
│   ├── page.tsx             Protected home (placeholder for now)
│   ├── signin/page.tsx      Google sign-in
│   └── api/auth/
│       ├── session-login/   POST: trade ID token for session cookie
│       └── session-logout/  POST: clear session cookie
└── lib/
    ├── auth/session.ts      getSessionFromCookie / getSessionFromBearer
    └── firebase/
        ├── admin.ts         Server-side: Admin SDK, dedicated-DB aware
        └── client.ts        Client-side: signInWithGoogle, signOut
```

## What ships next

This commit lands the auth surface. The next batches:

1. **Seed Firestore** with the existing `employers.json` data (one-off
   migration script). After this, `employers.json` in the repo root is
   archived.
2. **Employers CRUD** UI under `/employers` — list, filter, edit,
   activate/deactivate, add new.
3. **Update `scrape.py`** to read its employers list from Firestore and
   write `lessons` / `runs` documents to Firestore at end of run, using
   the same service-account credential.
4. **Lessons browser** under `/lessons` with filters + the "3+
   consecutive zero_found" alerting.
5. **Runs view** under `/runs`.
6. **Retire** `docs/dashboard.js`.
