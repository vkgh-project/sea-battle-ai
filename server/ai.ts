import { same, type AiMode, type Point } from '../shared/game.js';
import { knowledge, type Game } from './engine.js';
import { AiResponseError, GeminiRequestError, diagnoseAiError, type AiDiagnostic } from './ai-errors.js';
export type ChooseShot = (state: ReturnType<typeof knowledge>) => Promise<Point>;
type GeminiResponse = {
  error?: { message?: string; status?: string; details?: { reason?: string }[] };
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
};
export function createChooser(mode: AiMode, model: string, apiKey?: string, transport: typeof fetch = fetch): ChooseShot {
  if (mode === 'demo') return async state => {
    const hits = state.shots.filter(s => s.result === 'hit' && !state.sunkShips.some(ship => ship.some(p => same(p, s))));
    const nearby = state.availableTargets.filter(p => hits.some(h => Math.abs(p.row - h.row) + Math.abs(p.column - h.column) === 1));
    const options = nearby.length ? nearby : state.availableTargets;
    return options[Math.floor(Math.random() * options.length)];
  };
  if (!apiKey?.trim()) throw new Error('Вкажіть GEMINI_API_KEY або AI_MODE=demo для локальної перевірки.');
  if (!/^[a-zA-Z0-9._-]+$/.test(model.trim())) throw new Error('GEMINI_MODEL має містити назву моделі Gemini.');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model.trim()}:generateContent`;
  return async state => {
    const targets = new Map(state.availableTargets.map(point => [`${point.row},${point.column}`, point]));
    if (!targets.size) throw new AiResponseError('invalid_response', 'no_available_targets');
    let response: Response;
    let data: GeminiResponse;
    try {
      response = await transport(endpoint, {
        method: 'POST', signal: AbortSignal.timeout(25_000),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'You play classic Battleship. Board is 10x10, coordinates are zero-based. Ships are straight, horizontal or vertical, and cannot touch even diagonally. Fleet: 4,3,3,2,2,2,1,1,1,1. You shoot again after a hit or sinking. You only know your previous shots and sunk ships. Choose exactly one coordinate from availableTargets. Pursue unfinished hits and otherwise search strategically. Return JSON with a single target field, formatted as "row,column", for example {"target":"0,0"}. Select only a target allowed by the response schema.' }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(state) }] }],
          generationConfig: {
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT', required: ['target'], properties: {
                target: { type: 'STRING', format: 'enum', enum: [...targets.keys()] },
              },
            },
          },
        }),
      });
      try { data = await response.json() as GeminiResponse; }
      catch {
        if (!response.ok) throw Object.assign(new Error('Gemini request failed'), { status: response.status });
        throw new AiResponseError('invalid_response', 'http_not_json');
      }
    } catch (error) {
      if (error instanceof TypeError) throw new AiResponseError('connection');
      throw error;
    }
    if (!response.ok || data?.error) {
      const reason = data?.error?.details?.find(detail => detail.reason === 'API_KEY_INVALID')?.reason;
      throw new GeminiRequestError(response.status, reason ?? data?.error?.status, data?.error?.message, apiKey.trim());
    }
    if (data?.promptFeedback?.blockReason) throw new AiResponseError('refusal');
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') throw new AiResponseError('incomplete');
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') throw new AiResponseError('refusal');
    if (!candidate) throw new AiResponseError('invalid_response', 'missing_candidate');
    if (candidate.finishReason !== 'STOP') throw new AiResponseError('invalid_response', 'missing_finish_reason');
    const text = candidate.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('')?.trim() ?? '';
    if (!text) throw new AiResponseError('invalid_response', 'empty_text');
    // Some models wrap otherwise valid JSON in Markdown even when JSON output is requested.
    const json = text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    let answer: unknown;
    try { answer = JSON.parse(json); }
    catch { throw new AiResponseError('invalid_response', 'invalid_json'); }
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)
      || !('target' in answer) || typeof answer.target !== 'string') {
      throw new AiResponseError('invalid_response', 'invalid_shape');
    }
    const point = targets.get(answer.target);
    if (!point) throw new AiResponseError('invalid_response', 'unavailable_target');
    return { row: point.row, column: point.column };
  };
}
export class AiRunner {
  private active = 0;
  constructor(private choose: ChooseShot, private limit: number, private report: (diagnostic: AiDiagnostic) => void = () => {}) {}
  start(game: Game, onShot: (point: Point) => void): void {
    if (game.busy || game.phase !== 'playing' || game.turn !== 'ai') return;
    if (this.active >= this.limit) {
      game.error = 'Сервер зайнятий. Повторіть хід AI за кілька секунд.';
      return;
    }
    game.busy = true;
    game.error = null;
    this.active++;
    void (async () => {
      try {
        while (game.phase === 'playing' && game.turn === 'ai') {
          const point = await this.choose(knowledge(game));
          onShot(point);
        }
      } catch (error) {
        const { message, ...diagnostic } = diagnoseAiError(error);
        game.error = message;
        this.report(diagnostic);
      } finally { game.busy = false; this.active--; }
    })();
  }
}
