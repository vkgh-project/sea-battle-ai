import { afterEach, describe, expect, it, vi } from 'vitest';
import { planTargets, shuffledTargets } from '../server/ai-strategy.js';
import { createChooser } from '../server/ai.js';
import { availableTargets, createGame, fire, knowledge } from '../server/engine.js';
import { randomFleet, same, type Point, type Ship, type Shot } from '../shared/game.js';
const hit = (row: number, column: number): Shot => ({ row, column, result: 'hit' });
const miss = (row: number, column: number): Shot => ({ row, column, result: 'miss' });
function state(shots: Shot[], remainingShips: number[], sunkShips: Ship[] = []) {
  return { boardSize: 10, coordinateRange: [0, 9], shots, remainingShips, sunkShips, availableTargets: availableTargets(shots, sunkShips) };
}
afterEach(() => vi.restoreAllMocks());
describe('public-evidence tactical planning', () => {
  it('forces continuation of a four-cell ship when its other end is blocked', () => {
    const input = state([miss(4, 3), hit(4, 4), hit(4, 5)], [4]);
    expect(planTargets(input)).toEqual({ mode: 'pursuit', targets: [{ row: 4, column: 6 }] });
    input.shots.push(hit(4, 6));
    input.availableTargets = availableTargets(input.shots, []);
    expect(planTargets(input).targets).toEqual([{ row: 4, column: 7 }]);
  });
  it('follows a vertical ship axis and changes ends after a miss', () => {
    const input = state([hit(4, 5), hit(5, 5)], [3, 4]);
    expect(planTargets(input).targets).toEqual([{ row: 3, column: 5 }, { row: 6, column: 5 }]);
    input.shots.push(miss(6, 5));
    input.availableTargets = availableTargets(input.shots, []);
    expect(planTargets(input).targets).toEqual([{ row: 3, column: 5 }]);
  });
  it('uses the board edge to force the next hit', () => {
    expect(planTargets(state([hit(0, 0), hit(0, 1)], [4])).targets).toEqual([{ row: 0, column: 2 }]);
  });
  it('pursues only orthogonal neighbors of a single unfinished hit', () => {
    const result = planTargets(state([hit(4, 4)], [2, 3, 4]));
    expect(result.mode).toBe('pursuit');
    expect(result.targets.length).toBeGreaterThan(0);
    expect(result.targets.every(p => Math.abs(p.row - 4) + Math.abs(p.column - 4) === 1)).toBe(true);
  });
  it('fills a forced gap between separated hits when only one ship remains', () => {
    expect(planTargets(state([miss(4, 3), hit(4, 4), hit(4, 6)], [3])).targets).toEqual([{ row: 4, column: 5 }]);
  });
  it('stops pursuing hits of a sunk ship and excludes its surrounding water', () => {
    const ship = [{ row: 4, column: 4 }, { row: 4, column: 5 }];
    const result = planTargets(state([hit(4, 4), { row: 4, column: 5, result: 'sunk' }], [1], [ship]));
    expect(result.mode).toBe('search');
    expect(result.targets).toHaveLength(88);
    expect(result.targets.some(p => p.row >= 3 && p.row <= 5 && p.column >= 3 && p.column <= 6)).toBe(false);
  });
  it('starts a full-fleet hunt in high-density regions rather than the top-left corner', () => {
    const input = knowledge(createGame(randomFleet(), randomFleet()));
    const result = planTargets(input);
    expect(result.mode).toBe('search');
    expect(result.targets.some(p => p.row === 0 && p.column === 0)).toBe(false);
    expect(result.targets.every(p => p.row >= 3 && p.row <= 6 && p.column >= 3 && p.column <= 6)).toBe(true);
  });
  it('permutes equally good targets without changing the candidate set or source array', () => {
    const points = [{ row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 }];
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(shuffledTargets(points)).toEqual([points[1], points[2], points[0]]);
    expect(points.map(p => p.column)).toEqual([0, 1, 2]);
  });
  it('sinks complete fleets using only shot history even if the model always picks the first candidate', () => {
    let seed = 193;
    vi.spyOn(Math, 'random').mockImplementation(() => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32));
    for (let trial = 0; trial < 30; trial++) {
      const game = createGame(randomFleet(), randomFleet());
      for (let i = 0; i < 100 && game.phase === 'playing'; i++) {
        game.turn = 'ai';
        const choices = planTargets(knowledge(game)).targets;
        expect(choices.length, `trial ${trial}, shot ${i}`).toBeGreaterThan(0);
        fire(game, 'ai', choices[0]);
      }
      expect(game.phase).toBe('lost');
    }
  });
});
describe('Gemini tactical guards', () => {
  it('executes a forced shot without calling Gemini', async () => {
    const input = state([miss(4, 3), hit(4, 4), hit(4, 5)], [4]);
    const transport = vi.fn<typeof fetch>();
    expect(await createChooser('gemini', 'gemini-3.5-flash-lite', 'test-key', transport)(input)).toEqual({ row: 4, column: 6 });
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects a legal but tactically irrelevant shot selected outside the enum', async () => {
    const input = state([hit(4, 4), hit(4, 5)], [3, 4]);
    expect(input.availableTargets.some(p => same(p, { row: 0, column: 0 }))).toBe(true);
    const transport: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.generationConfig.responseSchema.properties.target.enum.sort()).toEqual(['4,3', '4,6']);
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"target":"0,0"}' }] } }] }));
    };
    await expect(createChooser('gemini', 'gemini-3.5-flash-lite', 'test-key', transport)(input)).rejects.toMatchObject({ reason: 'unavailable_target' });
  });
});
