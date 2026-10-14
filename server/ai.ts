import OpenAI from 'openai';
import { same, type Point } from '../shared/game.js';
import { knowledge, type Game } from './engine.js';
export type ChooseShot = (state: ReturnType<typeof knowledge>) => Promise<Point>;
export function createChooser(mode: 'openai' | 'demo', model: string, apiKey?: string): ChooseShot {
  if (mode === 'demo') return async state => {
    const hits = state.shots.filter(s => s.result === 'hit' && !state.sunkShips.some(ship => ship.some(p => same(p, s))));
    const nearby = state.availableTargets.filter(p => hits.some(h => Math.abs(p.row - h.row) + Math.abs(p.column - h.column) === 1));
    const options = nearby.length ? nearby : state.availableTargets;
    return options[Math.floor(Math.random() * options.length)];
  };
  if (!apiKey) throw new Error('Вкажіть OPENAI_API_KEY або AI_MODE=demo для локальної перевірки.');
  const client = new OpenAI({ apiKey, timeout: 25_000, maxRetries: 0 });
  return async state => {
    const response = await client.responses.create({
      model, store: false, max_output_tokens: 1000,
      instructions: 'You play classic Battleship. Board is 10x10, coordinates are zero-based. Ships are straight, horizontal or vertical, and cannot touch even diagonally. Fleet: 4,3,3,2,2,2,1,1,1,1. You shoot again after a hit or sinking. You only know your previous shots and sunk ships. Choose exactly one coordinate from availableTargets. Pursue unfinished hits and otherwise search strategically. Return only the required JSON coordinate.',
      input: JSON.stringify(state),
      text: { format: {
        type: 'json_schema', name: 'battleship_shot', strict: true,
        schema: { type: 'object', additionalProperties: false, required: ['row', 'column'], properties: {
          row: { type: 'integer', minimum: 0, maximum: 9 },
          column: { type: 'integer', minimum: 0, maximum: 9 },
        } },
      } },
    });
    if (response.status !== 'completed') throw new Error('Incomplete AI response');
    const point = JSON.parse(response.output_text) as Point;
    if (!state.availableTargets.some(p => same(p, point))) throw new Error('Invalid AI target');
    return { row: point.row, column: point.column };
  };
}
export class AiRunner {
  private active = 0;
  constructor(private choose: ChooseShot, private limit: number) {}
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
      } catch {
        game.error = 'Не вдалося отримати хід AI. Натисніть «Повторити хід AI».';
      } finally { game.busy = false; this.active--; }
    })();
  }
}
