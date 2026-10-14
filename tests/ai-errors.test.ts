import { describe, expect, it } from 'vitest';
import { createChooser, AiRunner } from '../server/ai.js';
import { AiResponseError, diagnoseAiError } from '../server/ai-errors.js';
import { createGame, fire, knowledge } from '../server/engine.js';
import { randomFleet } from '../shared/game.js';
describe('OpenAI failure diagnostics', () => {
  it.each([
    [{ status: 401, code: 'invalid_api_key' }, 'authentication'],
    [{ status: 429, code: 'insufficient_quota' }, 'quota'],
    [{ status: 429, code: 'project_spend_limit_exceeded' }, 'quota'],
    [{ status: 429, type: 'insufficient_quota' }, 'quota'],
    [{ status: 429, code: 'rate_limit_exceeded' }, 'rate_limit'],
    [{ status: 403 }, 'permission'],
    [{ status: 404, code: 'model_not_found' }, 'model'],
    [{ status: 400, code: 'invalid_json_schema' }, 'request'],
    [{ name: 'APIConnectionTimeoutError' }, 'timeout'],
    [{ name: 'APIConnectionError' }, 'connection'],
    [{ status: 503 }, 'unavailable'],
    [new AiResponseError('incomplete'), 'incomplete'],
  ])('classifies %j as %s', (error, category) => {
    expect(diagnoseAiError(error).category).toBe(category);
  });
  it('never exposes raw errors or arbitrary credential-bearing metadata', () => {
    const secret = 'sk-private-test-secret';
    const result = diagnoseAiError({ status: 401, message: secret, code: secret, request_id: secret, headers: { authorization: secret } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.code).toBeUndefined();
    expect(result.requestId).toBeUndefined();
    expect(diagnoseAiError({ request_id: 'req_safe123' }).requestId).toBe('req_safe123');
  });
  it('classifies actual SDK errors without making an external API request', async () => {
    const transport: typeof fetch = async () => new Response(JSON.stringify({ error: {
      message: 'Sensitive provider message', code: 'insufficient_quota', type: 'insufficient_quota', param: null,
    } }), { status: 429, headers: { 'content-type': 'application/json', 'x-request-id': 'req_test123' } });
    const choose = createChooser('openai', 'gpt-4o-mini', 'test-key', transport);
    const game = createGame(randomFleet(), randomFleet());
    game.turn = 'ai';
    const diagnostics: unknown[] = [];
    new AiRunner(choose, 1, info => diagnostics.push(info)).start(game, point => fire(game, 'ai', point));
    for (let i = 0; i < 100 && game.busy; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(game.busy).toBe(false);
    expect(game.error).toContain('коштів');
    expect(diagnostics).toEqual([{ category: 'quota', status: 429, code: 'insufficient_quota', requestId: 'req_test123' }]);
    expect(JSON.stringify(diagnostics)).not.toContain('Sensitive provider message');
    expect(game.aiShots).toEqual([]);
  });
  it('parses successful SDK responses and sends only knowledge, not hidden ships', async () => {
    const game = createGame(randomFleet(), randomFleet());
    const state = knowledge(game);
    let request: Record<string, unknown> = {};
    const transport: typeof fetch = async (_url, init) => {
      request = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ id: 'resp_test', object: 'response', status: 'completed',
        output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [
          { type: 'output_text', text: JSON.stringify(state.availableTargets[0]), annotations: [] },
        ] }],
      }), { headers: { 'content-type': 'application/json' } });
    };
    const point = await createChooser('openai', 'gpt-4o-mini', 'test-key', transport)(state);
    expect(point).toEqual(state.availableTargets[0]);
    expect(request.store).toBe(false);
    const input = JSON.parse(request.input as string);
    expect(input).toEqual(state);
    expect(input).not.toHaveProperty('playerShips');
  });
});
