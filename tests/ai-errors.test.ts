import { describe, expect, it } from 'vitest';
import { createChooser, AiRunner } from '../server/ai.js';
import { AiResponseError, diagnoseAiError } from '../server/ai-errors.js';
import { createGame, fire, knowledge } from '../server/engine.js';
import { randomFleet } from '../shared/game.js';
const model = 'gemini-3.5-flash-lite';
const state = () => knowledge(createGame(randomFleet(), randomFleet()));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const success = (point: unknown) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(point) }] } }] });
describe('Gemini failure diagnostics', () => {
  it.each([
    [{ status: 401, code: 'UNAUTHENTICATED' }, 'authentication'],
    [{ status: 400, code: 'API_KEY_INVALID' }, 'authentication'],
    [{ status: 429, code: 'RESOURCE_EXHAUSTED' }, 'rate_limit'],
    [{ status: 403 }, 'permission'],
    [{ status: 400, code: 'FAILED_PRECONDITION' }, 'permission'],
    [{ status: 404, code: 'NOT_FOUND' }, 'model'],
    [{ status: 400, code: 'INVALID_ARGUMENT' }, 'request'],
    [{ name: 'TimeoutError' }, 'timeout'],
    [{ status: 504 }, 'timeout'],
    [new TypeError('fetch failed'), 'connection'],
    [{ status: 503 }, 'unavailable'],
    [new AiResponseError('incomplete'), 'incomplete'],
  ])('classifies %j as %s', (error, category) => {
    expect(diagnoseAiError(error).category).toBe(category);
  });
  it('never exposes raw errors or arbitrary credential-bearing metadata', () => {
    const secret = 'private-test-secret';
    const result = diagnoseAiError({ status: 401, message: secret, code: secret, headers: { 'x-goog-api-key': secret } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.code).toBeUndefined();
  });
  it('keeps quota failures recoverable without making a shot or automatic retries', async () => {
    let calls = 0;
    const transport: typeof fetch = async () => {
      calls++;
      return response({ error: { message: 'Sensitive provider message', status: 'RESOURCE_EXHAUSTED' } }, 429);
    };
    const game = createGame(randomFleet(), randomFleet());
    game.turn = 'ai';
    const diagnostics: unknown[] = [];
    new AiRunner(createChooser('gemini', model, 'test-key', transport), 1, info => diagnostics.push(info)).start(game, point => fire(game, 'ai', point));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(game.busy).toBe(false);
    expect(game.turn).toBe('ai');
    expect(game.error).toContain('квоти Gemini');
    expect(diagnostics).toEqual([{ category: 'rate_limit', status: 429, code: 'RESOURCE_EXHAUSTED' }]);
    expect(JSON.stringify(diagnostics)).not.toContain('Sensitive provider message');
    expect(game.aiShots).toEqual([]);
    expect(calls).toBe(1);
  });
  it('recognizes Google invalid-key details', async () => {
    const transport: typeof fetch = async () => response({ error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400);
    try { await createChooser('gemini', model, 'test-key', transport)(state()); throw new Error('Expected failure'); }
    catch (error) { expect(diagnoseAiError(error).category).toBe('authentication'); }
  });
  it('handles non-JSON provider errors by HTTP status', async () => {
    const transport: typeof fetch = async () => new Response('upstream failed', { status: 503 });
    try { await createChooser('gemini', model, 'test-key', transport)(state()); throw new Error('Expected failure'); }
    catch (error) { expect(diagnoseAiError(error).category).toBe('unavailable'); }
  });
});
describe('Gemini shot selection', () => {
  it('sends only public knowledge and authenticates using a server header', async () => {
    const input = state();
    let request: any;
    const transport: typeof fetch = async (url, init) => {
      expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
      expect(String(url)).not.toContain('test-key');
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-key');
      expect(init?.signal).toBeDefined();
      request = JSON.parse(init!.body as string);
      return response(success(input.availableTargets[0]));
    };
    expect(await createChooser('gemini', model, 'test-key', transport)(input)).toEqual(input.availableTargets[0]);
    expect(JSON.parse(request.contents[0].parts[0].text)).toEqual(input);
    expect(request.generationConfig.responseFormat.text.mimeType).toBe('application/json');
    expect(request.generationConfig.responseFormat.text.schema.required).toEqual(['row', 'column']);
    expect(JSON.stringify(request)).not.toContain('playerShips');
    expect(JSON.stringify(request)).not.toContain('test-key');
  });
  it.each([
    [{ candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'incomplete'],
    [{ promptFeedback: { blockReason: 'SAFETY' } }, 'refusal'],
    [{ candidates: [{ finishReason: 'SAFETY' }] }, 'refusal'],
    [{ candidates: [] }, 'invalid_response'],
    [null, 'invalid_response'],
    [{ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not JSON' }] } }] }, 'invalid_response'],
    [success({ row: 99, column: 99 }), 'invalid_response'],
    [success({ row: '0', column: 0 }), 'invalid_response'],
    [success({ row: 0, column: 0, extra: true }), 'invalid_response'],
  ])('rejects unusable responses: %j', async (body, category) => {
    const transport: typeof fetch = async () => response(body);
    await expect(createChooser('gemini', model, 'test-key', transport)(state())).rejects.toMatchObject({ category });
  });
  it('rejects an already fired coordinate', async () => {
    const input = state();
    const taken = input.availableTargets.shift()!;
    const transport: typeof fetch = async () => response(success(taken));
    await expect(createChooser('gemini', model, 'test-key', transport)(input)).rejects.toMatchObject({ category: 'invalid_response' });
  });
  it('ignores thought parts and combines text parts', async () => {
    const input = state();
    const text = JSON.stringify(input.availableTargets[0]);
    const transport: typeof fetch = async () => response({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { thought: true, text: 'internal thought' }, { text: text.slice(0, 5) }, { text: text.slice(5) },
    ] } }] });
    expect(await createChooser('gemini', model, 'test-key', transport)(input)).toEqual(input.availableTargets[0]);
  });
  it('rejects blank keys and invalid model names', () => {
    expect(() => createChooser('gemini', model, '   ')).toThrow('GEMINI_API_KEY');
    expect(() => createChooser('gemini', '../bad?key=secret', 'test-key')).toThrow('GEMINI_MODEL');
  });
});
