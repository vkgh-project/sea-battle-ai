import { describe, expect, it } from 'vitest';
import { AiRunner, createChooser } from '../server/ai.js';
import { createGame, fire, knowledge } from '../server/engine.js';
import { randomFleet, same, type Point } from '../shared/game.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe('AI scheduler', () => {
  it('caps concurrent requests without locking other games and allows retry', async () => {
    const releases: ((point: Point) => void)[] = [];
    const runner = new AiRunner(() => new Promise(resolve => releases.push(resolve)), 1);
    const a = createGame(randomFleet(), randomFleet());
    const b = createGame(randomFleet(), randomFleet());
    a.turn = b.turn = 'ai';
    runner.start(a, p => fire(a, 'ai', p));
    runner.start(b, p => fire(b, 'ai', p));
    expect(a.busy).toBe(true);
    expect(b.busy).toBe(false);
    expect(b.error).toContain('зайнятий');
    const miss = knowledge(a).availableTargets.find(p => !a.playerShips.flat().some(q => same(p, q)))!;
    releases[0](miss);
    await tick();
    expect(a.turn).toBe('human');
    runner.start(b, p => fire(b, 'ai', p));
    expect(b.busy).toBe(true);
    releases[1](knowledge(b).availableTargets.find(p => !b.playerShips.flat().some(q => same(p, q)))!);
    await tick();
    expect(b.turn).toBe('human');
    expect(b.error).toBeNull();
  });
  it('rejects an invalid AI move without changing the board', async () => {
    const game = createGame(randomFleet(), randomFleet());
    game.turn = 'ai';
    const runner = new AiRunner(async () => ({ row: 99, column: 99 }), 1);
    runner.start(game, p => fire(game, 'ai', p));
    await tick();
    expect(game.aiShots).toEqual([]);
    expect(game.busy).toBe(false);
    expect(game.error).toBeTruthy();
  });
  it('requires a key for OpenAI and provides demo only when explicitly chosen', async () => {
    expect(() => createChooser('openai', 'gpt-4o-mini')).toThrow('OPENAI_API_KEY');
    const game = createGame(randomFleet(), randomFleet());
    const state = knowledge(game);
    const point = await createChooser('demo', 'unused')(state);
    expect(state.availableTargets.some(p => same(p, point))).toBe(true);
  });
});
