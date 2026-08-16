import { gitLedger } from 'pleach/adapters/git';
import { scriptedAuditResult, scriptedRunner } from 'pleach/adapters/scripted';
import type { PleachConfig } from 'pleach/config';

// Case 0 of examples/three-ways — the deterministic guardrail config.
//
// Drives the EXACT three-ways payload plan (examples/three-ways/payload/plan.json)
// through the bundled scriptedRunner: canned worktree writes, no agent, no keys.
// The two engine nodes write CONFLICTING versions of src/ttt.ts and
// test/ttt.test.ts (each appends its own functions to the same seed), so the
// integration node's isolate performs a real conflicted merge — markers
// committed, conflict files surfaced in the prompt — and the integration
// scenario resolves it by writing the fully-merged files. The scripted codex
// auditor relays a passing fence (case 0 exercises the egress parse, not
// git-audit.sh itself — profiles 1-3 run the real audit commands).

// ── canned engine content — seed + per-node appends ──────────────────────────
// The seed mirrors payload/project/src/ttt.ts; s1 and s2 each append to it so
// their branches conflict at the append point, exactly like two real agents
// finishing the same file independently.

const ENGINE_SEED = `/**
 * Tic-tac-toe engine.
 *
 * A board is 9 cells in row-major order; '' marks an empty cell.
 *
 * Pre-seeded state: the types + emptyBoard are implemented.
 * The plan adds: legalMoves + applyMove (s1), winner (s2), status + play (integration).
 */

export type Player = 'X' | 'O';
export type Cell = Player | '';
export type Board = [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell];

/** A fresh board: nine empty cells. */
export function emptyBoard(): Board {
  return ['', '', '', '', '', '', '', '', ''];
}
`;

const ENGINE_MOVES = `
/** Indices of empty cells, ascending. */
export function legalMoves(board: Board): number[] {
  const moves: number[] = [];
  for (let i = 0; i < board.length; i += 1) {
    if (board[i] === '') moves.push(i);
  }
  return moves;
}

/** A new board with player placed at index; throws if occupied or out of range. */
export function applyMove(board: Board, index: number, player: Player): Board {
  if (index < 0 || index > 8) throw new Error('index out of range: ' + index);
  if (board[index] !== '') throw new Error('cell occupied: ' + index);
  const next = [...board] as Board;
  next[index] = player;
  return next;
}
`;

const ENGINE_WINNER = `
const LINES: [number, number, number][] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

/** The player occupying a full row, column, or diagonal; null if none. */
export function winner(board: Board): Player | null {
  for (const [a, b, c] of LINES) {
    if (board[a] !== '' && board[a] === board[b] && board[b] === board[c]) {
      return board[a] as Player;
    }
  }
  return null;
}
`;

const ENGINE_STATUS = `
export type Status = 'X' | 'O' | 'draw' | 'playing';

/** 'X'/'O' when that player has won; 'draw' when full with no winner; else 'playing'. */
export function status(board: Board): Status {
  const w = winner(board);
  if (w !== null) return w;
  return board.every((c) => c !== '') ? 'draw' : 'playing';
}
`;

const TEST_SEED = `import { describe, expect, test } from 'bun:test';
import { applyMove, emptyBoard, legalMoves, winner } from '../src/ttt.ts';

describe('emptyBoard', () => {
  test('returns nine empty cells', () => {
    expect(emptyBoard()).toEqual(['', '', '', '', '', '', '', '', '']);
  });
});
`;

// s1's version imports only what it defines — a real agent would not import
// winner before it exists. The import lines therefore ALSO conflict with s2's.
const TEST_S1 = `import { describe, expect, test } from 'bun:test';
import { applyMove, emptyBoard, legalMoves } from '../src/ttt.ts';

describe('emptyBoard', () => {
  test('returns nine empty cells', () => {
    expect(emptyBoard()).toEqual(['', '', '', '', '', '', '', '', '']);
  });
});

describe('moves', () => {
  test('legalMoves on an empty board is 0..8', () => {
    expect(legalMoves(emptyBoard())).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
  test('applyMove places the mark and leaves the rest empty', () => {
    const b = applyMove(emptyBoard(), 4, 'X');
    expect(b[4]).toBe('X');
    expect(b.filter((c) => c === '').length).toBe(8);
  });
  test('applyMove returns a new board and does not mutate its input', () => {
    const before = emptyBoard();
    const after = applyMove(before, 0, 'O');
    expect(before[0]).toBe('');
    expect(after).not.toBe(before);
  });
  test('applyMove on an occupied cell throws', () => {
    const b = applyMove(emptyBoard(), 0, 'X');
    expect(() => applyMove(b, 0, 'O')).toThrow();
  });
});
`;

