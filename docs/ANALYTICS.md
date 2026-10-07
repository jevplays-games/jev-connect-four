# Analytics, evidence and interpretation

## Scope

This implementation captures the full application-visible match and decision trail, with detailed derived summaries and exports. “Exhaustive” refers to that instrumented surface, **not** exhaustive search of the entire Connect Four game tree, collection of private user activity, or access to the model's hidden reasoning.

The authoritative records are server-owned. The browser cannot submit a score. Local practice has its own explicitly unverified evidence. Client performance reporting is off by default, numerical, opt-in, and irrelevant to results.

## Access levels

| View | Access | Coverage |
|---|---|---|
| Current-match dashboard/export | Match owner or local practice owner | All retained events for the selected match |
| My recent history | Session owner; Discord identity persists ownership across sessions | 100 matches by default, at most 200 per summary; total/included/limited flags are returned |
| History listing | Match owner | Signed keyset pagination; equal timestamps handled using match ID |
| World leaderboard | Public | Eligible results in the selected cohort only |
| Channel/Server leaderboard | Logged-in account with unexpired matching launch proof | Eligible results attributed to that context |
| Operator analytics | Discord IDs explicitly allowlisted in `ADMIN_DISCORD_IDS` | Thirty-day aggregate view; most recent 10,000 decision events, sample cap disclosed; no user identities |

Owner exports contain game and model evidence, not OAuth credentials. They should still be treated as private game histories. The application does not automatically publish replays.

## Eight export tables

The same `public/analytics.js` module supplies browser analytics, server responses and CLI reports.

| Table | Grain | Important columns |
|---|---|---|
| `matches` | One match | ID, difficulty, opponent version, human disc, ranked/eligible flags, status, result, adjudication, start/end, plies, diagnostic status |
| `moves` | One accepted move | Ply, actor, zero-based column/row, pre/post-state hash, associated decision ID, elapsed wall time, deterministic tactical metrics |
| `decisions` | One completed or failed decision | Source, decision actor, selected column, model, preparation/inference time, candidate counts, questions, payload bytes, utility/gap, tokens, estimated cost, hashes, error code |
| `candidates` | One legal candidate per recorded decision | Landing row, eligibility, exclusion reason, tactical bounds, nodes/leaves/cutoffs/depth, budget exhaustion, immediate reply count, supported/unsupported threats, utility, selected flag |
| `questions` | One answered factor for each evaluated candidate | Factor, score, normalized score, weight, confidence, entropy, probabilities p0…p4, selected flag |
| `attempts` | One external HTTP attempt | Attempt number, HTTP status, failure category, latency, reported usage, retry information where recorded |
| `events` | One audit event | Sequence, UTC milliseconds, event type, previous hash and hash; full payload is in JSON/NDJSON rather than repeated in this compact CSV |
| `clientMetrics` | One optional browser report | Trust label, received time, render/request/residual timing, long-task count/duration, hidden-page duration, viewport dimensions, input method |

CSV object-valued columns such as tactical metrics are JSON-encoded. All text is quoted and formula-leading user strings are escaped for spreadsheet safety. Empty CSV means there are no rows for that table. CSV is a derived view, not enough by itself for a full hash-chain audit.

Every derived row includes match ID and core cohort labels. `decisionActor` is normally `jev` in the application. Benchmark rows distinguish `policy` and `baseline`; this matters for self-play and two-model experiments. Benchmark opening moves carry `openingMove=true`.

## Event lifecycle

```text
match.started
  move.accepted (human)
  decision.prepared
  decision.completed OR decision.failed
  move.accepted (JEV, only after a valid completed decision)
  ...
match.completed OR match.adjudicated OR service.interrupted
match.verified (completed/adjudicated only)
```

An opening JEV turn can follow `match.started` immediately. A single eligible tactical candidate records a completed `tactical` decision and zero model requests. Invalid/stale browser commands do not become game moves; fixed-label operation counters record rejection categories. The rejection body is not logged wholesale.

Each persisted event contains `schemaVersion`, match ID, monotonically increasing sequence, UTC milliseconds, type, payload, previous hash and SHA-256 hash over canonical JSON. Monotonic `performance.now()` measures in-process durations. Sequence numbers, not UTC time or cross-process monotonic clocks, establish match ordering.

