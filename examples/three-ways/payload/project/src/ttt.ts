/**
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
