import { buildApp } from './app.js';
import { createChooser } from './ai.js';
function positiveEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} має бути додатним цілим числом.`);
  return value;
}
const mode = process.env.AI_MODE ?? 'gemini';
if (mode !== 'gemini' && mode !== 'demo') throw new Error('AI_MODE має бути gemini або demo.');
const production = process.env.NODE_ENV === 'production';
const origin = process.env.APP_ORIGIN?.replace(/\/$/, '');
if (production && !origin) throw new Error('У production потрібно вказати APP_ORIGIN.');
const app = await buildApp({
  choose: createChooser(mode, process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite', process.env.GEMINI_API_KEY),
  mode, production, origin, logger: true,
  maxSessions: positiveEnv('MAX_SESSIONS', 1000),
  maxAiConcurrency: positiveEnv('MAX_AI_CONCURRENCY', 1),
  ttlMs: positiveEnv('SESSION_TTL_MINUTES', 60) * 60_000,
});
await app.listen({ port: positiveEnv('PORT', 3000), host: '0.0.0.0' });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  void app.close().then(() => process.exit(0));
});
