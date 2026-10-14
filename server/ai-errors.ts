const messages = {
  authentication: 'Gemini відхилив API-ключ. Адміністратору потрібно перевірити GEMINI_API_KEY.',
  permission: 'Немає доступу до Gemini API. Адміністратору потрібно перевірити права ключа, проєкт і доступність API у своєму регіоні.',
  model: 'Обрана модель Gemini недоступна. Адміністратору потрібно перевірити GEMINI_MODEL.',
  rate_limit: 'Досягнуто ліміту запитів або безкоштовної квоти Gemini. Зачекайте та повторіть хід AI. Якщо денну квоту вичерпано, дочекайтеся її поновлення.',
  request: 'Gemini відхилив формат запиту. Адміністратору потрібно перевірити налаштування моделі та журнал сервера.',
  timeout: 'Gemini не відповів вчасно. Повторіть хід AI за кілька секунд.',
  connection: 'Сервер не зміг з’єднатися з Gemini. Повторіть хід AI пізніше.',
  unavailable: 'Gemini тимчасово недоступний. Повторіть хід AI за кілька секунд.',
  incomplete: 'Gemini не завершив відповідь. Повторіть хід AI; якщо помилка повторюється, повідомте адміністратора.',
  invalid_response: 'Gemini повернув некоректний постріл. Повторіть хід AI.',
  refusal: 'Gemini не надав постріл. Повторіть хід AI.',
  unknown: 'Не вдалося отримати хід AI. Натисніть «Повторити хід AI».',
} as const;
export type AiCategory = keyof typeof messages;
export type AiDiagnostic = { category: AiCategory; status?: number; code?: string };
export class AiResponseError extends Error {
  constructor(public category: AiCategory) { super(category); }
}
const knownCodes = new Set(['API_KEY_INVALID', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'DEADLINE_EXCEEDED', 'UNAVAILABLE', 'INTERNAL']);
export function diagnoseAiError(error: unknown): AiDiagnostic & { message: string } {
  const item = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const status = typeof item.status === 'number' && Number.isInteger(item.status) && item.status >= 400 && item.status <= 599 ? item.status : undefined;
  // Never log raw provider messages, response bodies, headers, or arbitrary codes.
  const code = typeof item.code === 'string' && knownCodes.has(item.code) ? item.code : undefined;
  let category: AiCategory = 'unknown';
  if (error instanceof AiResponseError) category = error.category;
  else if (status === 401 || code === 'API_KEY_INVALID' || code === 'UNAUTHENTICATED') category = 'authentication';
  else if (status === 404 || code === 'NOT_FOUND') category = 'model';
  else if (status === 403 || code === 'PERMISSION_DENIED' || code === 'FAILED_PRECONDITION') category = 'permission';
  else if (status === 429 || code === 'RESOURCE_EXHAUSTED') category = 'rate_limit';
  else if (item.name === 'TimeoutError' || item.name === 'AbortError' || status === 408 || status === 504 || code === 'DEADLINE_EXCEEDED') category = 'timeout';
  else if (error instanceof TypeError) category = 'connection';
  else if ((status && status >= 500) || code === 'UNAVAILABLE' || code === 'INTERNAL') category = 'unavailable';
  else if (status === 400 || status === 422 || code === 'INVALID_ARGUMENT') category = 'request';
  return { category, status, code, message: messages[category] };
}