const TEST_S2 = `import { describe, expect, test } from 'bun:test';
import { emptyBoard, winner } from '../src/ttt.ts';

describe('emptyBoard', () => {
  test('returns nine empty cells', () => {
    expect(emptyBoard()).toEqual(['', '', '', '', '', '', '', '', '']);
  });
});

describe('winner', () => {
  test('empty board has no winner', () => {
    expect(winner(emptyBoard())).toBeNull();
  });
  test('a full top row of X wins', () => {
    expect(winner(['X', 'X', 'X', '', '', '', '', '', ''])).toBe('X');
  });
  test('a full left column of O wins', () => {
    expect(winner(['O', '', '', 'O', '', '', 'O', '', ''])).toBe('O');
  });
  test('a full main diagonal of X wins', () => {
    expect(winner(['X', '', '', '', 'X', '', '', '', 'X'])).toBe('X');
  });
  test('no three-in-a-row means no winner', () => {
    expect(winner(['X', 'O', 'X', 'O', 'X', 'O', 'O', 'X', 'O'])).toBeNull();
  });
});
`;

const TEST_MERGED = `${TEST_SEED}
describe('moves', () => {
  test('legalMoves on an empty board is 0..8', () => {
    expect(legalMoves(emptyBoard())).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
  test('applyMove places the mark and leaves the rest empty', () => {
    const b = applyMove(emptyBoard(), 4, 'X');
    expect(b[4]).toBe('X');
    expect(b.filter((c) => c === '').length).toBe(8);
  });
  test('applyMove returns a new board and does not mutate its input', () => {
    const before = emptyBoard();
    const after = applyMove(before, 0, 'O');
    expect(before[0]).toBe('');
    expect(after).not.toBe(before);
  });
  test('applyMove on an occupied cell throws', () => {
    const b = applyMove(emptyBoard(), 0, 'X');
    expect(() => applyMove(b, 0, 'O')).toThrow();
  });
});

describe('winner', () => {
  test('empty board has no winner', () => {
    expect(winner(emptyBoard())).toBeNull();
  });
  test('a full top row of X wins', () => {
    expect(winner(['X', 'X', 'X', '', '', '', '', '', ''])).toBe('X');
  });
  test('a full left column of O wins', () => {
    expect(winner(['O', '', '', 'O', '', '', 'O', '', ''])).toBe('O');
  });
  test('a full main diagonal of X wins', () => {
    expect(winner(['X', '', '', '', 'X', '', '', '', 'X'])).toBe('X');
  });
  test('no three-in-a-row means no winner', () => {
    expect(winner(['X', 'O', 'X', 'O', 'X', 'O', 'O', 'X', 'O'])).toBeNull();
  });
});
`;

const APP = `import { applyMove, emptyBoard, status } from './ttt.ts';
import type { Board, Player } from './ttt.ts';

export function mount(root: HTMLElement): void {
  let board: Board = emptyBoard();
  let turn: Player = 'X';

  const grid = document.createElement('div');
  grid.className = 'grid';
  const line = document.createElement('p');
  line.className = 'status';
  const reset = document.createElement('button');
  reset.className = 'new-game';
  reset.textContent = 'New game';

  const cells: HTMLButtonElement[] = [];
  for (let i = 0; i < 9; i += 1) {
    const cell = document.createElement('button');
    cell.className = 'cell';
    cell.addEventListener('click', () => {
      play(i);
    });
    cells.push(cell);
    grid.appendChild(cell);
  }

  function render(): void {
    for (let i = 0; i < 9; i += 1) {
      cells[i].textContent = board[i];
    }
    const s = status(board);
    if (s === 'playing') {
      line.textContent = turn + ' to move';
    } else if (s === 'draw') {
      line.textContent = 'Draw';
    } else {
      line.textContent = s + ' wins';
    }
  }

  function play(i: number): void {
    if (status(board) !== 'playing' || board[i] !== '') return;
    board = applyMove(board, i, turn);
    turn = turn === 'X' ? 'O' : 'X';
    render();
  }

  reset.addEventListener('click', () => {
    board = emptyBoard();
    turn = 'X';
    render();
  });

  root.appendChild(grid);
  root.appendChild(line);
  root.appendChild(reset);
  render();
}
`;