`decision.prepared` persists the normalized board, finite candidate set, exact computed features, tactical analysis, complete typed question request, pinned model/profile, request byte count, request hash and preparation duration **before** contacting the provider.

`decision.completed` records the validated response, answer distributions, ranked utilities, winning tie-break selection, actual model identifier, response hash, attempts and usage. Failure events record safe bounded error codes and observed attempts, not raw secrets or arbitrary provider exception text.

## Outcome statistics

All primary official outcome statistics use **eligible completed or adjudicated results**. Practice results and interruptions are excluded from the official denominator.

```text
N = wins + losses + draws
result rate = (wins + 0.5 × draws) / N
win rate = wins / N
```

A zero denominator produces null, rendered as a dash. Resignation and a disclosed 24-hour deadline are adjudicated losses, not fake four-in-a-row states. Confirmed service interruption has no result. Practice completions, practice wins, losses and draws are separate fields.

The summary also reports active matches, interruptions, adjudications, completed games and current/best winning streak. Draws and losses break a winning streak. Streak ordering uses completion time and match ID. Leaderboard streaks and ranks are calculated within their cohort.

A Wilson 95% interval is included for **binary wins**, counting draws as non-wins. It is not an interval for half-point result rate. Repeated play by the same person, repeated openings, selection bias and adaptive learning violate simple independent-sample assumptions; the interval is descriptive and not a claim of experimental validity.

The funnel is starts → at least one accepted move → at least one actual model decision → completion → eligible result. Model-evaluated count deliberately excludes purely tactical games. Funnel levels are observations, not user-retention tracking across the web.

## Comparison cohorts

Never mix difficulty, opponent version, human starting disc and ranked/practice mode when interpreting performance. Model/profile/rules changes create a new opponent hash. Pricing changes do not change the opponent identity. Server-side prices remain frozen in each manifest for historical accounting.

The public ranking requires at least 20 games for placement; smaller samples are provisional. Result rate is the primary ordering, followed by wins and games played; exact statistical ties share a dense rank. The threshold is a product rule, not a guarantee of statistical confidence.

A channel/server match remains attributed to its verified launch context; a user cannot edit arbitrary channel IDs into a result. Community grant expiry does not erase legitimate historical results.

## Tactical quality

These measurements come from deterministic rules, not a model's self-report:

| Metric | Definition/denominator |
|---|---|
| Immediate-win opportunities | Turns on which at least one legal drop immediately wins for the actor |
| Immediate-win conversion | Taken immediate wins / immediate-win opportunities |
| Missed immediate wins | An immediate win existed and the actor did not take one |
| Blockable threat turns | Opponent had an immediate winning reply and at least one safe alternative existed |
| Threats neutralized / block rate | Blockable threat turns neutralized, including taking a winning move; divide by blockable threat turns |
| Avoidable immediate losses | Selected move permits an immediate winning reply while a safe alternative existed |
| Center preference | Placements in zero-based column 3 / accepted moves |
| Playable threats after a move | Winning completion squares currently supported by gravity |
| Unsupported threats | Winning completion squares whose required support is not present |
| Column distribution | Accepted placements per actor in columns 0…6 |
| Placement heatmap | Accepted placements by actor in all 42 cells; storage is bottom-row-first, display top-row-first |

Do not infer full-game optimality from these indicators. A strategic sacrifice, an unavoidable loss, a delayed threat and a game-theoretic blunder are different things. The UI explicitly describes its quality panel as immediate tactical observations rather than a solver rating.

## Candidate/search evidence

Each legal root move records an interval from the side-to-move opponent's perspective: `[-1,-1]` proven loss, `[0,0]` draw, `[1,1]` win, or a possibly wider unresolved interval. Search cutoffs remain unknown, not draws.

If a proven winner exists, retain proven winners. Otherwise remove proven losing candidates only if alternatives remain. Easy mode uses only immediate-win support. Local fallback also applies an explicitly local positional heuristic; it is not logged as JEV.

Node counts, leaf counts, cutoffs, maximum observed depth and per-candidate budget exhaustion are exported. Depth and budgets are profile-specific and recorded in the manifest. Candidate exclusion reasons and legal/eligible candidate count distributions make invisible tactical assistance measurable.

## Typed answer analysis

