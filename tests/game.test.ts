import { describe, expect, it } from 'vitest';
import { FLEET, canPlace, randomFleet, same, validFleet } from '../shared/game.js';
import { availableTargets, createGame, fire, knowledge, view } from '../server/engine.js';

describe('Battleship rules', () => {
  it('generates complete fleets with no touching ships', () => {
    for (let i = 0; i < 200; i++) expect(validFleet(randomFleet())).toBe(true);
  });
  it('rejects diagonal contact, bends, gaps, duplicates and out-of-bounds ships', () => {
    expect(canPlace([{ row: 1, column: 1 }], [[{ row: 0, column: 0 }]])).toBe(false);
    for (const ship of [
      [{ row: 0, column: 0 }, { row: 1, column: 1 }],
      [{ row: 0, column: 0 }, { row: 0, column: 2 }],
      [{ row: 0, column: 0 }, { row: 0, column: 0 }],
      [{ row: 10, column: 0 }],
    ]) expect(canPlace(ship, [])).toBe(false);
    expect(validFleet(randomFleet().slice(1))).toBe(false);
  });
  it('keeps the turn on hits, marks sinking, and ends the game', () => {
    const fleet = randomFleet();
    const game = createGame(randomFleet(), fleet);
    for (const ship of fleet) {
      ship.forEach((p, i) => expect(fire(game, 'human', p).result).toBe(i === ship.length - 1 ? 'sunk' : 'hit'));
    }
    expect(game.phase).toBe('won');
    expect(game.playerShots).toHaveLength(20);
    expect(() => fire(game, 'human', { row: 0, column: 0 })).toThrow();
  });
  it('transfers the turn on a miss and rejects duplicate or out-of-turn shots', () => {
    const fleet = randomFleet();
    const game = createGame(randomFleet(), fleet);
    const miss = availableTargets([], []).find(p => !fleet.flat().some(q => same(p, q)))!;
    expect(fire(game, 'human', miss).result).toBe('miss');
    expect(game.turn).toBe('ai');
    expect(() => fire(game, 'human', miss)).toThrow();
    game.turn = 'human';
    expect(() => fire(game, 'human', miss)).toThrow();
  });
  it('does not reveal hidden fleets to the browser or model and returns detached views', () => {
    const game = createGame(randomFleet(), randomFleet());
    const publicState = view(game);
    expect(publicState).not.toHaveProperty('opponentShips');
    expect(publicState).not.toHaveProperty('enemyShips');
    publicState.playerShips[0][0].row = 99;
    expect(game.playerShips[0][0].row).not.toBe(99);
    const modelState = knowledge(game);
    expect(modelState).not.toHaveProperty('playerShips');
    expect(modelState).not.toHaveProperty('opponentShips');
    expect(modelState.shots).toEqual([]);
    expect(modelState.availableTargets).toHaveLength(100);
    expect(modelState.remainingShips).toEqual(FLEET);
  });
  it('excludes the perimeter of sunk ships and gives AI only revealed cells', () => {
    const game = createGame(randomFleet(), randomFleet());
    const single = game.playerShips.find(ship => ship.length === 1)!;
    game.turn = 'ai';
    fire(game, 'ai', single[0]);
    const info = knowledge(game);
    expect(info.sunkShips).toEqual([single]);
    expect(info.remainingShips).toHaveLength(9);
    expect(info.availableTargets.some(p => Math.abs(p.row - single[0].row) <= 1 && Math.abs(p.column - single[0].column) <= 1)).toBe(false);
  });
});
