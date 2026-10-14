import { afterEach, describe, expect, it } from 'vitest';
import { randomFleet, same, type GameView } from '../shared/game.js';
import { buildApp } from '../server/app.js';
import { createChooser, type ChooseShot } from '../server/ai.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture(choose: ChooseShot = async state => state.availableTargets[0], extra: Parameters<typeof buildApp>[0] extends infer T ? Partial<T> : never = {}) {
  const app = await buildApp({ choose, mode: 'gemini', ...extra });
  apps.push(app);
  const session = await app.inject({ method: 'GET', url: '/api/session' });
  const token = session.cookies[0].value;
  const headers = { cookie: `seabattle=${token}`, 'x-game-request': '1' };
  const created = await app.inject({ method: 'POST', url: '/api/game', headers, payload: { ships: randomFleet() } });
  expect(created.statusCode).toBe(200);
  return { app, headers, game: created.json<GameView>() };
}
async function makeAiTurn(f: Awaited<ReturnType<typeof fixture>>) {
  let game = f.game;
  for (const p of Array.from({ length: 100 }, (_, i) => ({ row: Math.floor(i / 10), column: i % 10 }))) {
    const result = await f.app.inject({ method: 'POST', url: `/api/game/${game.id}/shot`, headers: f.headers, payload: { ...p, version: game.version } });
    if (result.statusCode === 409) continue;
    expect(result.statusCode).toBe(200);
    game = result.json();
    if (game.turn === 'ai') return game;
  }
  throw new Error('Expected at least one miss');
}
describe('sessions and HTTP API', () => {
  it('executes an automatic Gemini turn and has no response-pasting endpoint', async () => {
    let fleet: GameView['playerShips'] = [];
    let calls = 0;
    const transport: typeof fetch = async (_url, init) => {
      calls++;
      const knowledge = JSON.parse(JSON.parse(init!.body as string).contents[0].parts[0].text);
      const miss = knowledge.availableTargets.find((p: { row: number; column: number }) => !fleet.flat().some(q => same(p, q)));
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(miss) }] } }] }));
    };
    const f = await fixture(createChooser('gemini', 'gemini-3.5-flash-lite', 'test-key', transport));
    fleet = f.game.playerShips;
    expect((await f.app.inject({ method: 'GET', url: '/api/session', headers: f.headers })).json().aiMode).toBe('gemini');
    await makeAiTurn(f);
    await new Promise(resolve => setTimeout(resolve, 10));
    const game = (await f.app.inject({ method: 'GET', url: `/api/game/${f.game.id}`, headers: f.headers })).json<GameView>();
    expect(calls).toBe(1);
    expect(game.turn).toBe('human');
    expect(game.aiShots).toHaveLength(1);
    expect(game.error).toBeNull();
    expect(game).not.toHaveProperty('manualPrompt');
    const removed = await f.app.inject({ method: 'POST', url: `/api/game/${f.game.id}/ai-response`, headers: f.headers, payload: { response: '{}', version: game.version } });
    expect(removed.statusCode).toBe(404);
  });
  it('isolates users and refuses access with only a game ID', async () => {
    const a = await fixture();
    const other = await a.app.inject({ method: 'GET', url: '/api/session' });
    const bHeaders = { cookie: `seabattle=${other.cookies[0].value}`, 'x-game-request': '1' };
    const b = await a.app.inject({ method: 'POST', url: '/api/game', headers: bHeaders, payload: { ships: randomFleet() } });
    expect(b.statusCode).toBe(200);
    expect(b.json().id).not.toBe(a.game.id);
    for (const method of ['GET', 'POST'] as const) {
      const result = await a.app.inject({ method, url: `/api/game/${a.game.id}${method === 'POST' ? '/shot' : ''}`, headers: bHeaders,
        ...(method === 'POST' ? { payload: { row: 0, column: 0, version: 0 } } : {}) });
      expect(result.statusCode).toBe(404);
    }
    expect((await a.app.inject({ method: 'GET', url: `/api/game/${a.game.id}` })).statusCode).toBe(401);
    const restored = await a.app.inject({ method: 'GET', url: '/api/session', headers: a.headers });
    expect(restored.json().game.id).toBe(a.game.id);
    expect(restored.json().game).not.toHaveProperty('opponentShips');
    expect(restored.json().game).not.toHaveProperty('enemyShips');
  });
  it('rejects CSRF and malformed fleets', async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: 'POST', url: '/api/game', headers: { cookie: f.headers.cookie }, payload: { ships: randomFleet() } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/api/game', headers: { ...f.headers, 'sec-fetch-site': 'cross-site' }, payload: { ships: randomFleet() } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/api/game', headers: f.headers, payload: { ships: [] } })).statusCode).toBe(400);
  });
  it('rejects repeated versions and locks a pending AI game while other sessions work', async () => {
    let finish!: (p: { row: number; column: number }) => void;
    const f = await fixture(state => new Promise(resolve => { finish = resolve; }));
    const pending = await makeAiTurn(f);
    expect(pending.busy).toBe(true);
    expect((await f.app.inject({ method: 'POST', url: `/api/game/${pending.id}/shot`, headers: f.headers, payload: { row: 9, column: 9, version: pending.version } })).statusCode).toBe(409);
    const otherSession = await f.app.inject({ method: 'GET', url: '/api/session' });
    const otherHeaders = { cookie: `seabattle=${otherSession.cookies[0].value}`, 'x-game-request': '1' };
    const otherGame = await f.app.inject({ method: 'POST', url: '/api/game', headers: otherHeaders, payload: { ships: randomFleet() } });
    expect(otherGame.statusCode).toBe(200);
    expect(otherGame.json().busy).toBe(false);
    const miss = Array.from({ length: 100 }, (_, i) => ({ row: Math.floor(i / 10), column: i % 10 })).find(p => !pending.playerShips.flat().some(q => same(p, q)))!;
    finish(miss);
    await new Promise(resolve => setTimeout(resolve, 0));
    const current = (await f.app.inject({ method: 'GET', url: `/api/game/${pending.id}`, headers: f.headers })).json<GameView>();
    expect(current.busy).toBe(false);
    expect(current.turn).toBe('human');
    expect((await f.app.inject({ method: 'POST', url: `/api/game/${pending.id}/shot`, headers: f.headers, payload: { row: 9, column: 9, version: 0 } })).statusCode).toBe(409);
  });
  it('keeps a failed AI turn recoverable and resumes without repeating the human shot', async () => {
    let fail = true;
    let fleet: GameView['playerShips'] = [];
    const f = await fixture(async state => {
      if (fail) throw new Error('Provider unavailable');
      return state.availableTargets.find(p => !fleet.flat().some(q => same(p, q)))!;
    });
    fleet = f.game.playerShips;
    const pending = await makeAiTurn(f);
    await new Promise(resolve => setTimeout(resolve, 0));
    const failed = (await f.app.inject({ method: 'GET', url: `/api/game/${pending.id}`, headers: f.headers })).json<GameView>();
    expect(failed.busy).toBe(false);
    expect(failed.error).toBeTruthy();
    fail = false;
    await f.app.inject({ method: 'POST', url: `/api/game/${pending.id}/retry`, headers: f.headers, payload: {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    const resumed = (await f.app.inject({ method: 'GET', url: `/api/game/${pending.id}`, headers: f.headers })).json<GameView>();
    expect(resumed.turn).toBe('human');
    expect(resumed.error).toBeNull();
    expect(resumed.playerShots).toEqual(failed.playerShots);
    expect(resumed.aiShots).toHaveLength(1);
  });
  it('caps memory use and expires inactive sessions', async () => {
    const f = await fixture(async state => state.availableTargets[0], { maxSessions: 1, ttlMs: 30 });
    expect((await f.app.inject({ method: 'GET', url: '/api/session' })).statusCode).toBe(503);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect((await f.app.inject({ method: 'GET', url: `/api/game/${f.game.id}`, headers: f.headers })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'GET', url: '/api/session' })).statusCode).toBe(200);
  });
});