JEV scores five ordered levels for each factor. The adapter validates finite numeric values, required keys, pinned model, probability normalization, legend and score consistency. It normalizes the score into 0…1 and applies the versioned profile weights.

`utilityGap` is selected composite utility minus runner-up utility among the ranked candidates. It is not an advantage in discs, Elo points, percentage-point win probability or a calibrated margin. The deterministic tie order is columns 3,2,4,1,5,0,6.

Confidence is retained as **provider certainty about a typed answer**. Entropy is calculated from that answer's discrete distribution in bits. Summary confidence/entropy describe selected-candidate factors; raw tables retain all evaluated candidates. Neither is secretly converted to a probability of winning. A highly confident wrong judgment remains possible.

## Reliability and timing

Record completed/failed decisions, failure rate, decision source counts, failure reasons, provider attempts, retries, failed attempts and HTTP-status counts. Tactical bypasses count as decisions, not provider calls. A retry consumes another provider-attempt quota slot.

Latency summaries contain count, minimum, maximum, mean, p50, p90, p95 and p99. Quantiles linearly interpolate at index `(n−1)×p` over sorted finite observations. Empty sets return null statistics. The distributions cover model decision latency, individual HTTP attempts, feature/search preparation, human wall-turn time, completed match duration and game length in plies.

Server human-turn elapsed time includes idle time and network delay, not only human reasoning. Browser `inputDelayMs` is a residual application timing estimate, not a browser Event Timing/INP measurement. Request/render timing and long-task observations are device-reported and untrusted. The browser's optional counters are submitted after a turn, not continuously streamed.

Provider calls have a three-second decision budget and at most one bounded retry, taken for supported overload/transient statuses or for a reply that decodes but fails typed validation (for example `JEV_SCORE_INCONSISTENT`); the rejected reply is recorded as a failed attempt and never used. An expired decision lease interrupts the match; the application does not reroll a lost remote answer after a process crash and claim it was the same decision.

## Tokens and estimated cost

Input/output tokens come from validated provider usage. Known estimated charges use the per-match configured rate:

```text
estimated charge = reported tokens × configured USD per million / 1,000,000
```

The example input rate is an editable planning value, not a guarantee of your current bill. Missing or invalid responses may still have incurred provider charges. `attemptsWithUnknownBilling` preserves this uncertainty. A false `allModelPricesConfigured` flag means the estimate must not be treated as a complete cost. Output pricing is configurable separately and defaults to zero. Hosting, storage, failed-call invoices, taxes and other charges are excluded.

Zero model calls in local play are real zero calls; they do not imply free live JEV service. The fixture's mock token counts are synthetic and labeled accordingly.

## Retention, privacy and integrity

Diagnostic events default to 90 days. Afterwards signed-in users retain compact replay/result records, but deep evidence is marked `pruned` and full offline audit returns an explicit incompleteness result. Guest matches are removed after the diagnostic retention cutoff. Client metrics expire after seven days. Expired tickets, grants, sessions and counters are cleaned up. Scheduled cleanup is bounded per invocation for pending deadline processing.

Account deletion cascades owned matches and evidence. Backups, logs outside this application and hosting-provider retention need a separate operator policy. No chat content, message history, email address, raw IP address or user-generated text is sent to JEV. Abuse quotas use keyed daily identifiers rather than storing raw IPs in game analytics.

The event chain detects corruption or changes relative to the retained tip. It does **not** prove to a third party that a database administrator has not rewritten both the history and its tip. Live provider calls and database writes also cannot form one atomic transaction; a process crash can leave an attempted request without its response. The implementation marks that interruption rather than filling gaps with fabricated evidence.

## Commands and files

```sh
npm run audit -- examples/mock-provider-match-audit.json
npm run audit -- saved-replay.json --replay-only
npm run report -- first-match-audit.json second-match-audit.json --out report
npm run report -- examples/offline-benchmark/runs.json --out benchmark-report
```

`report.html` is a self-contained visual summary except for adjacent CSV/JSON download links. It does not contact JEV, Discord or a tracking service. The report's generic official W/L/D totals remain zero for unranked benchmark runs; the benchmark's own `summary.json` reports policy-perspective outcomes separately.

To create a complete longitudinal report beyond the recent-history cap, paginate `/api/history`, export each owned match while its diagnostics are retained, and pass those exports to the report command. No hidden cap is presented as all-time exhaustive data.
