# Deployment and configuration

## Local development

Use Node 22.16 or newer. Run `npm start`, then open `http://localhost:8787`. The local server binds to IPv4 loopback and persists SQLite under `.data/`. Opening the same site through a different host spelling can fail the strict Origin check; use the printed URL. Copy `.env.example` to `.env` for customization. Keep `.env` out of version control and shared archives.

The startup command reads `.env` when present. No package installation is necessary for local play, native tests, CLI reporting, auditing or offline benchmarks. `.data/local-secret` is generated for development only; use a distinct production secret. The Node SQLite experimental warning is expected on the version tested.

The local server is not intended to be exposed through a public interface or reverse proxy. Back up the local SQLite database only with a consistent SQLite backup procedure; do not copy an actively written database and ignore its WAL.

## Configuration reference

| Variable | Purpose |
|---|---|
| `APP_ORIGIN` | Exact canonical browser origin; include scheme and local port when applicable |
| `APP_SECRET` | At least 32 characters; production random secret for session-bound HMAC uses, abuse keys and cursors |
| `TYPESAFE_API_KEY` | Server-only JEV bearer credential |
| `JEV_MODEL` | Pinned model name; initial profile uses `jev-1.13.0` |
| `DISCORD_CLIENT_ID` | Application ID, not secret |
| `DISCORD_CLIENT_SECRET` | Server-only OAuth/client-credentials secret |
| `DISCORD_PUBLIC_KEY` | Discord application's verification public key |
| `ADMIN_DISCORD_IDS` | Comma-separated exact IDs for aggregate operator access; empty disables access |
| `JEV_INPUT_USD_PER_MILLION` | Explicit estimated input rate stored in match manifests |
| `JEV_OUTPUT_USD_PER_MILLION` | Optional output rate; defaults to zero |
| `GUEST_DAILY_MATCH_LIMIT` | Default 3 JEV match allocations per daily abuse bucket |
| `USER_DAILY_MATCH_LIMIT` | Default 30 JEV match allocations per account/day |
| `GLOBAL_DAILY_JEV_CALL_LIMIT` | Default 3,000 HTTP attempts/day, including retries |
| `AUDIT_RETENTION_DAYS` | Default 90; diagnostic retention and guest-history cutoff |
| `PORT` | Local server only, default 8787 |

A single ranked active game per account is enforced separately. Session issuance has an additional daily abuse limit. Client telemetry has a session/day cap. These are initial operating policies, not a substitute for host-level abuse protection.

## GoDaddy Node.js hosting

The same Worker `fetch` handler runs on plain Node through `scripts/dev.mjs` when `NODE_ENV=production`. The platform runs `npm run build` (a no-op) then `npm start`, which loads `.env` from the zip root (real process variables win).

- Listens on `PORT` (injected by the host) at `HOST` (default `0.0.0.0`). TLS is terminated by the proxy.
- Worker-equivalent environment: `DEV_LOCAL` is not set, so ranked play, Discord interactions, OAuth and the Activity are enabled and cookies are `Secure`. Startup fails without `APP_ORIGIN` and an `APP_SECRET` of 32+ characters.
- Required: `APP_ORIGIN` (`https://connect-four.jevplay.games`), `APP_SECRET`, `TYPESAFE_API_KEY`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_PUBLIC_KEY`. Optional: `HOST`, `DB_FILE`, `TRUST_PROXY`, `ADMIN_DISCORD_IDS` and the limit variables above.
- `TRUST_PROXY=1` takes the client address for abuse buckets from the last `X-Forwarded-For` entry; with `0` every visitor shares the proxy address and so one guest quota. The request URL is always built from `APP_ORIGIN`; the CSRF `Origin` checks still compare against it.
- SQLite lives at `data/connect-four.sqlite` (private, never under `public/`). The filesystem is ephemeral: matches, sessions and the ranked leaderboard are lost on redeploy.
- The Cloudflare cron is replaced by an in-process 60-second timer running the same cleanup/expiry handler.

## Cloudflare Worker and D1

The provided `wrangler.jsonc` is a deployment template, not an already deployed instance.

```sh
npm install
npx wrangler login
npx wrangler d1 create jev-connect-four
```

Replace `database_id` with the returned ID. Set the actual `APP_ORIGIN` in `wrangler.jsonc` and configure the corresponding Worker/custom domain. Do not leave placeholder values. The asset binding is `ASSETS`, the database binding is `DB`.

```sh
npm run db:remote
npx wrangler secret put APP_SECRET
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler secret put DISCORD_CLIENT_SECRET
```

Add `DISCORD_CLIENT_ID`, `DISCORD_PUBLIC_KEY` and optional admin IDs to Worker vars. Only the client secret and private API key are credentials; the public key is not a secret. Then deploy:

```sh
npm run deploy
```

The template executes the Worker before static assets so response security headers apply consistently. Responses currently use `Cache-Control: no-store`; do not assume an asset-cache performance gain before configuring and testing one. There is no browser service worker or guaranteed first-load offline support.

The CPU limit in the template is 1,000 ms. Verify that your account/plan accepts it and measure the hardest policy's CPU before launch. Worker CPU, wall-time, memory, D1 query/storage constraints and actual costs were not exercised here. Detailed audit rows make storage materially larger than compact move logs; inspect representative exports and size the budget accordingly.

The cron runs every fifteen minutes. It adjudicates bounded batches of expired matches/leases and deletes expired transient records and diagnostics. Read requests can also apply match expiry. Establish D1 backups, restoration tests, billing limits, log retention and real operational alerts separately.

## Discord application

In your Discord application settings:

1. Add the exact OAuth redirect URI `https://YOUR_HOST/api/auth/discord/callback` (or the identical local origin for local testing).
2. Set the interactions endpoint to `https://YOUR_HOST/api/discord/interactions`. Discord must reach it over the configured public HTTPS host.
3. Configure guild installation with `applications.commands`; the user sign-in flow requests only `identify`.
4. Put the ID, secret and verification public key in the appropriate server configuration.
5. Run the registration script with the credentials loaded locally:

```sh
npm run discord:register
```

The script obtains application credentials for command registration and upserts `/play`. Install the app into a test guild, invoke `/play` in a normal text channel and open its ephemeral launch link. Sign in as the invoking user. Another account must not be able to redeem the ticket.

Direct OAuth login proves identity but supplies no Channel/Server proof by itself. A fresh `/play` launch supplies that proof for ten minutes. DMs, threads and user-installed/non-guild interactions are intentionally unsupported in this first version.

## Required live smoke test

Before admitting public ranked play, verify the health endpoint, static assets and policy headers; a real typed JEV response; a guest match; OAuth consent/callback/session rotation; a signed Discord launch; wrong-user ticket rejection; a complete ranked match; replay/provenance audit; one and only one eligible leaderboard result in each applicable scope; context expiry; account deletion; controlled provider failure; and deadline cleanup.

A model alias or response-schema change must not silently enter the existing cohort. Pin and re-evaluate a new model/profile. Update the profile version whenever behavior changes. Do not enter a production key in the browser or commit it with the ZIP.

## Reproducible tooling

Direct development dependencies are pinned in `package.json`; no lockfile is bundled because registry access was unavailable during creation. After obtaining dependencies, review/install them and commit the generated lockfile in your own repository. The supplied CI currently uses `npm install` for its browser job; switch to `npm ci` once you have a reviewed lockfile.
