import {WINDOWS, ORDER, getLegalActions, applyAction, landingRow, boardRows} from './rules.js';
export const POLICY_VERSION = 'c4-policy-1.0.0';
export const PROFILES = Object.freeze({
  easy:   Object.freeze({depth: 1, nodes: 50, factors: {position: 1}}),
  normal: Object.freeze({depth: 2, nodes: 100, factors: {attack: .5, safety: .5}}),
  hard:   Object.freeze({depth: 4, nodes: 2000, factors: {attack: .4, safety: .4, support: .2}}),
  jev:    Object.freeze({depth: 6, nodes: 10000, factors: {attack: .35, safety: .35, support: .2, initiative: .1}})
});
export function profileFor(difficulty) {
  if (!Object.hasOwn(PROFILES, difficulty)) throw new Error('INVALID_DIFFICULTY');
  return PROFILES[difficulty];
}
export function immediateWinsReference(state, disc = state.toMove) {
  if (state.status !== 'active') return [];
  return getLegalActions(state).filter(a => applyAction({...state, toMove: disc}, a).winner === disc).map(a => a.column);
}
export function positionFeaturesReference(state, disc) {
  const opponent = 3 - disc, openWindows = {self: [0,0,0,0,0], opponent: [0,0,0,0,0]};
  const threats = {self: new Map(), opponent: new Map()};
  for (const w of WINDOWS) {
    const own = w.filter(i => state.board[i] === disc).length;
    const other = w.filter(i => state.board[i] === opponent).length;
    if (!other) openWindows.self[own]++;
    if (!own) openWindows.opponent[other]++;
    if ((own === 3 && !other) || (other === 3 && !own)) {
      const i = w.find(i => !state.board[i]), row = Math.floor(i / 7), column = i % 7;
      threats[own === 3 ? 'self' : 'opponent'].set(i, {row, column, playable: landingRow(state.board, column) === row});
    }
  }
  return {openWindows, threats: {self: [...threats.self.values()], opponent: [...threats.opponent.values()]},
    center: {self: [3,10,17,24,31,38].filter(i => state.board[i] === disc).length,
      opponent: [3,10,17,24,31,38].filter(i => state.board[i] === opponent).length},
    legalColumns: getLegalActions(state).map(a => a.column)};
}
/** Sound minimax intervals. Unsearched or budget-cut positions are unknown, never draws. */
export function tacticalBoundsReference(state, disc, depth, nodeLimit = 10000) {
  const stats = {nodes: 0, leaves: 0, cutoffs: 0, budgetExhausted: false, maxDepth: 0};
  function visit(s, left, traversed) {
    if (stats.nodes >= nodeLimit) { stats.budgetExhausted = true; return [-1, 1]; }
    stats.nodes++; stats.maxDepth = Math.max(stats.maxDepth, traversed);
    if (s.status !== 'active') { stats.leaves++; const v = s.winner ? (s.winner === disc ? 1 : -1) : 0; return [v,v]; }
    if (!left) { stats.leaves++; return [-1,1]; }
    const maximize = s.toMove === disc;
    let lo = maximize ? -1 : 1, hi = lo;
    for (const a of getLegalActions(s)) {
      const [aLo, aHi] = visit(applyAction(s,a), left - 1, traversed + 1);
      lo = maximize ? Math.max(lo,aLo) : Math.min(lo,aLo);
      hi = maximize ? Math.max(hi,aHi) : Math.min(hi,aHi);
      if ((maximize && lo === 1) || (!maximize && hi === -1)) { stats.cutoffs++; break; }
    }
    return [lo, hi];
  }
  return {bounds: visit(state, depth, 0), ...stats};
}
function buildWith(impl, state, difficulty, disc, options) {
  const profile = profileFor(difficulty);
  if (state.toMove !== disc) throw new Error('NOT_OPPONENT_TURN');
  const candidates = getLegalActions(state).map(action => {
    const after = applyAction(state, action), feature = impl.positionFeatures(after, disc);
    const search = impl.tacticalBounds(after, disc, options.noSafeguards ? 0 : profile.depth - 1, profile.nodes);
    return {id: `c${action.column}`, column: action.column, landingRow: after.lastMove.row,
      boardAfterMove: boardRows(after, disc), winsImmediately: after.winner === disc,
      humanWinningReplies: after.status === 'active' ? impl.immediateWins(after,3-disc) : [], ...feature, search,
      eligible: true, excludedReason: null};
  });
  if (!options.noSafeguards) {
    const wins = candidates.filter(c => c.search.bounds[0] === 1);
    const alternatives = candidates.filter(c => c.search.bounds[1] !== -1);
    for (const c of candidates) {
      if (wins.length && c.search.bounds[0] !== 1) { c.eligible = false; c.excludedReason = 'proven_win_available'; }
      else if (alternatives.length && c.search.bounds[1] === -1) { c.eligible = false; c.excludedReason = 'proven_loss'; }
    }
  }
  return {candidates, profile, eligible: candidates.filter(c => c.eligible)};
}
const REFERENCE_IMPL = {positionFeatures: positionFeaturesReference, tacticalBounds: tacticalBoundsReference, immediateWins: immediateWinsReference};
export function buildCandidatesReference(state, difficulty = 'normal', disc = state.toMove, options = {}) {
  return buildWith(REFERENCE_IMPL, state, difficulty, disc, options);
}
export function buildCandidates(state, difficulty = 'normal', disc = state.toMove, options = {}) {
  return buildWith(FAST_IMPL, state, difficulty, disc, options);
}

