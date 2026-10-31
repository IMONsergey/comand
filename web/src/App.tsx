import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Command,
  Folder,
  LayoutDashboard,
  Link2,
  ListChecks,
  LogOut,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Sun,
  WifiOff,
  UserRound,
  Check,
} from 'lucide-react';
import type { Overview, SessionInfo, Job } from '../../src/shared/protocol';
import { api, setSession } from './api';
import { Busy, date, DeviceStatus, Empty, ErrorBox, relative, Status } from './components';
import { Jobs, JobDetail, NewJob } from './Jobs';
import { Devices, PairDevice } from './Devices';
import { Projects } from './Projects';
import { Connection } from './Connection';
import { Auth } from './Auth';
import { Account } from './Account';

type Page = 'overview' | 'jobs' | 'devices' | 'projects' | 'connection' | 'account';
const pages = [
  { id: 'overview', label: 'Обзор', icon: LayoutDashboard },
  { id: 'jobs', label: 'Задачи', icon: ListChecks },
  { id: 'devices', label: 'Устройства', icon: Monitor },
  { id: 'projects', label: 'Проекты', icon: Folder },
  { id: 'connection', label: 'Подключение', icon: Link2 },
] as const;
export function App() {
  const [session, updateSession] = useState<SessionInfo | null>(null);
  const principal = useRef<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [newJob, setNewJob] = useState(false);
  const [pair, setPair] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem('comand:theme') === 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('comand:theme', dark ? 'dark' : 'light');
  }, [dark]);
  const acceptSession = useCallback((value: SessionInfo) => {
    const nextPrincipal = value.authenticated ? (value.user?.id ?? 'owner') : null;
    if (principal.current !== nextPrincipal) {
      principal.current = nextPrincipal;
      setOverview(null);
      setLoadError(null);
      setLastUpdated(null);
      setPage('overview');
      setDetail(null);
      setNewJob(false);
      setPair(false);
    }
    setSession(value);
    updateSession(value);
    setAuthError(null);
  }, []);
  const checkSession = useCallback(async () => {
    try {
      acceptSession(await api<SessionInfo>('/session'));
    } catch (error) {
      setAuthError((error as Error).message);
    }
  }, [acceptSession]);
  useEffect(() => {
    void checkSession();
    const unauthorized = () => {
      acceptSession({ authenticated: false, registrationEnabled: true });
      void checkSession();
      setOverview(null);
      setPage('overview');
      setDetail(null);
      setNewJob(false);
      setPair(false);
    };
    window.addEventListener('comand:unauthorized', unauthorized);
    return () => window.removeEventListener('comand:unauthorized', unauthorized);
  }, [checkSession, acceptSession]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const requestedPrincipal = principal.current;
    if (!requestedPrincipal) return;
    setRefreshing(true);
    try {
      const data = await api<Overview>('/overview', { signal });
      if (signal?.aborted || requestedPrincipal !== principal.current) return;
      setOverview(data);
      setLoadError(null);
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      if (
        requestedPrincipal === principal.current &&
        !(error instanceof DOMException && error.name === 'AbortError')
      )
        setLoadError((error as Error).message);
    } finally {
      if (requestedPrincipal === principal.current) setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    if (!session?.authenticated) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    const tick = async () => {
      if (document.hidden) return;
      controller = new AbortController();
      await refresh(controller.signal);
      if (!stopped) timer = setTimeout(tick, 4000);
    };
    const visible = () => {
      clearTimeout(timer);
      if (!document.hidden) void tick();
      else controller?.abort();
    };
    void tick();
    document.addEventListener('visibilitychange', visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [session?.authenticated, refresh]);
  const closeDetail = useCallback(() => setDetail(null), []);
  const closeNewJob = useCallback(() => setNewJob(false), []);
  const closePair = useCallback(() => setPair(false), []);
  async function logout() {
    try {
      await api('/logout', { method: 'POST' });
      acceptSession({
        authenticated: false,
        registrationEnabled: session?.registrationEnabled ?? true,
      });
      setOverview(null);
      setPage('overview');
      setDetail(null);
      setNewJob(false);
      setPair(false);
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }
  if (!session?.authenticated)
    return (
      <Auth
        session={session}
        error={authError}
        onSession={acceptSession}
        retry={checkSession}
        dark={dark}
        onTheme={() => setDark(!dark)}
      />
    );
  const activePage = pages.find((item) => item.id === page) ?? { label: 'Аккаунт' };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        К содержимому
      </a>
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          onClick={(event) => {
            event.preventDefault();
            setPage('overview');
          }}
          aria-label="Comand — обзор"
        >
          <span className="brand-icon">
            <Command size={23} strokeWidth={2.3} />
          </span>
          <span>
            comand<span className="brand-period">.</span>
          </span>
        </a>
        <div className="workspace-label">РАБОЧАЯ СРЕДА</div>
        <nav aria-label="Основная навигация">
          {pages.map((item) => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              aria-current={page === item.id ? 'page' : undefined}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.id === 'jobs' && !!overview?.counts.running && (
                <span className="nav-count">{overview.counts.running}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={`account-nav ${page === 'account' ? 'active' : ''}`}
            onClick={() => setPage('account')}
            aria-label="Аккаунт"
            aria-current={page === 'account' ? 'page' : undefined}
          >
            <span className="avatar-letter">
              {session.user?.name.slice(0, 1).toUpperCase() ?? 'C'}
            </span>
            <span>
              <strong>{session.user?.name ?? 'Владелец сервера'}</strong>
              <small>{session.user?.email ?? 'Личная рабочая среда'}</small>
            </span>
            <ArrowUpRight size={14} />
          </button>
          <div className="local-label">
            <span className="live-dot" />
            <div>
              <strong>Ваша рабочая среда</strong>
              <span>{overview ? `Comand ${overview.version}` : 'Подключение к хабу'}</span>
            </div>
          </div>
          <div className="sidebar-controls">
            <button className="text-button" onClick={() => setDark(!dark)}>
              {dark ? <Sun size={16} /> : <Moon size={16} />}
              {dark ? 'Светлая тема' : 'Тёмная тема'}
            </button>
            <button
              className="icon-button"
              onClick={() => void logout()}
              aria-label="Выйти"
              title="Выйти"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Рабочая среда<span>/</span>
            <strong>{activePage.label}</strong>
          </div>
          <div className="sync-indicator">
            {loadError ? (
              <>
                <WifiOff size={14} />
                <span>Нет связи с хабом</span>
              </>
            ) : (
              <>
                <span className="live-dot" />
                <span>{overview ? 'Данные синхронизированы' : 'Подключаемся'}</span>
              </>
            )}
            <button
              className={`icon-button ${refreshing ? 'refreshing' : ''}`}
              onClick={() => void refresh()}
              aria-label="Обновить данные"
            >
              <RefreshCw size={15} />
            </button>
            <button
              className="icon-button mobile-account"
              onClick={() => setDark(!dark)}
              aria-label={dark ? 'Светлая тема' : 'Тёмная тема'}
            >
              {dark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <button
              className="icon-button mobile-account"
              onClick={() => setPage('account')}
              aria-label="Аккаунт"
            >
              <UserRound size={17} />
            </button>
            <button
              className="icon-button mobile-account"
              onClick={() => void logout()}
              aria-label="Выйти"
            >
              <LogOut size={15} />
            </button>
          </div>
        </header>
        <main id="main">
          <ErrorBox error={loadError} onRetry={() => void refresh()} />
          {!overview ? (
            <div className="initial-loading">
              <Busy>Загружаем рабочую среду</Busy>
            </div>
          ) : (
            <>
              {page === 'overview' && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">ЦЕНТР УПРАВЛЕНИЯ</div>
                      <h1>
                        {overview.devices.length ? 'Рабочая среда' : 'Начнём с подключения'}
                        <span className="title-dot">.</span>
                      </h1>
                      <p>
                        {session.user
                          ? `${session.user.name}, здесь ваши устройства, проекты и задачи.`
                          : 'Устройства, проекты и задачи в одной рабочей среде.'}
                      </p>
                    </div>
                    <button
                      className="button button-primary"
                      onClick={() =>
                        overview.projects.length
                          ? setNewJob(true)
                          : overview.devices.length
                            ? setPage('projects')
                            : setPair(true)
                      }
                    >
                      <Plus size={18} />
                      {overview.projects.length
                        ? 'Новая задача'
                        : overview.devices.length
                          ? 'Создать проект'
                          : 'Подключить устройство'}
                    </button>
                  </div>
                  {!overview.jobs.length && (
                    <section className="onboarding-panel" aria-label="Первые шаги">
                      <div className="onboarding-intro">
                        <span className="eyebrow">БЫСТРЫЙ СТАРТ</span>
                        <h2>От подключения — к первой задаче</h2>
                        <p>Три шага, чтобы работать со своим компьютером из любого места.</p>
                      </div>
                      <div className="onboarding-steps">
                        <button
                          className={overview.devices.length ? 'complete' : 'current'}
                          onClick={() => setPair(true)}
                        >
                          <span className="onboarding-number">
                            {overview.devices.length ? <Check size={16} /> : '01'}
                          </span>
                          <strong>Подключите компьютер</strong>
                          <p>Установите агент на Mac или Linux и разрешите доступ.</p>
                          <span className="onboarding-action">
                            {overview.devices.length ? 'Подключить ещё' : 'Установить агент'}{' '}
                            <ArrowUpRight size={15} />
                          </span>
                        </button>
                        <button
                          className={
                            overview.projects.length
                              ? 'complete'
                              : overview.devices.length
                                ? 'current'
                                : ''
                          }
                          onClick={() => setPage('projects')}
                        >
                          <span className="onboarding-number">
                            {overview.projects.length ? <Check size={16} /> : '02'}
                          </span>
                          <strong>Выберите проект</strong>
                          <p>Укажите рабочую папку и сохраните контекст проекта.</p>
                          <span className="onboarding-action">
                            {overview.projects.length ? 'Открыть проекты' : 'Создать проект'}{' '}
                            <ArrowUpRight size={15} />
                          </span>
                        </button>
                        <button onClick={() => setPage('connection')}>
                          <span className="onboarding-number">03</span>
                          <strong>Подключите AI-чат</strong>
                          <p>Добавьте Comand в ChatGPT или другой MCP-клиент.</p>
                          <span className="onboarding-action">
                            Настроить MCP <ArrowUpRight size={15} />
                          </span>
                        </button>
                      </div>
                    </section>
                  )}
                  {(overview.devices.length > 0 || overview.jobs.length > 0) && (
                    <>
                      <div className="metric-grid">
                        <Metric
                          label="Устройства в сети"
                          value={overview.counts.online}
                          note={`из ${overview.counts.devices} подключённых`}
                          icon={<Monitor size={19} />}
                          onClick={() => setPage('devices')}
                        />
                        <Metric
                          label="Выполняются"
                          value={overview.counts.running}
                          note={`${overview.counts.queued} в очереди`}
                          icon={<ListChecks size={19} />}
                          onClick={() => setPage('jobs')}
                        />
                        <Metric
                          label="Завершены"
                          value={overview.counts.succeeded}
                          note="успешно выполненных задач"
                          icon={<ArrowUpRight size={19} />}
                          onClick={() => setPage('jobs')}
                        />
                        <Metric
                          label="Требуют внимания"
                          value={overview.counts.failed + overview.counts.uncertain}
                          note={
                            overview.counts.uncertain
                              ? `${overview.counts.uncertain} с неизвестным исходом`
                              : 'ошибки и неизвестный исход'
                          }
                          icon={<Command size={19} />}
                          onClick={() => setPage('jobs')}
                        />
                      </div>
                      {overview.counts.uncertain > 0 && (
                        <div className="notice warning">
                          <strong>У некоторых задач неизвестный исход.</strong> Проекты остаются
                          заблокированы до выяснения результата. Не запускайте эти команды повторно
                          без проверки.
                        </div>
                      )}
                      <div className="overview-grid">
                        <section className="panel">
                          <div className="panel-heading">
                            <div>
                              <h2>Последние задачи</h2>
                              <p>Фактическое состояние выполнения</p>
                            </div>
                            <button className="text-button" onClick={() => setPage('jobs')}>
                              Все задачи
                              <ArrowRight size={15} />
                            </button>
                          </div>
                          {overview.jobs.length ? (
                            <div className="recent-jobs">
                              {overview.jobs.slice(0, 6).map((job) => (
                                <button
                                  className="recent-job"
                                  key={job.id}
                                  onClick={() => setDetail(job.id)}
                                >
                                  <span className="operation-icon">
                                    <ListChecks size={19} />
                                  </span>
                                  <span className="job-description">
                                    <strong>{operationTitle(job)}</strong>
                                    <span>
                                      {overview.projects.find(
                                        (project) => project.id === job.projectId,
                                      )?.name ?? job.projectId}{' '}
                                      <span className="separator">·</span> {date(job.createdAt)}
                                    </span>
                                  </span>
                                  <Status state={job.status} />
                                  <ArrowUpRight className="row-arrow" size={17} />
                                </button>
                              ))}
                            </div>
                          ) : (
                            <Empty
                              title="Пока нет задач"
                              action={
                                <button
                                  className="button button-secondary"
                                  onClick={() =>
                                    overview.projects.length
                                      ? setNewJob(true)
                                      : setPage(overview.devices.length ? 'projects' : 'devices')
                                  }
                                >
                                  {overview.projects.length
                                    ? 'Создать первую задачу'
                                    : overview.devices.length
                                      ? 'Создать проект'
                                      : 'Подключить устройство'}
                                  <ArrowRight size={16} />
                                </button>
                              }
                            >
                              Подключите устройство, укажите рабочую папку проекта и отправьте
                              первую операцию.
                            </Empty>
                          )}
                        </section>
                        <section className="panel device-panel">
                          <div className="panel-heading">
                            <div>
                              <h2>Устройства</h2>
                              <p>Состояние подключения</p>
                            </div>
                            <button
                              className="icon-button"
                              aria-label="Подключить устройство"
                              onClick={() => setPair(true)}
                            >
                              <Plus size={19} />
                            </button>
                          </div>
                          {overview.devices.length ? (
                            <div>
                              {overview.devices.slice(0, 5).map((device) => (
                                <div className="device-mini" key={device.id}>
                                  <span className="device-mini-icon">
                                    <Monitor size={21} />
                                  </span>
                                  <div>
                                    <strong>{device.name}</strong>
                                    <small>
                                      {device.platform} · {relative(device.lastSeenAt)}
                                    </small>
                                    <DeviceStatus
                                      online={device.online}
                                      revoked={!!device.revokedAt}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <Empty
                              title="Ваше первое устройство"
                              action={
                                <button className="text-button" onClick={() => setPair(true)}>
                                  Подключить
                                  <ArrowRight size={15} />
                                </button>
                              }
                            >
                              Mac или Linux с доступом к папке проекта.
                            </Empty>
                          )}
                          <div className="panel-bottom">
                            <span className="live-dot" />
                            <span>Статус обновляется автоматически</span>
                          </div>
                        </section>
                      </div>
                      <section className="connection-strip">
                        <span className="connection-strip-icon">
                          <Link2 size={23} />
                        </span>
                        <div>
                          <h3>Работайте из ChatGPT</h3>
                          <p>Подключите Comand через MCP и управляйте задачами из разговора.</p>
                        </div>
                        <button
                          className="button button-secondary"
                          onClick={() => setPage('connection')}
                        >
                          Настроить подключение
                          <ArrowUpRight size={16} />
                        </button>
                      </section>
                    </>
                  )}
                </>
              )}
              {page === 'jobs' && (
                <Jobs
                  jobs={overview.jobs}
                  projects={overview.projects}
                  devices={overview.devices}
                  onNew={() => setNewJob(true)}
                  onSelect={setDetail}
                />
              )}
              {page === 'devices' && (
                <Devices
                  devices={overview.devices}
                  onPair={() => setPair(true)}
                  onChange={refresh}
                />
              )}
              {page === 'projects' && (
                <Projects
                  projects={overview.projects}
                  devices={overview.devices}
                  onChange={refresh}
                  onPair={() => setPair(true)}
                />
              )}
              {page === 'connection' && <Connection />}
              {page === 'account' && <Account session={session} onSession={acceptSession} />}
              <footer className="page-footer">
                <span>COMAND / ВАША РАБОЧАЯ СРЕДА</span>
                <span>
                  Обновлено{' '}
                  {lastUpdated
                    ? new Date(lastUpdated).toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '—'}
                </span>
              </footer>
            </>
          )}
        </main>
      </div>
      {newJob && overview && (
        <NewJob
          projects={overview.projects}
          devices={overview.devices}
          onClose={closeNewJob}
          onCreated={(job) => {
            setNewJob(false);
            setDetail(job.id);
            void refresh();
          }}
        />
      )}
      {pair && (
        <PairDevice
          onClose={closePair}
          onDone={() => {
            setPair(false);
            void refresh();
          }}
        />
      )}
      {detail && overview && (
        <JobDetail
          id={detail}
          project={overview.projects.find(
            (project) => project.id === overview.jobs.find((job) => job.id === detail)?.projectId,
          )}
          onClose={closeDetail}
          onChange={refresh}
        />
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  note,
  icon,
  onClick,
}: {
  label: string;
  value: number;
  note: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="metric" onClick={onClick}>
      <span className="metric-label">
        {label}
        <span>{icon}</span>
      </span>
      <strong>{value.toLocaleString('ru-RU')}</strong>
      <small>{note}</small>
    </button>
  );
}
export function operationTitle(job: Job): string {
  const op = job.operation;
  if (op.kind === 'command') return op.command;
  if (op.kind === 'process.start') return `Запуск процесса · ${op.command}`;
  if (op.kind === 'process.list') return 'Список процессов';
  if (op.kind === 'process.input') return `Ввод в процесс · ${op.sessionId.slice(0, 11)}`;
  if (op.kind === 'process.output') return `Вывод процесса · ${op.sessionId.slice(0, 11)}`;
  if (op.kind === 'process.stop') return `Остановка процесса · ${op.sessionId.slice(0, 11)}`;
  if (op.kind === 'browser.inspect') return op.url;
  if (op.kind === 'files.move') return `${op.from} → ${op.to}`;
  return `${{ 'files.list': 'Список файлов', 'files.read': 'Чтение', 'files.write': 'Запись', 'files.search': 'Поиск', 'files.mkdir': 'Новая папка' }[op.kind]} · ${op.path}`;
}
