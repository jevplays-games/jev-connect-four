import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState, applyAction, getLegalActions} from '../public/rules.js';
import * as P from '../public/policy.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
/** Seeded random games; yields every position along the way (including terminal ones). */
function* positions(games, seed) {
  const r = rng(seed);
  for (let g = 0; g < games; g++) {
    let s = createInitialState();
    yield s;
    while (s.status === 'active') {
      const a = getLegalActions(s);
      s = applyAction(s, a[Math.floor(r() * a.length)]);
      yield s;
    }
  }
}

test('fast immediateWins / positionFeatures / tacticalBounds equal their references', () => {
  let n = 0;
  for (const s of positions(40, 20260101)) {
    for (const disc of [1, 2]) {
      assert.deepEqual(P.immediateWins(s, disc), P.immediateWinsReference(s, disc));
      assert.deepEqual(P.positionFeatures(s, disc), P.positionFeaturesReference(s, disc));
      for (const [depth, limit] of [[0, 50], [1, 50], [3, 100], [5, 400], ...(n % 5 === 0 ? [[6, 10000]] : [])]) {
        const got = P.tacticalBounds(s, disc, depth, limit), want = P.tacticalBoundsReference(s, disc, depth, limit);
        assert.deepEqual(got, want);
        assert.equal(JSON.stringify(got), JSON.stringify(want));
      }
      n++;
    }
  }
  assert.ok(n > 1500);
});

test('buildCandidates equals buildCandidatesReference at every difficulty', () => {
  let n = 0;
  for (const s of positions(12, 77)) {
    if (s.status !== 'active') continue;
    for (const difficulty of ['easy', 'normal', 'hard', 'jev']) {
      for (const options of [{}, {noSafeguards: true}]) {
        if (difficulty === 'jev' && s.ply < 6 && !options.noSafeguards && s.ply % 3) continue;
        const got = P.buildCandidates(s, difficulty, s.toMove, options), want = P.buildCandidatesReference(s, difficulty, s.toMove, options);
        assert.equal(JSON.stringify(got), JSON.stringify(want));
        n++;
      }
    }
  }
  assert.ok(n > 500);
});
