# Example evidence — read the labels

`mock-provider-match-audit.json` was generated through the actual Worker match API and SQLite adapter using the deterministic mock TypeSafe fixture from `tests/helpers.js`. Its legal game, event hashes, recorded typed answers and replay/provenance audit are internally consistent. It contains **no live JEV inference or real Discord account**, and it is not ranked. Its token usage and answer certainty are synthetic test values.

`mock-provider-report/` is the HTML/JSON/CSV report generated from that fixture. Open `report.html` to inspect the reporting format. It is not a production usage or billing report.

`offline-benchmark/` is an actually executed 10-pair/20-game normal local-policy versus seeded-random smoke benchmark, seed 20260922. Its outcome was 20 local-policy wins, zero losses/draws/interruptions, with zero late-endgame oracle observations. That narrow result is not a JEV quality measurement and does not establish broad strength.

The independent bounded-oracle tests use near-full legal draw positions to exercise exact solving and unknown-on-budget-exhaustion behavior. The sample benchmark itself does not reach those positions.

To regenerate:

```sh
npm run bench -- --pairs 10 --seed 20260922 --policy local --opponent random --out bench/output
npm run audit -- examples/mock-provider-match-audit.json
npm run report -- examples/mock-provider-match-audit.json --out analytics-report
```
