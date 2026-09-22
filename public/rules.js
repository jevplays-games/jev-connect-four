/** One deterministic engine shared by browser, server, audit and benchmarks. */
export const COLS = 7, ROWS = 6, RULES_VERSION = 1;
export const ORDER = Object.freeze([3, 2, 4, 1, 5, 0, 6]);
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]];
export const WINDOWS = Object.freeze((() => {
  const out = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    for (const [dc, dr] of DIRECTIONS) {
      const cc = c + 3 * dc, rr = r + 3 * dr;
      if (cc >= 0 && cc < COLS && rr >= 0 && rr < ROWS)
        out.push(Object.freeze(Array.from({length: 4}, (_, i) => (r + i * dr) * COLS + c + i * dc)));
    }
  }
  return out;
})());
export function createInitialState() {
  return {rulesVersion: RULES_VERSION, board: Array(42).fill(0), ply: 0,
    toMove: 1, status: 'active', winner: null, winningCells: [], lastMove: null};
}
export function getLegalActions(state) {
  if (state.status !== 'active') return [];
  return ORDER.filter(c => state.board[35 + c] === 0).map(column => ({type: 'drop', column}));
}
export function landingRow(board, c) {
  for (let r = 0; r < ROWS; r++) if (!board[r * COLS + c]) return r;
  return -1;
}
function connected(board, c, r, disc) {
  const all = new Set();
  for (const [dc, dr] of DIRECTIONS) {
    const line = [r * COLS + c];
    for (const sign of [-1, 1]) {
      let x = c + dc * sign, y = r + dr * sign;
      while (x >= 0 && x < COLS && y >= 0 && y < ROWS && board[y * COLS + x] === disc) {
        line.push(y * COLS + x); x += dc * sign; y += dr * sign;
      }
    }
    if (line.length >= 4) line.forEach(i => all.add(i));
  }
  return [...all].sort((a, b) => a - b);
}
export function applyAction(state, action) {
  if (state.status !== 'active') throw new Error('GAME_TERMINAL');
  if (!action || action.type !== 'drop' || !Number.isInteger(action.column) || action.column < 0 || action.column > 6)
    throw new Error('INVALID_COLUMN');
  const column = action.column, row = landingRow(state.board, column);
  if (row < 0) throw new Error('COLUMN_FULL');
  const board = [...state.board], disc = state.toMove, ply = state.ply + 1;
  board[row * COLS + column] = disc;
  const winningCells = connected(board, column, row, disc);
  const status = winningCells.length ? 'win' : ply === 42 ? 'draw' : 'active';
  return {rulesVersion: RULES_VERSION, board, ply, toMove: status === 'active' ? 3 - disc : null,
    status, winner: status === 'win' ? disc : null, winningCells, lastMove: {column, row, disc}};
}
export function getOutcome(state, humanDisc = 1) {
  return state.status === 'active' ? null : state.status === 'draw' ? 'draw' : state.winner === humanDisc ? 'win' : 'loss';
}
export function replay(actions) {
  if (!Array.isArray(actions) || actions.length > 42) throw new Error('INVALID_REPLAY');
  return actions.reduce((s, c) => applyAction(s, {type: 'drop', column: c}), createInitialState());
}
export function serialize(state) { return JSON.stringify(state); }
/** Structural validation is not a proof of reachable history. Use replay for verification. */
export function deserialize(raw) {
  const s = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
  if (!s || s.rulesVersion !== 1 || !Array.isArray(s.board) || s.board.length !== 42 ||
      s.board.some(v => ![0, 1, 2].includes(v))) throw new Error('INVALID_STATE');
  const n1 = s.board.filter(v => v === 1).length, n2 = s.board.filter(v => v === 2).length;
  if (n1 < n2 || n1 > n2 + 1 || n1 + n2 !== s.ply) throw new Error('INVALID_COUNTS');
  for (let c = 0; c < 7; c++) {
    let gap = false;
    for (let r = 0; r < 6; r++) { if (!s.board[r * 7 + c]) gap = true; else if (gap) throw new Error('INVALID_GRAVITY'); }
  }
  const winners = [1, 2].filter(d => WINDOWS.some(w => w.every(i => s.board[i] === d)));
  if (winners.length > 1) throw new Error('MULTIPLE_WINNERS');
  const status = winners.length ? 'win' : s.ply === 42 ? 'draw' : 'active';
  const winner = winners[0] ?? null;
  if (s.status !== status || s.winner !== winner || s.toMove !== (status === 'active' ? (n1 === n2 ? 1 : 2) : null))
    throw new Error('INVALID_OUTCOME');
  if (winner && ((winner === 1 && n1 !== n2 + 1) || (winner === 2 && n1 !== n2))) throw new Error('INVALID_WIN_TURN');
  return s;
}
export function boardRows(state, jevDisc = 2) {
  return Array.from({length: 6}, (_, i) => state.board.slice((5 - i) * 7, (6 - i) * 7)
    .map(v => v === 0 ? '.' : v === jevDisc ? 'J' : 'H').join(''));
}
export const connectFour = {id: 'connect-four', rulesVersion: RULES_VERSION, createInitialState,
  getLegalActions, applyAction, getOutcome, serialize, deserialize, replay};