const APP_TEST = `import { describe, expect, test } from 'bun:test';
import { mount } from '../src/app.ts';

function setup() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mount(root);
  const cells = Array.from(root.querySelectorAll('button.cell')) as HTMLButtonElement[];
  const statusLine = root.querySelector('p.status') as HTMLParagraphElement;
  const newGame = root.querySelector('button.new-game') as HTMLButtonElement;
  return { cells, statusLine, newGame };
}

describe('app', () => {
  test('X takes the top row and wins', () => {
    const { cells, statusLine } = setup();
    for (const i of [0, 3, 1, 4, 2]) cells[i].click();
    expect(cells[0].textContent).toBe('X');
    expect(cells[1].textContent).toBe('X');
    expect(cells[2].textContent).toBe('X');
    expect(statusLine.textContent).toContain('X wins');
  });

  test('a click on an already-filled cell does nothing', () => {
    const { cells, statusLine } = setup();
    cells[0].click();
    cells[0].click();
    expect(cells[0].textContent).toBe('X');
    expect(statusLine.textContent).toContain('O to move');
  });

  test('New game clears the board with X to move', () => {
    const { cells, statusLine, newGame } = setup();
    cells[0].click();
    cells[4].click();
    newGame.click();
    for (const cell of cells) expect(cell.textContent).toBe('');
    expect(statusLine.textContent).toContain('X to move');
  });
});
`;

const SELFCONTAINED_TEST = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

describe('index.html is self-contained', () => {
  test('inline script, no local-module import, no external script', () => {
    const html = readFileSync(join(import.meta.dir, '..', 'index.html'), 'utf8');
    expect(html).toContain('<script>');
    expect(html).not.toContain("from './");
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>tic-tac-toe</title>
<style>
  body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; }
  .grid { display: grid; grid-template-columns: repeat(3, 64px); gap: 4px; }
  .cell { height: 64px; font-size: 2rem; cursor: pointer; }
  .status { min-height: 1.5em; }
</style>
</head>
<body>
<div id="app"></div>
<script>
(function () {
  var LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  var root = document.getElementById('app');
  var board, turn;
  var grid = document.createElement('div');
  grid.className = 'grid';
  var line = document.createElement('p');
  line.className = 'status';
  var reset = document.createElement('button');
  reset.textContent = 'New game';
  var cells = [];

  function winner() {
    for (var k = 0; k < LINES.length; k += 1) {
      var a = LINES[k][0], b = LINES[k][1], c = LINES[k][2];
      if (board[a] !== '' && board[a] === board[b] && board[b] === board[c]) return board[a];
    }
    return null;
  }
  function full() {
    for (var i = 0; i < 9; i += 1) if (board[i] === '') return false;
    return true;
  }
  function render() {
    for (var i = 0; i < 9; i += 1) cells[i].textContent = board[i];
    var w = winner();
    line.textContent = w ? w + ' wins' : full() ? 'Draw' : turn + ' to move';
  }
  function play(i) {
    if (winner() || full() || board[i] !== '') return;
    board[i] = turn;
    turn = turn === 'X' ? 'O' : 'X';
    render();
  }
  function newGame() {
    board = ['', '', '', '', '', '', '', '', ''];
    turn = 'X';
    render();
  }

  for (var i = 0; i < 9; i += 1) {
    (function (idx) {
      var cell = document.createElement('button');
      cell.className = 'cell';
      cell.addEventListener('click', function () { play(idx); });
      cells.push(cell);
      grid.appendChild(cell);
    })(i);
  }
  reset.addEventListener('click', newGame);
  root.appendChild(grid);
  root.appendChild(line);
  root.appendChild(reset);
  newGame();
})();
</script>
</body>
</html>
`;

// ── the config ───────────────────────────────────────────────────────────────
// Scenario order matters (first match wins): the two engine builds match on
// unique prompt substrings, the integration build on its own, and the codex
// auditor — the only codex spawn in the plan — matches by provider alone.

export default {
  runner: scriptedRunner([
    {
      prompt: 'legalMoves and applyMove',
      files: { 'src/ttt.ts': ENGINE_SEED + ENGINE_MOVES, 'test/ttt.test.ts': TEST_S1 },
      message: 'implemented legalMoves + applyMove test-first',
    },
    {
      prompt: 'winner (test-first)',
      files: { 'src/ttt.ts': ENGINE_SEED + ENGINE_WINNER, 'test/ttt.test.ts': TEST_S2 },
      message: 'implemented winner test-first',
    },
    {
      prompt: 'PLAYABLE WEB',
      files: {
        'src/ttt.ts': ENGINE_SEED + ENGINE_MOVES + ENGINE_WINNER + ENGINE_STATUS,
        'test/ttt.test.ts': TEST_MERGED,
        'src/app.ts': APP,
        'test/app.test.ts': APP_TEST,
        'test/selfcontained.test.ts': SELFCONTAINED_TEST,
        'index.html': INDEX_HTML,
      },
      message: 'resolved the engine merge, added status + the web UI, bundled index.html',
    },
    {
      provider: 'codex',
      message: scriptedAuditResult([{ check: 'ttt', verdict: 'pass' }]),
    },
  ]),
  ledger: gitLedger(),
} satisfies PleachConfig;