// ---- Fast implementations: flat tables, mutable board with do/undo, no per-node allocation. ----
// Each must return exactly what its *Reference counterpart returns (see tests/policy-equivalence.test.js).
const WIN_FLAT = Int8Array.from(WINDOWS.flat()), WIN_N = WINDOWS.length;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
/** True when `disc` at (c,r) is part of a run of 4+ on `b` (cell already placed). */
function wins(b, c, r, disc) {
  for (let d = 0; d < 4; d++) {
    const dc = DIRS[d][0], dr = DIRS[d][1];
    let n = 1, x = c + dc, y = r + dr;
    while (x >= 0 && x < 7 && y >= 0 && y < 6 && b[y * 7 + x] === disc) { n++; x += dc; y += dr; }
    x = c - dc; y = r - dr;
    while (x >= 0 && x < 7 && y >= 0 && y < 6 && b[y * 7 + x] === disc) { n++; x -= dc; y -= dr; }
    if (n >= 4) return true;
  }
  return false;
}
const scratch = new Int8Array(42);
function immediateWinsFast(state, disc = state.toMove) {
  if (state.status !== 'active') return [];
  const src = state.board, out = [];
  for (let i = 0; i < 42; i++) scratch[i] = src[i];
  for (let k = 0; k < 7; k++) {
    const c = ORDER[k];
    if (scratch[35 + c] !== 0) continue;
    let r = 0; while (scratch[r * 7 + c]) r++;
    scratch[r * 7 + c] = disc;
    if (wins(scratch, c, r, disc)) out.push(c);
    scratch[r * 7 + c] = 0;
  }
  return out;
}
const CENTER = [3, 10, 17, 24, 31, 38];
function positionFeaturesFast(state, disc) {
  const board = state.board, opponent = 3 - disc;
  const openSelf = [0,0,0,0,0], openOpp = [0,0,0,0,0];
  const selfSeen = new Set(), oppSeen = new Set(), selfT = [], oppT = [];
  const low = [0,0,0,0,0,0,0];
  for (let c = 0; c < 7; c++) { let r = 0; while (r < 6 && board[r * 7 + c]) r++; low[c] = r; }
  for (let w = 0, o = 0; w < WIN_N; w++, o += 4) {
    const a = WIN_FLAT[o], b = WIN_FLAT[o + 1], c = WIN_FLAT[o + 2], d = WIN_FLAT[o + 3];
    let own = 0, other = 0, v;
    v = board[a]; if (v === disc) own++; else if (v === opponent) other++;
    v = board[b]; if (v === disc) own++; else if (v === opponent) other++;
    v = board[c]; if (v === disc) own++; else if (v === opponent) other++;
    v = board[d]; if (v === disc) own++; else if (v === opponent) other++;
    if (!other) openSelf[own]++;
    if (!own) openOpp[other]++;
    if ((own === 3 && !other) || (other === 3 && !own)) {
      const i = !board[a] ? a : !board[b] ? b : !board[c] ? c : d, row = Math.floor(i / 7), column = i % 7;
      const seen = own === 3 ? selfSeen : oppSeen;
      if (!seen.has(i)) { seen.add(i); (own === 3 ? selfT : oppT).push({row, column, playable: low[column] === row}); }
    }
  }
  let cs = 0, co = 0;
  for (let k = 0; k < 6; k++) { const v = board[CENTER[k]]; if (v === disc) cs++; else if (v === opponent) co++; }
  const legalColumns = [];
  if (state.status === 'active') for (let k = 0; k < 7; k++) if (board[35 + ORDER[k]] === 0) legalColumns.push(ORDER[k]);
  return {openWindows: {self: openSelf, opponent: openOpp}, threats: {self: selfT, opponent: oppT},
    center: {self: cs, opponent: co}, legalColumns};
}
function tacticalBoundsFast(state, disc, depth, nodeLimit = 10000) {
  const stats = {nodes: 0, leaves: 0, cutoffs: 0, budgetExhausted: false, maxDepth: 0};
  const b = new Int8Array(42), h = [0,0,0,0,0,0,0];
  for (let i = 0; i < 42; i++) b[i] = state.board[i];
  for (let c = 0; c < 7; c++) { let r = 0; while (r < 6 && b[r * 7 + c]) r++; h[c] = r; }
  let hiOut = 0;
  // tv: 2 = active, otherwise the terminal value from disc's perspective.
  function visit(left, traversed, tv, toMove, ply) {
    if (stats.nodes >= nodeLimit) { stats.budgetExhausted = true; hiOut = 1; return -1; }
    stats.nodes++; if (traversed > stats.maxDepth) stats.maxDepth = traversed;
    if (tv !== 2) { stats.leaves++; hiOut = tv; return tv; }
    if (!left) { stats.leaves++; hiOut = 1; return -1; }
    const maximize = toMove === disc;
    let lo = maximize ? -1 : 1, hi = lo;
    for (let k = 0; k < 7; k++) {
      const c = ORDER[k], r = h[c];
      if (r >= 6) continue;
      b[r * 7 + c] = toMove; h[c] = r + 1;
      const won = wins(b, c, r, toMove);
      const childTv = won ? (toMove === disc ? 1 : -1) : ply + 1 === 42 ? 0 : 2;
      const aLo = visit(left - 1, traversed + 1, childTv, 3 - toMove, ply + 1), aHi = hiOut;
      b[r * 7 + c] = 0; h[c] = r;
      if (maximize) { if (aLo > lo) lo = aLo; if (aHi > hi) hi = aHi; }
      else { if (aLo < lo) lo = aLo; if (aHi < hi) hi = aHi; }
      if ((maximize && lo === 1) || (!maximize && hi === -1)) { stats.cutoffs++; break; }
    }
    hiOut = hi;
    return lo;
  }
  const rootTv = state.status === 'active' ? 2 : state.winner ? (state.winner === disc ? 1 : -1) : 0;
  const lo = visit(depth, 0, rootTv, state.toMove, state.ply), hi = hiOut;
  return {bounds: [lo, hi], ...stats};
}
const FAST_IMPL = {positionFeatures: positionFeaturesFast, tacticalBounds: tacticalBoundsFast, immediateWins: immediateWinsFast};
export const immediateWins = immediateWinsFast, positionFeatures = positionFeaturesFast, tacticalBounds = tacticalBoundsFast;
export function heuristicUtility(c) {
  return (c.winsImmediately ? 100000 : 0) - c.humanWinningReplies.length * 10000
    + c.openWindows.self[3] * 18 + c.openWindows.self[2] * 3
    - c.openWindows.opponent[3] * 22 - c.openWindows.opponent[2] * 4
    + c.center.self * 3 - c.center.opponent * 3
    + c.threats.self.filter(t => t.playable).length * 25;
}
export function localDecision(state, difficulty = 'normal', options = {}) {
  const started = performance.now(), {candidates, eligible} = buildCandidates(state,difficulty,state.toMove,options);
  if (!eligible.length) throw new Error('NO_ACTION');
  const ranked = [...eligible].sort((a,b) => heuristicUtility(b)-heuristicUtility(a) || ORDER.indexOf(a.column)-ORDER.indexOf(b.column));
  return {action: {type:'drop',column:ranked[0].column}, source:'local', candidates,
    latencyMs: performance.now()-started, candidateCount: candidates.length, eligibleCount: eligible.length,
    factors: {}, usage: null, request: null, response: null, model: null,
    reason: 'Deterministic local heuristic, not JEV'};
}
/** Immediate tactical opportunities only; no unsupported claims of optimal play. */
export function moveMetrics(before, after, column) {
  const actor = before.toMove, wins = immediateWins(before,actor), opponentThreats = immediateWins(before,3-actor);
  const allowedReplies = after.status === 'active' ? immediateWins(after,3-actor) : [];
  const safeAlternatives = getLegalActions(before).filter(a => {
    const next = applyAction(before,a);
    return next.winner === actor || next.status !== 'active' || immediateWins(next,3-actor).length === 0;
  }).map(a => a.column);
  const features = positionFeatures(after,actor);
  return {winningOptionsBefore: wins, opponentThreatsBefore: opponentThreats, allowedWinningReplies: allowedReplies,
    immediateWinAvailable: wins.length > 0, tookImmediateWin: after.winner === actor,
    missedImmediateWin: wins.length > 0 && after.winner !== actor,
    safeAlternatives, avoidableImmediateLoss: allowedReplies.length > 0 && safeAlternatives.length > 0,
    blockedThreat: opponentThreats.length > 0 && !allowedReplies.length && after.winner !== actor,
    playableThreatsAfter: features.threats.self.filter(t => t.playable).length,
    unsupportedThreatsAfter: features.threats.self.filter(t => !t.playable).length,
    centerMove: column === 3, legalCountBefore: getLegalActions(before).length,
    openWindowsAfter: features.openWindows, occupancyAfter: after.ply / 42};
}
