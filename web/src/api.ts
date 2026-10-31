import type { SessionInfo } from '../../src/shared/protocol';
let csrfToken: string | undefined;
let sessionGeneration = 0;
export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export function setSession(session: SessionInfo) {
  sessionGeneration++;
  csrfToken = session.csrfToken;
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const generation = sessionGeneration;
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    signal: options.signal,
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && csrfToken ? { 'X-Comand-CSRF': csrfToken } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
        ? data.code
        : '';
    if (
      response.status === 401 &&
      generation === sessionGeneration &&
      !['/login', '/session', '/register', '/recover'].includes(path) &&
      !(path === '/account/password' && code === 'invalid_credentials')
    )
      window.dispatchEvent(new Event('comand:unauthorized'));
    const authMessages: Record<string, string> = {
      invalid_credentials:
        path === '/account/password'
          ? 'Текущий пароль не подходит. Проверьте его и попробуйте ещё раз.'
          : path === '/recover'
            ? 'Проверьте email и код восстановления. Данные не подошли.'
            : 'Не удалось войти. Проверьте данные и попробуйте ещё раз.',
      email_in_use: 'Этот email уже зарегистрирован. Войдите или восстановите доступ.',
      registration_disabled: 'Регистрация на этом сервере отключена.',
      already_claimed: 'К этой рабочей среде уже привязан аккаунт.',
      rate_limited: 'Слишком много попыток. Подождите немного и попробуйте снова.',
    };
    const accountPath = [
      '/register',
      '/login',
      '/recover',
      '/account/password',
      '/account/claim',
    ].includes(path);
    const message =
      authMessages[code] ??
      (accountPath && code === 'invalid_request'
        ? 'Проверьте имя, email и пароль. Новый пароль должен содержать от 12 до 128 символов.'
        : undefined) ??
      (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Сервер вернул ошибку ${response.status}`);
    throw new HttpError(message, response.status);
  }
  return data as T;
}
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
