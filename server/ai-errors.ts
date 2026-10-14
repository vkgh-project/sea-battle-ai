const messages = {
  authentication: 'OpenAI відхилив API-ключ. Адміністратору потрібно перевірити OPENAI_API_KEY у Render.',
  quota: 'OpenAI API не має доступних коштів або досяг ліміту витрат. Адміністратору потрібно перевірити Billing та Limits в OpenAI.',
  permission: 'Немає дозволу на запити до OpenAI. Адміністратору потрібно перевірити права API-ключа та проєкту.',
  model: 'Обрана модель OpenAI недоступна. Адміністратору потрібно перевірити OPENAI_MODEL та доступ проєкту до моделі.',
  rate_limit: 'OpenAI тимчасово обмежив частоту запитів. Зачекайте хвилину та повторіть хід AI.',
  request: 'OpenAI відхилив формат запиту. Адміністратору потрібно перевірити налаштування моделі та журнал сервера.',
  timeout: 'OpenAI не відповів вчасно. Повторіть хід AI за кілька секунд.',
  connection: 'Сервер не зміг з’єднатися з OpenAI. Повторіть хід AI пізніше.',
  unavailable: 'OpenAI тимчасово недоступний. Повторіть хід AI за кілька секунд.',
  incomplete: 'AI не завершив відповідь. Повторіть хід AI; якщо помилка повторюється, повідомте адміністратора.',
  invalid_response: 'AI повернув некоректний постріл. Повторіть хід AI.',
  refusal: 'AI не надав постріл. Повторіть хід AI.',
  unknown: 'Не вдалося отримати хід AI. Натисніть «Повторити хід AI».',
} as const;
export type AiCategory = keyof typeof messages;
export type AiDiagnostic = { category: AiCategory; status?: number; code?: string; requestId?: string };
export class AiResponseError extends Error {
  constructor(public category: AiCategory) { super(category); }
}
const quotaCodes = new Set(['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'usage_limit_exceeded', 'credits_exhausted']);
const knownCodes = new Set([...quotaCodes, 'invalid_api_key', 'model_not_found', 'rate_limit_exceeded', 'slow_down', 'server_is_overloaded', 'server_overloaded', 'server_error', 'invalid_request_error', 'unsupported_parameter', 'invalid_json_schema', 'permission_denied']);
export function diagnoseAiError(error: unknown): AiDiagnostic & { message: string } {
  const item = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const status = typeof item.status === 'number' && Number.isInteger(item.status) && item.status >= 400 && item.status <= 599 ? item.status : undefined;
  // Do not copy raw messages, response bodies, headers, or arbitrary strings into logs.
  const code = typeof item.code === 'string' && knownCodes.has(item.code) ? item.code : undefined;
  const rawRequestId = item.requestID ?? item.request_id;
  const requestId = typeof rawRequestId === 'string' && /^req_[a-zA-Z0-9_-]{1,150}$/.test(rawRequestId) ? rawRequestId : undefined;
  let category: AiCategory = 'unknown';
  if (error instanceof AiResponseError) category = error.category;
  else if ((code && quotaCodes.has(code)) || item.type === 'insufficient_quota') category = 'quota';
  else if (status === 401 || code === 'invalid_api_key') category = 'authentication';
  else if (code === 'model_not_found' || status === 404) category = 'model';
  else if (status === 403 || code === 'permission_denied') category = 'permission';
  else if (status === 429 || code === 'rate_limit_exceeded' || code === 'slow_down') category = 'rate_limit';
  else if (item.name === 'APIConnectionTimeoutError' || status === 408) category = 'timeout';
  else if (item.name === 'APIConnectionError') category = 'connection';
  else if ((status && status >= 500) || code === 'server_error') category = 'unavailable';
  else if (status === 400 || status === 422) category = 'request';
  return { category, status, code, requestId, message: messages[category] };
}
