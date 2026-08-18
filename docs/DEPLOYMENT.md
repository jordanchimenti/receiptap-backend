# Deploying ReceipTap

First deploy, written for someone who hasn't done one before. Target is
Railway, because the Privacy Policy already names Railway as the app host and
`server.js` is already written for it.

**Honest scope note:** everything in the "already handled" and "what changed"
sections below was verified by actually running it — booting the app,
migrating a real Postgres, logging in, restarting, and confirming the session
survived. Everything in the Railway-dashboard steps was **not** tested from
here, because that requires your Railway account. Treat those as a checklist
to follow, not as proven-working.

---

## Already handled, don't re-solve these

- **HTTPS behind Railway's proxy.** `server.js:18` sets `trust proxy`.
  Without it, Express thinks every request is plain HTTP, express-session
  refuses to send a Secure cookie, and login appears to succeed while the
  browser never receives a cookie. Already there.
- **Migrations run on deploy.** `npm start` is
  `npx prisma migrate deploy && node server.js`, so schema changes apply
  automatically on each deploy, before the server accepts traffic.
- **The process survives errors.** `server.js:25-30` catches
  `unhandledRejection` and `uncaughtException` so one bad request can't take
  the whole site down.

---

## What changed to make deploying possible

### Sessions moved to Postgres

`express-session` was using its built-in in-memory store. On a real host that
means **every merchant and shopper is logged out on every single deploy**, and
memory grows forever because nothing evicts old entries.

Sessions now live in Postgres (`lib/sessionStore.js`), in a table called
`session` that's created automatically on first boot. Nothing to run by hand.

That table is deliberately **not** in `prisma/schema.prisma` — it belongs to
`connect-pg-simple`, which owns its own column layout. Verified that
`prisma migrate status` still reports "Database schema is up to date!" with
the table present, so it does not confuse migrations.

It opens a second, small connection pool (max 3) alongside Prisma's. That's
the thing CLAUDE.md's Prisma gotcha warns about, so the cap is deliberate —
see the comment in `lib/sessionStore.js`.

### Uploads moved off the ephemeral disk

Logos and profile photos were written inside the repo checkout, which Railway
replaces wholesale on every deploy. Since logos print on receipts, every
merchant's receipts would silently lose their branding each time you shipped.

Both now write to whatever `UPLOAD_DIR` points at (`lib/uploadPaths.js`), and
`server.js` serves `/uploads/...` from that same root. **URLs already stored
in the database don't change** — they're relative paths like
`/uploads/logos/abc.png`, so existing rows keep working.

Unset, it falls back to `public/uploads/` so local development is unchanged.

### The app refuses to boot unsafely

`SESSION_SECRET` had a fallback value hardcoded in this public repo. Anyone
reading the source could have forged a session cookie for any merchant. In
production the app now exits with a clear message rather than starting up
looking fine while wide open. Verified: it exits with code 1.

### Added

- `railway.json` — build/deploy config, health check, `numReplicas: 1`.
- `/healthz` — what Railway pings to decide a deploy came up. Deliberately
  does **not** touch the database: it answers "did the process boot," and a
  database blip shouldn't make Railway tear down a healthy container.
- `engines: node 22.x` in `package.json`, so Railway doesn't pick a different
  major version than you develop on.
- `.env.example` now documents **all 27** environment variables the app
  reads. It previously covered 11, so more than half were undocumented.

---

## Why exactly one instance

`railway.json` pins `numReplicas: 1`. Do not raise it. Two independent
reasons:

1. A Railway volume attaches to one instance. Two instances = two different
   disks = a logo uploaded on one is a broken image on the other.
