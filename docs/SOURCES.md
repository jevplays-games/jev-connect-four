# Documentation sources and requirement provenance

API documentation was consulted during implementation preparation on 2026-09-22. These are source references, not claims that live integrations were successfully exercised.

| Source | Use |
|---|---|
| https://docs.typesafe.ai/api | HTTP endpoint, request envelope, typed answers, usage and overload behavior |
| https://docs.typesafe.ai/primitives/score | Ordered Score levels, distributions and instructions |
| https://docs.typesafe.ai/models | Pinned model/version configuration |
| https://docs.typesafe.ai/confidence | Distinguishing answer certainty from game-winning probability |
| https://docs.discord.com/developers/topics/oauth2 | Authorization-code sign-in, identify scope and application credentials |
| https://docs.discord.com/developers/interactions/receiving-and-responding | Interaction context and initial response requirements |
| https://docs.discord.com/developers/interactions/overview | Request-signature verification boundary |
| https://docs.discord.com/developers/interactions/application-commands | Commands without an always-connected bot process |
| https://developers.cloudflare.com/d1/worker-api/d1-database/ | D1 prepared statements and transactional batch semantics |
| https://developers.cloudflare.com/workers/static-assets/ | Assets and Worker deployment shape |
| https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ | Native cryptographic primitives |

The user-supplied “JEV Single-Page Game — Architecture & Implementation Planning Prompt,” followed by the Connect Four engineering plan and request to implement exhaustive analytics, establishes the product requirements. The implementation keeps the source's core boundary: JEV proposes; the rules engine validates; Discord establishes identity/context; the backend owns trust; only eligible verified results enter rankings.

## Requirement trace

| Requirement | Implementation |
|---|---|
| Vanilla single-page game, accessibility | `public/index.html`, `game.css`, `app.js`, browser tests |
| Shared deterministic rules | `public/rules.js`, rules tests, replay/audit |
| Structured inspectable JEV | `public/policy.js`, `server/jev.js`, provider/policy tests |
| Four difficulties | Frozen `PROFILES` and manifest in policy/matches |
| Explicit fallback | Local Worker with local/practice labels; interruption leaves official result ineligible |
| Discord identity/context | `server/auth.js`, registration script, real-crypto/stub-OAuth tests |
| Scope leaderboards | `server/leaderboard.js`, SQL cohort/streak queries and context tests |
| Score integrity | Server-owned commands, CAS/event batch, `server/audit.js` |
| Detailed analytics | `public/analytics.js`, raw event evidence, eight tables, UI and CLI reports |
| Headless benchmarking | `bench/run.mjs`, paired sides, local baselines, gated live model, bounded oracle |
| Minimal hosting | One Worker with static assets and D1; loopback native local runner |

Changes from the planning outline are explicit: detailed diagnostics justify event/command/telemetry tables; decision-lease loss interrupts instead of resampling; dev storage uses native SQLite; continuous Discord permission revocation is not implemented; actual live integrations and a full-game perfect-play benchmark remain deployment/evaluation gates.
