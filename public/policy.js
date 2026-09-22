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
export function immediateWins(state, disc = state.toMove) {
  if (state.status !== 'active') return [];
  return getLegalActions(state).filter(a => applyAction({...state, toMove: disc}, a).winner === disc).map(a => a.column);
}
export function positionFeatures(state, disc) {
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
export function tacticalBounds(state, disc, depth, nodeLimit = 10000) {
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
export function buildCandidates(state, difficulty = 'normal', disc = state.toMove, options = {}) {
  const profile = profileFor(difficulty);
  if (state.toMove !== disc) throw new Error('NOT_OPPONENT_TURN');
  const candidates = getLegalActions(state).map(action => {
    const after = applyAction(state, action), feature = positionFeatures(after, disc);
    const search = tacticalBounds(after, disc, options.noSafeguards ? 0 : profile.depth - 1, profile.nodes);
    return {id: `c${action.column}`, column: action.column, landingRow: after.lastMove.row,
      boardAfterMove: boardRows(after, disc), winsImmediately: after.winner === disc,
      humanWinningReplies: after.status === 'active' ? immediateWins(after,3-disc) : [], ...feature, search,
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
