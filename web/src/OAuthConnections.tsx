import { useCallback, useEffect, useState } from 'react';
import { Link2, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { api } from './api';
import { Busy, date, Empty, ErrorBox, Modal, shortId } from './components';

interface OAuthConnection {
  id: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
const scopeLabels: Record<string, string> = {
  'comand:read': 'Просмотр устройств, проектов, файлов и результатов',
  'comand:write': 'Изменение файлов и заметок проектов',
  'comand:execute': 'Запуск и остановка команд',
};
export function OAuthConnections() {
  const [connections, setConnections] = useState<OAuthConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [selected, setSelected] = useState<OAuthConnection | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const values = await api<OAuthConnection[]>('/connections', { signal });
      if (!signal?.aborted) {
        setConnections(values);
        setLoadError(null);
      }
    } catch (error) {
      if (!signal?.aborted) setLoadError((error as Error).message);
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    const tick = async () => {
      if (document.hidden) return;
      controller = new AbortController();
      await load(controller.signal);
      if (!stopped) timer = setTimeout(tick, 10000);
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.hidden) controller?.abort();
      else void tick();
    };
    void tick();
    document.addEventListener('visibilitychange', visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load]);
  const closeConfirm = useCallback(() => {
    setSelected(null);
    setActionError(null);
  }, []);
  async function revoke() {
    if (!selected) return;
    setRevoking(true);
    setActionError(null);
    try {
      await api<{ revoked: true }>(`/connections/${encodeURIComponent(selected.id)}/revoke`, {
        method: 'POST',
        body: {},
      });
      setConnections(
        (previous) =>
          previous?.map((connection) =>
            connection.id === selected.id
              ? { ...connection, revokedAt: new Date().toISOString() }
              : connection,
          ) ?? null,
      );
      setSelected(null);
      await load();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setRevoking(false);
    }
  }
  return (
    <section className="panel oauth-connections">
      <div className="panel-heading">
        <div>
          <h2>
            <ShieldCheck size={19} />
            Авторизованные приложения
          </h2>
          <p>Подключения через OAuth и выданные им права</p>
        </div>
        <button
          className={`icon-button ${refreshing ? 'refreshing' : ''}`}
          onClick={() => void load()}
          aria-label="Обновить подключения"
        >
          <RefreshCw size={17} />
        </button>
      </div>
      {loadError && (
        <div className="oauth-load-error">
          <ErrorBox error={loadError} onRetry={() => void load()} />
        </div>
      )}
      {!connections && !loadError && (
        <div className="oauth-loading">
          <Busy>Загружаем подключения</Busy>
        </div>
      )}
      {connections?.length === 0 && (
        <Empty title="Приложения ещё не подключены">
          Добавьте MCP-сервер в ChatGPT или другом клиенте и подтвердите доступ. Здесь появятся
          выданные разрешения.
        </Empty>
      )}
      {!!connections?.length && (
        <div className="oauth-list">
          {connections.map((connection) => (
            <article className="oauth-connection" key={connection.id}>
              <div className="oauth-client-icon">
                <Link2 size={21} />
              </div>
              <div className="oauth-client-details">
                <div className="oauth-client-title">
                  <h3>{connection.clientName}</h3>
                  <span
                    className={`status ${connection.revokedAt ? 'status-muted' : 'status-succeeded'}`}
                  >
                    <i />
                    {connection.revokedAt ? 'Доступ отозван' : 'Активно'}
                  </span>
                </div>
                <div className="oauth-client-meta">
                  <span>Подключено {date(connection.createdAt)}</span>
                  <span>
                    {connection.lastUsedAt
                      ? `Последнее обращение ${date(connection.lastUsedAt)}`
                      : 'Ещё не использовалось'}
                  </span>
                  <code title={connection.clientId}>ID {shortId(connection.clientId)}</code>
                </div>
                <ul className="oauth-scopes" aria-label="Выданные права">
                  {connection.scopes.map((scope) => (
                    <li key={scope}>{scopeLabels[scope] ?? scope}</li>
                  ))}
                </ul>
                {connection.revokedAt && (
                  <p className="oauth-revoked-at">Доступ отозван {date(connection.revokedAt)}</p>
                )}
              </div>
              {!connection.revokedAt && (
                <button
                  className="button button-secondary oauth-revoke"
                  onClick={() => {
                    setSelected(connection);
                    setActionError(null);
                  }}
                >
                  <Unplug size={15} />
                  Отозвать доступ
                </button>
              )}
            </article>
          ))}
        </div>
      )}
      {selected && (
        <Modal title={`Отозвать доступ: ${selected.clientName}`} onClose={closeConfirm}>
          <p className="modal-copy">
            Приложение <strong>{selected.clientName}</strong> (подключение{' '}
            <code>{shortId(selected.id)}</code>) больше не сможет обращаться к Comand с выданными
            OAuth-токенами. Для возврата доступа понадобится новая авторизация.
          </p>
          <div className="notice">
            Уже созданные задачи продолжат выполняться. Чтобы остановить задачу, откройте её и
            запросите отмену.
          </div>
          <ErrorBox error={actionError} />
          <div className="modal-actions">
            <button className="button button-secondary" onClick={closeConfirm}>
              Сохранить доступ
            </button>
            <button
              className="button button-danger"
              disabled={revoking}
              onClick={() => void revoke()}
            >
              {revoking ? <Busy>Отзываем…</Busy> : 'Отозвать доступ'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
