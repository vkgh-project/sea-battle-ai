import { inside, type Point } from '../shared/game.js';
import { GameError, knowledge, type Game } from './engine.js';

export const manualRequestId = (game: Game) => `${game.id}:${game.version}`;
export function manualPrompt(game: Game): string {
  return [
    'Ти граєш проти людини в «Морський бій». Зараз твій хід. Обери рівно один постріл.',
    'Поле 10×10. Координати row (рядок) і column (стовпець) — цілі числа від 0 до 9, нумерація починається з нуля.',
    'Флот: 4,3,3,2,2,2,1,1,1,1 клітинок. Кораблі прямі, горизонтальні або вертикальні; не торкаються навіть кутами.',
    'Після влучання чи потоплення ти стріляєш ще раз. Після промаху ходить людина.',
    'shots містить твої попередні постріли: miss — мимо, hit — влучання, sunk — остання уражена клітинка потопленого корабля.',
    'sunkShips містить усі клітинки потоплених кораблів; remainingShips — розміри кораблів, які ще не потоплено.',
    'Обирай тільки з availableTargets. Шукай кораблі стратегічно; насамперед добивай ті, у які вже влучив.',
    'Використовуй лише стан нижче. Попередні повідомлення можуть належати іншій партії або старому ходу. Прихований флот тобі невідомий.',
    'Поверни лише один JSON-об’єкт без пояснень. Скопіюй requestId без змін, заміни row і column на обрану координату:',
    JSON.stringify({ requestId: manualRequestId(game), row: 0, column: 0 }),
    'Координата в прикладі показує лише формат; перевір доступні клітинки перед вибором.',
    '\nАктуальний стан:',
    JSON.stringify(knowledge(game), null, 2),
  ].join('\n');
}

export function parseManualResponse(text: string, game: Game): Point {
  // Accept ChatGPT's usual fenced JSON, but never evaluate code or guess from prose.
  const cleaned = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); }
  catch { throw new GameError('Вставте JSON-відповідь ChatGPT повністю, без додаткових пояснень.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new GameError('Відповідь має бути JSON-об’єктом із requestId, row та column.');
  const data = parsed as Record<string, unknown>;
  if (Object.keys(data).length !== 3 || !['requestId', 'row', 'column'].every(field => field in data)) {
    throw new GameError('Потрібні лише три поля: requestId, row та column. Скопіюйте весь JSON із ChatGPT.');
  }
  if (data.requestId !== manualRequestId(game)) throw new GameError('Це відповідь на інший або застарілий хід. Скопіюйте актуальний промпт і отримайте нову відповідь.', 409);
  if (typeof data.row !== 'number' || typeof data.column !== 'number' || !inside({ row: data.row, column: data.column })) {
    throw new GameError('row та column мають бути цілими числами від 0 до 9.');
  }
  return { row: data.row, column: data.column };
}
