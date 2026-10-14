import { randomUUID } from 'node:crypto';
import { FLEET, SIZE, inside, key, same, touches, validFleet, type GameView, type Point, type Ship, type Shot } from '../shared/game.js';
export class GameError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
export type Game = GameView & { opponentShips: Ship[] };
export function createGame(playerShips: Ship[], opponentShips: Ship[]): Game {
  if (!validFleet(playerShips) || !validFleet(opponentShips)) throw new GameError('Некоректне розміщення кораблів.');
  return {
    id: randomUUID(), version: 0, phase: 'playing', turn: 'human', busy: false,
    error: null, playerShips: structuredClone(playerShips), opponentShips: structuredClone(opponentShips),
    playerShots: [], aiShots: [], enemySunkShips: [],
  };
}
export function sunkShips(fleet: Ship[], shots: Shot[]): Ship[] {
  return fleet.filter(ship => ship.every(p => shots.some(s => same(p, s))));
}
export function availableTargets(shots: Shot[], sunk: Ship[]): Point[] {
  const fired = new Set(shots.map(key));
  return Array.from({ length: SIZE * SIZE }, (_, i) => ({ row: Math.floor(i / SIZE), column: i % SIZE }))
    .filter(p => !fired.has(key(p)) && !sunk.some(ship => ship.some(q => touches(p, q))));
}
export function fire(game: Game, who: 'human' | 'ai', target: Point): Shot {
  if (game.phase !== 'playing' || game.turn !== who) throw new GameError('Зараз не ваш хід.', 409);
  const shots = who === 'human' ? game.playerShots : game.aiShots;
  const fleet = who === 'human' ? game.opponentShips : game.playerShips;
  if (!inside(target) || !availableTargets(shots, sunkShips(fleet, shots)).some(p => same(p, target))) {
    throw new GameError('У цю клітинку вже не можна стріляти.', 409);
  }
  const ship = fleet.find(s => s.some(p => same(p, target)));
  const shot: Shot = { ...target, result: ship ? 'hit' : 'miss' };
  shots.push(shot);
  if (ship && ship.every(p => shots.some(s => same(p, s)))) shot.result = 'sunk';
  game.enemySunkShips = sunkShips(game.opponentShips, game.playerShots);
  if (sunkShips(fleet, shots).length === FLEET.length) game.phase = who === 'human' ? 'won' : 'lost';
  else if (shot.result === 'miss') game.turn = who === 'human' ? 'ai' : 'human';
  game.version++;
  game.error = null;
  return shot;
}
export function knowledge(game: Game) {
  const sunk = sunkShips(game.playerShips, game.aiShots);
  const remaining = [...FLEET];
  for (const ship of sunk) remaining.splice(remaining.indexOf(ship.length), 1);
  return {
    boardSize: SIZE, coordinateRange: [0, SIZE - 1], shots: structuredClone(game.aiShots),
    sunkShips: structuredClone(sunk), remainingShips: remaining,
    availableTargets: availableTargets(game.aiShots, sunk),
  };
}
export function view(game: Game): GameView {
  return structuredClone({
    id: game.id, version: game.version, phase: game.phase, turn: game.turn,
    busy: game.busy, error: game.error, playerShips: game.playerShips,
    playerShots: game.playerShots, aiShots: game.aiShots, enemySunkShips: game.enemySunkShips,
    ...(game.phase !== 'playing' ? { enemyShips: game.opponentShips } : {}),
  });
}
