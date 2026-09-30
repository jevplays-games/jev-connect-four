# Discord Activity mode

Discord can launch the game as an Activity: an iframe on `https://<DISCORD_CLIENT_ID>.discordsays.com` that Discord proxies to this Worker. The normal browser flow is unchanged; Activity mode only engages when the page URL carries Discord's `frame_id` query parameter.

## What differs inside an Activity

- **Sign-in.** The page loads the vendored Embedded App SDK (`public/vendor/discord-embedded-app-sdk.js`, `public/activity.js`), calls `authorize` (scope `identify`), and posts the code to `POST /api/activity/session`. The server exchanges it with the game's existing client credentials **without** a `redirect_uri`, upserts the user exactly as the OAuth callback does, and stores a 24-hour session. It returns a bearer token, the CSRF token and the Discord access token (for `sdk.commands.authenticate`; never stored). Only the token hash is stored.
- **Bearer sessions.** `Authorization: Bearer <64 hex>` is accepted in place of the cookie (the browser will not send the SameSite cookie in the iframe). The token is held in page memory only.
- **Origin.** Mutations normally require `Origin` = `APP_ORIGIN`. A bearer-authenticated mutation may instead come from `https://<DISCORD_CLIENT_ID>.discordsays.com`. Cookie sessions never get this exception, and CSRF is still required. `POST /api/activity/session` accepts the same two origins and is rate limited per address.
- **Framing.** Documents carry `X-Frame-Options: DENY` and `frame-ancestors 'none'`. A non-API request with `frame_id` drops `X-Frame-Options` and replaces only that directive with `https://discord.com https://ptb.discord.com https://canary.discord.com`. API responses are never frameable. The rest of the CSP (`script-src 'self'`) is untouched.
- `GET /api/activity/config` returns the public client id.

Ranked eligibility, idempotency keys, revision checks and decision provenance are unaffected; a bearer session is an ordinary server session for the same user.

## Developer Portal settings

1. Enable **Activities** for the application (Activities > Settings).
2. URL Mappings: prefix `/` -> target `connect-four.jevplay.games` (hostname only).
3. Discord creates a **Primary Entry Point** command when Activities are enabled. `npm run discord:register` only POSTs the `/play` command (create-or-update by name) and does not bulk overwrite, so the entry point survives. If you ever switch to a bulk `PUT`, include the existing Entry Point command or it will be deleted.

`DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` must be set (the same values the OAuth login uses). No new variables are needed.
