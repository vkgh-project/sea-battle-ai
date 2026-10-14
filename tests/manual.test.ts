import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomFleet, same, type GameView } from '../shared/game.js';
import { buildApp } from '../server/app.js';
import { createGame, fire, knowledge } from '../server/engine.js';
import { manualPrompt, manualRequestId, parseManualResponse } from '../server/manual.js';

describe('manual ChatGPT prompt and parsing', () => {
  it('includes only known state and binds the answer to this game and turn', () => {
    const game = createGame(randomFleet(), randomFleet());
    const prompt = manualPrompt(game);
    const state = JSON.parse(prompt.split('\nАктуальний стан:\n')[1]);
    expect(state).toEqual(knowledge(game));
    expect(state).not.toHaveProperty('playerShips');
    expect(state).not.toHaveProperty('opponentShips');
    expect(prompt).toContain(manualRequestId(game));
    const answer = JSON.stringify({ requestId: manualRequestId(game), row: 1, column: 2 });
    expect(parseManualResponse(answer, game)).toEqual({ row: 1, column: 2 });
    expect(parseManualResponse('```json\n' + answer + '\n```', game)).toEqual({ row: 1, column: 2 });
  });
  it.each(['not JSON', 'null', '[]', '{"row":1,"column":2}', '{"requestId":"old","row":1,"column":2}'])('rejects malformed or stale answer %s', text => {
    expect(() => parseManualResponse(text, createGame(randomFleet(), randomFleet()))).toThrow();
  });
  it('rejects fractional coordinates, numeric strings, extra fields and out-of-bounds coordinates', () => {
    const game = createGame(randomFleet(), randomFleet());
    for (const fields of [{ row: 1.5, column: 2 }, { row: '1', column: 2 }, { row: 10, column: 0 }, { row: 0, column: 0, explanation: 'text' }]) {
      expect(() => parseManualResponse(JSON.stringify({ requestId: manualRequestId(game), ...fields }), game)).toThrow();
    }
  });
});

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function startManualGame() {
  const choose = vi.fn(async () => { throw new Error('Manual mode must never call the API'); });
  const app = await buildApp({ mode: 'manual', choose });
  apps.push(app);
  const session = await app.inject({ method: 'GET', url: '/api/session' });
  expect(session.json().aiMode).toBe('manual');
  const headers = { cookie: `seabattle=${session.cookies[0].value}`, 'x-game-request': '1' };
  let game = (await app.inject({ method: 'POST', url: '/api/game', headers, payload: { ships: randomFleet() } })).json<GameView>();
  for (const point of Array.from({ length: 100 }, (_, i) => ({ row: Math.floor(i / 10), column: i % 10 }))) {
    const result = await app.inject({ method: 'POST', url: `/api/game/${game.id}/shot`, headers, payload: { ...point, version: game.version } });
    if (result.statusCode === 409) continue;
    expect(result.statusCode).toBe(200);
    game = result.json();
    if (game.turn === 'ai') return { app, headers, game, choose };
  }
  throw new Error('Expected human miss');
}
describe('manual turn HTTP flow', () => {
  it('waits without an API call, retains turn on hit, refreshes prompt and returns turn on miss', async () => {
    const f = await startManualGame();
    expect(f.game.busy).toBe(false);
    expect(f.game.manualPrompt).toBeTruthy();
    expect(f.choose).not.toHaveBeenCalled();
    const submit = async (game: GameView, point: { row: number; column: number }) => f.app.inject({
      method: 'POST', url: `/api/game/${game.id}/ai-response`, headers: f.headers,
      payload: { version: game.version, response: JSON.stringify({ requestId: `${game.id}:${game.version}`, ...point }) },
    });
    const hitResponse = await submit(f.game, f.game.playerShips.find(ship => ship.length > 1)![0]);
    expect(hitResponse.statusCode).toBe(200);
    const hit = hitResponse.json<GameView>();
    expect(hit.turn).toBe('ai');
    expect(hit.aiShots[0].result).toBe('hit');
    expect(hit.manualPrompt).not.toEqual(f.game.manualPrompt);
    const miss = Array.from({ length: 100 }, (_, i) => ({ row: Math.floor(i / 10), column: i % 10 })).find(p => !hit.playerShips.flat().some(q => same(p, q)))!;
    const missResponse = await submit(hit, miss);
    expect(missResponse.statusCode).toBe(200);
    const missed = missResponse.json<GameView>();
    expect(missed.turn).toBe('human');
    expect(missed).not.toHaveProperty('manualPrompt');
    expect(f.choose).not.toHaveBeenCalled();
    const restored = await f.app.inject({ method: 'GET', url: '/api/session', headers: f.headers });
    expect(restored.json().game.aiShots).toHaveLength(2);
  });
  it('rejects invalid, duplicate, stale and foreign responses without changing the game', async () => {
    const f = await startManualGame();
    const url = `/api/game/${f.game.id}/ai-response`;
    expect((await f.app.inject({ method: 'POST', url, headers: f.headers, payload: { response: 'hello', version: f.game.version } })).statusCode).toBe(400);
    const other = await f.app.inject({ method: 'GET', url: '/api/session' });
    const point = f.game.playerShips[0][0];
    const response = JSON.stringify({ requestId: `${f.game.id}:${f.game.version}`, ...point });
    const payload = { response, version: f.game.version };
    expect((await f.app.inject({ method: 'POST', url, headers: { ...f.headers, cookie: `seabattle=${other.cookies[0].value}` }, payload })).statusCode).toBe(404);
    const applied = await f.app.inject({ method: 'POST', url, headers: f.headers, payload });
    expect(applied.statusCode).toBe(200);
    const latest = applied.json<GameView>();
    expect((await f.app.inject({ method: 'POST', url, headers: f.headers, payload })).statusCode).toBe(409);
    expect((await f.app.inject({ method: 'POST', url, headers: f.headers, payload: { response, version: latest.version } })).statusCode).toBe(409);
    const duplicate = JSON.stringify({ requestId: `${latest.id}:${latest.version}`, ...point });
    expect((await f.app.inject({ method: 'POST', url, headers: f.headers, payload: { response: duplicate, version: latest.version } })).statusCode).toBe(409);
    const unchanged = (await f.app.inject({ method: 'GET', url: `/api/game/${latest.id}`, headers: f.headers })).json<GameView>();
    expect(unchanged.version).toBe(latest.version);
    expect(unchanged.aiShots).toEqual(latest.aiShots);
  });
  it('finishes the game after all human ships are sunk', async () => {
    const f = await startManualGame();
    let game = f.game;
    for (const point of f.game.playerShips.flat()) {
      const result = await f.app.inject({ method: 'POST', url: `/api/game/${game.id}/ai-response`, headers: f.headers,
        payload: { version: game.version, response: JSON.stringify({ requestId: `${game.id}:${game.version}`, ...point }) } });
      expect(result.statusCode).toBe(200);
      game = result.json();
    }
    expect(game.phase).toBe('lost');
    expect(game).not.toHaveProperty('manualPrompt');
    expect(game.enemyShips).toHaveLength(10);
    expect(f.choose).not.toHaveBeenCalled();
  });
  it('starts without any API chooser and blocks the automatic retry endpoint', async () => {
    const app = await buildApp();
    apps.push(app);
    const session = await app.inject({ method: 'GET', url: '/api/session' });
    expect(session.json().aiMode).toBe('manual');
    const f = await startManualGame();
    expect((await f.app.inject({ method: 'POST', url: `/api/game/${f.game.id}/retry`, headers: f.headers, payload: {} })).statusCode).toBe(409);
  });
});
