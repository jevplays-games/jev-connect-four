# Security and privacy boundaries

## Implemented controls

The browser sends bounded drop/resume/resign commands, not authoritative boards, scores, model names or result histories. The backend generates legal candidates, owns model requests, validates answers, revalidates the accepted action and reconstructs completed games. There is no public generic model proxy or score-submission API.

Cookie sessions are HttpOnly, SameSite=Lax and Secure with a `__Host-` name in deployment. Loopback development is the explicit non-Secure exception. Mutations require the configured Origin and a session-bound CSRF token. OAuth state is expiring, hashed, browser-bound and consumed once; successful login rotates the application session. Access and refresh tokens are not persisted.

Discord HTTP interactions use signature verification over the exact timestamp/body plus a freshness check. Application, guild installation, member and channel type are checked. Opaque launch tickets are short-lived and single-use, with the invoking Discord user and original community context stored server-side. The application does not trust browser-supplied community IDs.

SQL uses parameters. Display names are inserted with text APIs rather than HTML. Response headers disallow external scripts, framing, object content, camera, microphone and geolocation. Body sizes, legal actions, ownership, revision, idempotency keys and request budgets are bounded. Model/HTTP errors become controlled codes, not raw request or credential dumps. CSV formula prefixes are escaped.

A versioned event envelope and SHA-256 chain retain decision provenance. Prepared model inputs are written before calls. Compare-and-swap plus guarded dependent inserts prevents ghost events and duplicate moves. An expired or lost decision interrupts instead of silently re-running the model.

## What this does not establish

A legal replay and internally consistent hash chain are not cryptographic proof that a third-party provider actually supplied the stored response. A database administrator can rewrite both history and tip. Independently anchored tips or signed provider attestations are not implemented. The normal application's trust comes from owning the server and rejecting client-uploaded score histories.

The application cannot stop a human consulting another solver, using another account or receiving outside help. It is unsuitable as sole evidence of unaided play or as complete anti-fraud protection for valuable prizes.

A launch proves recent Discord participation, not continuous membership/permission validity. Revocation can lag for the remainder of the ten-minute grant. Historical result attribution remains. The command intentionally supports normal guild text channels only.

The provider side effect and D1 write are not one atomic transaction. Crash windows can leave a prepared request without a recorded result or complete billing evidence. This is surfaced as interruption/unknown billing. There is no promise of exactly-once external inference.

These automated tests are not an independent penetration test. Wrangler/D1 production behavior, live OAuth, live interactions, live JEV responses, production TLS/domain configuration and hosting abuse controls need operator verification.

## Privacy and retention

JEV receives normalized board state, exact game features and bounded typed questions only. It receives no Discord identities, names, channel information, session values, chats or OAuth credentials. The application stores only minimal account identifiers and display names, community IDs needed for attribution, game evidence and keyed quota identifiers.

Optional client telemetry is disabled by default and contains whitelisted bounded numerical measurements plus a small input-method enumeration. No third-party analytics SDK, session recorder or tracking pixel is included. Client data never determines a result.

Diagnostic events expire after the configured retention period (90 days by default). Signed-in users retain compact replay/result records with explicit `pruned` audit status; guest records are deleted at the cutoff. Client metrics expire after seven days. Account deletion cascades owned records and invalidates sessions. Hosting logs/backups are outside that deletion operation and require a separate published policy.

## Operational hardening checklist

Use unique production credentials, restrict admin IDs, review changes, keep dependencies updated, generate and review a lockfile, test backups, cap spending, monitor failure/abuse counters, and rehearse provider outages and restore procedures. Verify host rules cannot bypass the Worker or reveal database exports. Do not retain unnecessary access logs or share owner audit exports publicly by default.

Rotating `APP_SECRET` invalidates derived CSRF tokens/cursors and daily HMAC quota keys. Session token records are stored separately; delete active sessions as part of a deliberate full sign-out rotation. Changing a TypeSafe secret need not change opponent version; changing model or policy behavior must.
