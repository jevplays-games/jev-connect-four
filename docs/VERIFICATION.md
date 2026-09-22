# Executed verification

Package assembled 2026-09-22. Evidence files are under `docs/verification/`; screenshots are actual rendered application UI under `docs/previews/`.

## Passed

| Check | Observed result |
|---|---|
| Native Node tests | **51 passed, 0 failed, 0 cancelled, 0 skipped** |
| Engine prefix enumeration | Every legal action sequence through depth 5: **19,608 visited prefixes**, including the empty position |
| Seeded complete playouts | **1,000** games satisfy structure/gravity/turn invariants and reproduce identically from accepted actions |
| Browser interaction checks | **6 passed** in Chromium using the inlined-asset harness described below |
| Offline paired benchmark | **20 games** completed, local normal policy versus seeded random; no model calls; 20 policy wins, zero losses/draws/interruptions |
| Benchmark oracle coverage | **0** reached eligible endgame comparisons; not interpreted as 100% optimality |
| Reference oracle unit tests | Near-full legal draw fixture solves exactly; openings and exhausted budgets remain explicitly unknown |
| Sample full audit | All four checks pass: hash chain, rules, decision provenance, outcome; **40 events / 19 accepted moves** |
| Report generation | HTML, JSON summary and eight CSV tables produced from the mock provider sample |

The sample audit used a deterministic mock TypeSafe provider. Its successful provenance check means consistency with recorded fixture answers, **not proof of live JEV inference**. Fixture output is labeled accordingly.

## Native coverage

Node's built-in coverage run reported 96.48% line, 86.65% branch and 95.63% function coverage across the files loaded by that run, **including the test files**. This is not whole-repository/browser coverage. The detailed report lists per-file counts and uncovered lines. The pure rules module had 100% line and 96.12% branch coverage in that run; the route/controller module has uncovered operational paths. Coverage alone does not establish correctness or security.

Tests exercise rules and bounded search, typed-response validation, model drift, retries/timeouts and provider-attempt quotas, signature checks with actual Ed25519 cryptography, mocked OAuth exchange/session rotation, launch ownership/reuse/expiry, community isolation, CSRF/ownership, duplicate and concurrent commands, failed CAS ghost-event prevention, replay corruption and truncation, interruption/adjudication distinctions, deletion, retention, telemetry validation and CSV formula protection.

## Browser environment and limits

The assembly environment's Chromium policy disallows navigating to URLs. That policy was not altered. Browser tests ran with `C4_INLINE_BROWSER=1`: the actual HTML/CSS/game/rules/policy/analytics source was inlined, ES module boundaries combined for loading, and the actual local-opponent Worker was loaded from a Blob. An in-memory localStorage stand-in and guest/unconfigured API responses were provided for the opaque page origin. All game interactions and visual rendering used application code.

The six checks cover a complete human/local-opponent turn, visible candidate evidence, keyboard access and the 42-cell accessible table, reduced motion, 390-pixel mobile layout without horizontal overflow, genuine local analytics, replay inspection without mutating the current match, and Hard-profile opponent-first play.

This does **not** exercise actual browser-to-server networking, deployed CSP headers, OAuth redirect navigation or Cloudflare in a browser. The default `npm run test:browser` path starts the real local server and navigates normally; run that path in your own environment. Backend tests separately invoked the actual Worker handler against native SQLite.

Browser engine: `/usr/bin/chromium`; available Playwright core build `1.57.0-beta-1764944708000`. The package pins stable Playwright 1.55.1 for your installation, which was not installed here. Native runtime tested: Node v22.16.0. CI includes a Node 24 matrix job but that job was not run in this environment.

## Unverified deployment gates

No real TypeSafe key, real Discord OAuth exchange, public Discord interaction delivery, Cloudflare deployment or remote D1 instance was used. No real JEV strength, latency, calibration or billing measurement is claimed. Mocked integration tests do not replace those live checks.

Registry DNS was unavailable, so development dependencies were not installed and no lockfile was generated. The zero-dependency local runtime and native tests did run. Wrangler compatibility, actual cloud limits/costs and production operational controls require verification after configuration. See `DEPLOYMENT.md` for the live smoke checklist.

No claim is made that every reachable Connect Four state was enumerated, that the agent is unbeatable, that rankings establish unaided human play, or that this package received an independent security audit.
