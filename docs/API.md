# API reference

All routes are same-origin under `/api`. Browser JSON bodies are limited to 4 KiB. Use the cookie and CSRF token returned by `/api/me`. Mutations require `Origin`, `X-CSRF-Token` and JSON content type. Discord interactions use their own signature boundary instead.

| Route | Method | Purpose |
|---|---|---|
| `/health` | GET | Version and application liveness; not a live JEV health check |
| `/me` | GET | Identity/guest session, CSRF token, active match, available integrations and contexts |
| `/me` | DELETE | Authenticated deletion with `{"confirm":"DELETE"}` |
| `/auth/discord` | GET | Begin browser-bound authorization |
| `/auth/discord/callback` | GET | Validate state, exchange code and rotate session |
| `/logout` | POST | Revoke current application session |
| `/discord/interactions` | POST | Signed PING and `/play`; no browser CSRF token |
| `/context/redeem` | POST | `{ticket}`; stage before sign-in or consume after identity match |
| `/matches` | POST | Allocate authoritative JEV match |
| `/matches/:id` | GET | Owner snapshot and expiry/resume state |
| `/matches/:id/commands` | POST | Owner drop/resume/resign |
| `/matches/:id/replay` | GET | Compact legal action sequence and ending/adjudication |
| `/matches/:id/export` | GET | Owner full JSON, NDJSON events, or one CSV table |
| `/matches/:id/analytics` | GET | Summary, eight tables and offline audit result |
| `/matches/:id/telemetry` | POST | Optional bounded client performance, explicitly unverified |
| `/history` | GET | Owned matches with signed keyset cursor |
| `/analytics/me` | GET | Recent owned match summaries and declared sample cap |
| `/analytics/operator` | GET | Allowlisted aggregate operator view |
| `/leaderboard` | GET | World or proof-bound community result cohort |

## Create and command

Creation and commands require an `Idempotency-Key` of 8–100 URL-safe identifier characters. Reusing the key with different content conflicts. A response is an authoritative snapshot; callers must replace provisional state with it.

```json
{"difficulty":"normal","ranked":false,"humanDisc":1}
```

Ranked creation requires Discord login. The backend assigns its starting side. Optional `contextId` must refer to this account's live server-issued proof. `difficulty` is one of `easy`, `normal`, `hard`, `jev`. Provider configuration is server-controlled. All server matches require a JEV key; local practice remains entirely separate.

```json
{"type":"drop","column":3,"expectedRevision":0,"expectedStateHash":"hash-from-snapshot"}
```

`resign` uses revision/hash without a column. `resume` retrieves/continues the current pending flow without authorizing another human move. Terminal or stale commands fail rather than modifying the board. A 409 signals conflict; fetch the current snapshot. A 429 indicates a configured budget/rate limit.

## Export formats

```text
/api/matches/ID/export
/api/matches/ID/export?format=ndjson
/api/matches/ID/export?format=csv&table=questions
```

Allowed tables are `matches`, `moves`, `decisions`, `candidates`, `questions`, `attempts`, `events`, `clientMetrics`. The owner check applies even when the match finished. Uploaded local histories cannot be submitted here for ranking.

## History and leaderboard queries

`/history?limit=100&cursor=...` caps each page at 200. Always pass the returned cursor unmodified; it is bound to the owner and handles equal timestamps.

`/analytics/me?limit=100` caps the detailed recent summary at 200 and returns included/total/limited metadata. It is not an all-time query.

Leaderboard parameters are `scope=world|server|channel`, `difficulty`, `humanDisc=1|2`, optional `opponentVersion`, `limit=1..100`, `contextId` for community scope, and optional `cursor`. The cursor binds the cohort, snapshot timestamp and offset. Community proof must still be unexpired on each read. The response includes available opponent versions, minimum-game rule, provisional flags and next cursor.

## Optional telemetry

```json
{"id":"random-report-id","consent":true,"requestMs":80,"renderMs":3,"inputMethod":"keyboard"}
```

Numerical whitelist: `renderMs`, `requestMs`, `inputDelayMs`, `longTaskCount`, `longTaskDurationMs`, `hiddenMs`, `viewportWidth`, `viewportHeight`. Values must be finite, nonnegative and at most 86,400,000. Input method is `keyboard`, `pointer` or `touch`. Unknown fields such as `score` are not stored. Duplicate IDs do not create additional reports.

Error responses expose stable codes and only explicitly safe details. They do not serialize raw provider responses, credentials, SQL or arbitrary exceptions.
