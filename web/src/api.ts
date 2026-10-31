import type { SessionInfo } from '../../src/shared/protocol';
let csrfToken: string | undefined;
export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export function setSession(session: SessionInfo) {
  csrfToken = session.csrfToken;
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
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
    if (response.status === 401 && path !== '/login' && path !== '/session')
      window.dispatchEvent(new Event('comand:unauthorized'));
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Сервер вернул ошибку ${response.status}`;
    throw new HttpError(message, response.status);
  }
  return data as T;
}
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