2. The daily retention purge and the affiliate-payout scheduler are both
   in-memory `setInterval` timers with no shared lock (CLAUDE.md, "Not done
   yet"). A second instance runs its own duplicate copy of both.

Scaling past one instance means moving uploads to object storage **and**
moving those jobs to a real cron service. Not a config change.

---

## Deploy steps

### 1. Create the Railway project

Point it at the GitHub repo. Railway detects Node and reads `railway.json`.

### 2. Pick the region — BEFORE you create the volume

Service → **Settings → Scale → Regions**.

Do this first. Changing a service's region *after* a volume is attached
forces Railway to migrate the volume, which takes time proportional to its
size and causes downtime. Picking first costs nothing; reordering these two
steps costs an outage.

**There is no Canadian region.** Railway has exactly four:

| Region | Identifier | Location |
|---|---|---|
| US West | `us-west2` | California, USA |
| US East | `us-east4-eqdc4a` | Virginia, USA |
| EU West | `europe-west4-drams3a` | Amsterdam, Netherlands |
| Southeast Asia | `asia-southeast1-eqsg3a` | Singapore |

This is not just a latency choice — **it changes what your Privacy Policy and
DPA have to say.** Both currently state that ReceipTap data is stored in
Canada, naming only Google, Anthropic, Resend and the POS providers as
touching it outside Canada. The database genuinely is in Canada (Supabase,
`ca-central-1`, Montreal), but the app server will not be, in any of the four
options — and every request, session cookie, and database result passes
through it. So whichever you pick, those paragraphs become inaccurate as
written and need rewriting, plus a `PRIVACY.version` and `DPA.version` bump.
See `docs/LEGAL_REVIEW_NOTES.md` item 5.

US East is the closest to Montreal of the four, if latency to the database is
the deciding factor. That's a technical observation, not a legal one — a US
region still means US jurisdiction over the app server.

Note: there is **no** `railway.json` field for a single region — it's a
dashboard setting only. (`multiRegionConfig` in the schema is for running
replicas in several regions at once, which this app can't do; see "Why
exactly one instance" above.)

### 3. Add the volume

In the service → **Settings → Volumes** → add one, mount path `/data`.

Then set `UPLOAD_DIR=/data/uploads`. Skip this and uploads work fine right up
until your first redeploy silently erases them.

### 4. Set the environment variables

Work from `.env.example` — it lists all 27 with notes on where each comes
from. The ones that must be right on day one:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase **session pooler** host, not the direct db host (CLAUDE.md gotcha — the direct host won't connect) |
| `SESSION_SECRET` | `openssl rand -base64 32`. App won't boot without it in production |
| `APP_BASE_URL` | Your real domain. Without it, shared links get built with whatever host served the page |
| `UPLOAD_DIR` | `/data/uploads`, matching the volume above |
| `NODE_ENV` | `production` — this is also what turns on the Secure session cookie |

Leave `RETENTION_PURGE_ENABLED` unset. Live purging has never run; per
CLAUDE.md it should sit in dry-run and have its `PurgeLog` output reviewed
first.

### 5. Deploy, then confirm it came up

- `https://your-domain/healthz` returns `{"ok":true}`
- The deploy log shows migrations applied, then
  `ReceipTap backend running on...`
- Sign up for an account, then **redeploy** and confirm you're still logged
  in. That's the session fix doing its job.

---

## After the first deploy: update every external dashboard

This is the step that's easy to forget and breaks things silently. Every
service below currently points at an ngrok tunnel or localhost.

**OAuth redirect URIs** — add `https://your-domain` + the path in each
provider's developer console:

| Provider | Path |
|---|---|
| Square | `/oauth/square/callback` |
| Clover | `/oauth/clover/callback` |
| Lightspeed | `/oauth/lightspeed/callback` |
| Shopify | `/oauth/shopify/callback` |

**Webhook URLs:**

| Provider | Path | Notes |
|---|---|---|
| Square | `/webhooks/pos/square` | Also set `SQUARE_WEBHOOK_URL` to this **exact** string. Square's HMAC covers the notification URL, so a trailing-slash difference makes every signature fail |
| Clover | `/webhooks/pos/clover` | |
| Shopify | `/webhooks/pos/shopify` | Compliance webhooks go to `/webhooks/pos/shopify/compliance` |
| Stripe | `/webhooks/stripe` | |
| Lightspeed | — | Registered automatically per merchant at connect time, no dashboard step |

**Google Sign-In:** add your domain to Authorized JavaScript origins.

**Stripe:** a webhook secret has still never been configured. Until it is,
the subscription gate polls Stripe instead (max once per 10 min per
merchant). Setting `STRIPE_WEBHOOK_SECRET` now that there's a stable URL
would remove that workaround.

**Pucks already printed:** `PUCK_BASE_URL` is separate from `APP_BASE_URL`
precisely because a QR code stuck to a physical puck can never be changed.
If any pucks were printed against an old URL, that URL has to keep working.

---

## Known risk: PDF export may fail on Railway

`package.json` runs `playwright install chromium` on postinstall. That
downloads the browser but **not** the system libraries Chromium needs, and
Railway's default Nixpacks image may not include them. The download
succeeding means the build passes and the failure shows up at runtime
instead.

It only affects bulk PDF export (`routes/pdf-export.js`), which already
catches the error and returns a 500 for that one request — it cannot take the
app down. So deploy first, then test `/dashboard/receipts/pdf-export`.

If it fails, the fix is a `nixpacks.toml` adding Chromium's system
dependencies, or switching the builder to a Dockerfile based on Playwright's
official image. I couldn't test which is needed without a real Railway build,
so I haven't guessed at config that might break the build on its own.

---

## Still not addressed by this work

- The legal pages have open `[[REVIEW]]` items and aren't launch-ready. See
  `docs/LEGAL_REVIEW_NOTES.md`. Deploying doesn't change that.
- The Privacy Policy and DPA both still say data is held in Canada. Now that
  it's confirmed Railway has no Canadian region, that's known to be wrong
  about the app server regardless of which region you choose — it needs a
  real rewrite and a version bump on both documents, not just a blank filled
  in. Item 5 in `LEGAL_REVIEW_NOTES.md` has the detail.
- Live data purging stays off.
