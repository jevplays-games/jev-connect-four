# Headless benchmark protocol

The runner uses the same rules, candidate policy and JEV adapter as the game. It does not launch a browser or affect production leaderboards.

## Offline smoke run

```sh
npm run bench -- --pairs 10 --seed 20260922 --policy local --opponent random --difficulty normal --out bench/output
```

Supported policy: `local`, `jev`, `random`. Supported opponent: `random`, `heuristic`, `search`, `jev`. Each opening group runs twice with policy sides swapped. Seed, prefix, side and configuration are saved. Prefix lengths cycle from zero to four moves. Prefix moves are marked and must be excluded from agent decision metrics.

`heuristic` uses the normal local policy, `search` uses the hard local policy, and `local` uses the selected difficulty. These are distinct reference configurations, not independent perfect solvers. Local and seeded random logical actions are reproducible; IDs, timestamps and latency are not guaranteed bitwise identical.

## Live JEV, deliberately gated

```sh
npm run bench -- --pairs 10 --policy jev --opponent search --difficulty jev --allow-paid --out bench/live
npm run bench -- --pairs 10 --policy jev --opponent jev --difficulty normal --allow-paid --out bench/self-play
npm run bench -- --pairs 10 --policy jev --opponent search --no-safeguards --allow-paid --out bench/ablation
```

Set `TYPESAFE_API_KEY` and a pinned `JEV_MODEL` in the environment or `.env`. The runner refuses a live model without **both** a key and `--allow-paid`. Runs are bounded by pairs (1…1,000), 42 plies per game and bounded calls; they can still incur meaningful charges. Start with one pair. CLI runs do not use the application's global daily database quota; manage your benchmark budget separately.

A provider failure records an interrupted run rather than silently substituting another opponent. The benchmark is sequential; there is no unbounded concurrency or infinite optimization loop.

## Output

`summary.json` reports policy-perspective W/L/D, interruptions, by-side counts, mean paired result score, a seeded 1,000-resample paired bootstrap interval, endgame oracle coverage and generic evidence telemetry. `results.csv` retains one row per game. `runs.json` holds full evidence bundles; `events.ndjson` and eight CSV tables support analysis. `oracle.csv` records exact/unknown coverage and selected-action comparison.

Generic tables use the application convention `human = baseline`, `jev = tested policy`, even when neither is a model. `decisionActor` distinguishes policy/baseline model decisions. Generic official outcome aggregates stay zero because benchmarks are unranked. Read `summary.json.results` for the benchmark outcomes.

## Reference endgame oracle

`oracle.mjs` is a separate bounded minimax implementation sharing the rules engine. Default maximum is eight empty cells and 200,000 visited nodes. It reports an exact result only if the relevant search completes; otherwise it explicitly reports unknown. `--oracle-empty 0..10` controls evaluation eligibility.

Selected-action optimality and value loss are measured only at completely searched endgames. A run with no such positions has **zero oracle coverage**, not perfect oracle accuracy. This is not a complete independent full-game solver or proof of unbeatable JEV play.

## Interpretation and next experiments

The included 20-game local-vs-random run is a functional smoke test. It is not a blinded, held-out, population-level or publishable quality study. The reference opponents share code, the opening set is small, player adaptation is absent, and repeat games within groups are dependent.

For a substantive experiment, freeze policy/model/request version, pre-register opening and position corpora, group mirrored/transposed positions before train/test splitting, run side-paired baselines and safeguard ablations, report interruptions and actual costs, and add an independent externally validated full-game solver where required. Choice-versus-Score ablations, calibration optimization and automatic repeated-position studies are not implemented by this runner; do not describe them as completed experiments.
