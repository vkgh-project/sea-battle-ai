export const SIZE = 10;
export const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
export const LETTERS = 'АБВГҐДЕЄЖЗ';
export type Point = { row: number; column: number };
export type Ship = Point[];
export type Shot = Point & { result: 'miss' | 'hit' | 'sunk' };
export type AiMode = 'gemini' | 'demo';
export type GameView = {
  id: string;
  version: number;
  phase: 'playing' | 'won' | 'lost';
  turn: 'human' | 'ai';
  busy: boolean;
  error: string | null;
  playerShips: Ship[];
  playerShots: Shot[];
  aiShots: Shot[];
  enemySunkShips: Ship[];
  enemyShips?: Ship[];
};
export type SessionView = { game: GameView | null; aiMode: AiMode };
export const key = (p: Point) => p.row * SIZE + p.column;
export const same = (a: Point, b: Point) => a.row === b.row && a.column === b.column;
export const inside = (p: Point) => Number.isInteger(p.row) && Number.isInteger(p.column)
  && p.row >= 0 && p.row < SIZE && p.column >= 0 && p.column < SIZE;
export const touches = (a: Point, b: Point) => Math.abs(a.row - b.row) <= 1 && Math.abs(a.column - b.column) <= 1;
export function validShip(ship: Ship): boolean {
  if (!ship.length || ship.length > 4 || !ship.every(inside) || new Set(ship.map(key)).size !== ship.length) return false;
  const horizontal = ship.every(p => p.row === ship[0].row);
  const vertical = ship.every(p => p.column === ship[0].column);
  if (!horizontal && !vertical) return false;
  const positions = ship.map(p => horizontal ? p.column : p.row).sort((a, b) => a - b);
  return positions.every((p, i) => !i || p === positions[i - 1] + 1);
}
export function canPlace(ship: Ship, fleet: Ship[]): boolean {
  return validShip(ship) && !ship.some(p => fleet.some(other => other.some(q => touches(p, q))));
}
export function validFleet(fleet: Ship[]): boolean {
  return fleet.length === FLEET.length
    && fleet.map(s => s.length).sort((a, b) => b - a).join() === FLEET.join()
    && fleet.every((ship, i) => canPlace(ship, fleet.slice(0, i)));
}
export function randomFleet(): Ship[] {
  // Restart if a placement becomes crowded; never return a partial fleet.
  for (;;) {
    const fleet: Ship[] = [];
    for (const length of FLEET) {
      for (let attempt = 0; attempt < 300; attempt++) {
        const horizontal = Math.random() < 0.5;
        const row = Math.floor(Math.random() * SIZE);
        const column = Math.floor(Math.random() * SIZE);
        const ship = Array.from({ length }, (_, i) => ({ row: row + (horizontal ? 0 : i), column: column + (horizontal ? i : 0) }));
        if (canPlace(ship, fleet)) { fleet.push(ship); break; }
      }
    }
    if (validFleet(fleet)) return fleet;
  }
}
export const label = (p: Point) => `${LETTERS[p.column]}${p.row + 1}`;
