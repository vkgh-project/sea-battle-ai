import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { randomFleet, type AiMode, type Ship } from '../shared/game.js';
import { AiRunner, type ChooseShot } from './ai.js';
import { createGame, fire, GameError, view, type Game } from './engine.js';
import { manualPrompt, parseManualResponse } from './manual.js';
type Session = { expiresAt: number; game: Game | null; lastCreation: number };
export type AppOptions = {
  choose?: ChooseShot; mode?: AiMode; production?: boolean; origin?: string;
  maxSessions?: number; ttlMs?: number; maxAiConcurrency?: number; logger?: boolean;
};
export async function buildApp(options: AppOptions = {}) {
  const sessions = new Map<string, Session>();
  const ttl = options.ttlMs ?? 3_600_000;
  const maxSessions = options.maxSessions ?? 1000;
  const mode = options.mode ?? 'manual';
  const app = Fastify({ bodyLimit: 16_384, logger: options.logger ? { redact: ['req.headers.cookie', 'req.headers.authorization'] } : false });
  const runner = new AiRunner(options.choose ?? (async () => { throw new Error('AI chooser is not configured'); }), options.maxAiConcurrency ?? 8,
    diagnostic => app.log.warn({ event: 'ai_turn_failed', model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini', ...diagnostic }, 'AI turn failed'));
  const publicView = (game: Game) => ({ ...view(game),
    ...(mode === 'manual' && game.phase === 'playing' && game.turn === 'ai' ? { manualPrompt: manualPrompt(game) } : {}),
  });
  await app.register(cookie);
  const cookieName = options.production ? '__Host-seabattle' : 'seabattle';
  await app.register(rateLimit, {
    max: 300, timeWindow: '1 minute',
    keyGenerator: req => {
      const token = req.cookies[cookieName];
      return token && sessions.has(token) ? `session:${token}` : `ip:${req.ip}`;
    },
  });
  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: !!options.production, maxAge: Math.ceil(ttl / 1000) };
  function sweep() {
    const now = Date.now();
    for (const [token, session] of sessions) if (session.expiresAt <= now && !session.game?.busy) sessions.delete(token);
  }
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); sessions.clear(); });
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (req.method === 'POST') {
      if (req.headers['x-game-request'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') throw new GameError('Запит із чужого сайту заборонений.', 403);
      if (options.origin && req.headers.origin && req.headers.origin !== options.origin) throw new GameError('Невідоме джерело запиту.', 403);
    }
  });
  const coordinate = { type: 'object', additionalProperties: false, required: ['row', 'column'], properties: {
    row: { type: 'integer', minimum: 0, maximum: 9 }, column: { type: 'integer', minimum: 0, maximum: 9 },
  } };
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/session', async (req, reply) => {
    sweep();
    let token = req.cookies[cookieName];
    let session = token ? sessions.get(token) : undefined;
    if (!session) {
      if (sessions.size >= maxSessions) throw new GameError('Сервер заповнений. Спробуйте пізніше.', 503);
      token = randomBytes(32).toString('base64url');
      session = { expiresAt: Date.now() + ttl, game: null, lastCreation: 0 };
      sessions.set(token, session);
    }
    session.expiresAt = Date.now() + ttl;
    reply.setCookie(cookieName, token!, cookieOptions);
    return { game: session.game ? publicView(session.game) : null, aiMode: mode };
  });
  function sessionFor(token?: string) {
    const session = token ? sessions.get(token) : undefined;
    if (!session || (session.expiresAt <= Date.now() && !session.game?.busy)) throw new GameError('Сесія завершилась. Оновіть сторінку.', 401);
    session.expiresAt = Date.now() + ttl;
    return session;
  }
  function ownedGame(token: string | undefined, id: string) {
    const session = sessionFor(token);
    if (!session.game || session.game.id !== id) throw new GameError('Партію не знайдено у вашій сесії.', 404);
    return session.game;
  }
  app.post<{ Body: { ships: Ship[] } }>('/api/game', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['ships'], properties: {
      ships: { type: 'array', minItems: 10, maxItems: 10, items: { type: 'array', minItems: 1, maxItems: 4, items: coordinate } },
    } } },
  }, async (req, reply) => {
    const session = sessionFor(req.cookies[cookieName]);
    if (session.game?.busy) throw new GameError('Дочекайтеся завершення ходу AI.', 409);
    if (Date.now() - session.lastCreation < 3000) throw new GameError('Зачекайте кілька секунд перед новою партією.', 429);
    session.game = createGame(req.body.ships, randomFleet());
    session.lastCreation = Date.now();
    reply.setCookie(cookieName, req.cookies[cookieName]!, cookieOptions);
    return publicView(session.game);
  });
  app.get<{ Params: { id: string } }>('/api/game/:id', async (req, reply) => {
    const game = ownedGame(req.cookies[cookieName], req.params.id);
    reply.setCookie(cookieName, req.cookies[cookieName]!, cookieOptions);
    return publicView(game);
  });
  app.post<{ Params: { id: string }; Body: { row: number; column: number; version: number } }>('/api/game/:id/shot', {
    schema: { body: { ...coordinate, required: ['row', 'column', 'version'], properties: {
      ...coordinate.properties, version: { type: 'integer', minimum: 0 },
    } } },
  }, async req => {
    const game = ownedGame(req.cookies[cookieName], req.params.id);
    if (game.busy || game.version !== req.body.version) throw new GameError('Стан гри змінився. Оновлюємо поле.', 409);
    fire(game, 'human', { row: req.body.row, column: req.body.column });
    if (mode !== 'manual') runner.start(game, point => fire(game, 'ai', point));
    return publicView(game);
  });
  app.post<{ Params: { id: string }; Body: { response: string; version: number } }>('/api/game/:id/ai-response', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['response', 'version'], properties: {
      response: { type: 'string', minLength: 1, maxLength: 8000 }, version: { type: 'integer', minimum: 0 },
    } } },
  }, async req => {
    const game = ownedGame(req.cookies[cookieName], req.params.id);
    if (mode !== 'manual') throw new GameError('Введення відповіді доступне лише в ручному режимі.', 409);
    if (game.busy || game.turn !== 'ai' || game.phase !== 'playing' || game.version !== req.body.version) {
      throw new GameError('Цей хід уже завершено або стан гри змінився.', 409);
    }
    const point = parseManualResponse(req.body.response, game);
    fire(game, 'ai', point);
    return publicView(game);
  });
  app.post<{ Params: { id: string } }>('/api/game/:id/retry', async req => {
    const game = ownedGame(req.cookies[cookieName], req.params.id);
    if (mode === 'manual') throw new GameError('Скопіюйте промпт і вставте відповідь ChatGPT.', 409);
    if (game.busy || game.turn !== 'ai' || game.phase !== 'playing') throw new GameError('Повтор зараз недоступний.', 409);
    runner.start(game, point => fire(game, 'ai', point));
    return publicView(game);
  });
  app.setErrorHandler((error, _req, reply) => {
    const reported = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    const status = error instanceof GameError ? error.statusCode : typeof reported === 'number' ? reported : 500;
    const message = error instanceof GameError ? error.message
      : status === 429 ? 'Забагато запитів. Зачекайте хвилину.'
      : status < 500 ? 'Некоректний запит.' : 'Помилка сервера. Спробуйте ще раз.';
    reply.status(status).send({ error: message });
  });
  const clientRoot = resolve('dist/client');
  if (existsSync(clientRoot)) await app.register(staticFiles, { root: clientRoot });
  return app;
}
