import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Ban,
  ChevronDown,
  FileText,
  Globe2,
  Plus,
  Search,
  Terminal,
} from 'lucide-react';
import type {
  Device,
  Job,
  JobState,
  LogChunk,
  Operation,
  Project,
} from '../../src/shared/protocol';
import { jobStates, operationSchema, terminalStates } from '../../src/shared/protocol';
import { api } from './api';
import {
  Busy,
  date,
  Empty,
  ErrorBox,
  Field,
  Modal,
  shortId,
  stateNames,
  Status,
} from './components';
import { operationTitle } from './App';

export function Jobs({
  jobs,
  projects,
  devices,
  onNew,
  onSelect,
}: {
  jobs: Job[];
  projects: Project[];
  devices: Device[];
  onNew: () => void;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<JobState | 'all'>('all');
  const [query, setQuery] = useState('');
  const visible = jobs.filter(
    (job) =>
      (filter === 'all' || job.status === filter) &&
      `${operationTitle(job)} ${job.id} ${projects.find((project) => project.id === job.projectId)?.name ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ИСТОРИЯ И ВЫПОЛНЕНИЕ</div>
          <h1>
            Задачи<span className="title-dot">.</span>
            <span className="heading-count">{jobs.length}</span>
          </h1>
          <p>Каждая операция сохраняется. Состояние остаётся доступным после переподключения.</p>
        </div>
        <button className="button button-primary" onClick={onNew} disabled={!projects.length}>
          <Plus size={18} />
          Новая задача
        </button>
      </div>
      <section className="panel">
        <div className="table-toolbar">
          <div className="search-input">
            <Search size={17} />
            <input
              aria-label="Поиск задач"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Найти по команде, проекту или ID…"
            />
          </div>
          <select
            aria-label="Фильтр по статусу"
            value={filter}
            onChange={(event) => setFilter(event.target.value as JobState | 'all')}
          >
            <option value="all">Все статусы</option>
            {jobStates.map((state) => (
              <option key={state} value={state}>
                {stateNames[state]}
              </option>
            ))}
          </select>
        </div>
        {!visible.length ? (
          <Empty
            title={jobs.length ? 'Задачи не найдены' : 'Первая задача начинается здесь'}
            action={
              jobs.length ? (
                <button
                  className="text-button"
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                >
                  Сбросить фильтры
                </button>
              ) : projects.length ? (
                <button className="button button-secondary" onClick={onNew}>
                  Создать задачу
                  <Plus size={16} />
                </button>
              ) : undefined
            }
          >
            {jobs.length
              ? 'Измените запрос или выберите другой статус.'
              : 'Создайте проект на подключённом устройстве, чтобы выполнять команды и работать с файлами.'}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table className="jobs-table">
              <thead>
                <tr>
                  <th>Операция / ID</th>
                  <th>Проект</th>
                  <th>Статус</th>
                  <th>Создана</th>
                  <th>
                    <span className="sr-only">Открыть</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <button className="table-job-link" onClick={() => onSelect(job.id)}>
                        <span className="table-operation">
                          <OperationIcon operation={job.operation} />
                          <strong>{operationTitle(job)}</strong>
                        </span>
                        <span className="mono subdued">
                          {shortId(job.id)} · {job.operation.kind}
                        </span>
                      </button>
                    </td>
                    <td>
                      <strong className="project-cell">
                        {projects.find((project) => project.id === job.projectId)?.name ??
                          shortId(job.projectId)}
                      </strong>
                      <small>
                        {devices.find((device) => device.id === job.deviceId)?.name ??
                          shortId(job.deviceId)}
                      </small>
                    </td>
                    <td>
                      <Status state={job.status} />
                      {job.cancelRequestedAt && !terminalStates.has(job.status) && (
                        <small>Отмена запрошена</small>
                      )}
                    </td>
                    <td className="date-cell">{date(job.createdAt)}</td>
                    <td>
                      <button
                        className="icon-button"
                        onClick={() => onSelect(job.id)}
                        aria-label={`Открыть задачу ${shortId(job.id)}`}
                      >
                        <ArrowUpRight size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-bottom">
          {visible.length} из {jobs.length} задач<span>Обновляется автоматически</span>
        </div>
      </section>
    </>
  );
}
function OperationIcon({ operation }: { operation: Operation }) {
  return operation.kind === 'command' || operation.kind.startsWith('process.') ? (
    <Terminal size={17} />
  ) : operation.kind === 'browser.inspect' ? (
    <Globe2 size={17} />
  ) : (
    <FileText size={17} />
  );
}
const operations = [
  { value: 'command', label: 'Команда в терминале' },
  { value: 'process.start', label: 'Запустить длительный процесс' },
  { value: 'process.list', label: 'Список процессов проекта' },
  { value: 'process.input', label: 'Отправить ввод в процесс' },
  { value: 'process.output', label: 'Прочитать вывод процесса' },
  { value: 'process.stop', label: 'Остановить процесс' },
  { value: 'files.list', label: 'Список файлов' },
  { value: 'files.read', label: 'Прочитать файл' },
  { value: 'files.write', label: 'Записать файл' },
  { value: 'files.search', label: 'Найти в файлах' },
  { value: 'files.mkdir', label: 'Создать папку' },
  { value: 'files.move', label: 'Переместить файл' },
  { value: 'browser.inspect', label: 'Проверить веб-страницу' },
] as const;
export function NewJob({
  projects,
  devices,
  onClose,
  onCreated,
}: {
  projects: Project[];
  devices: Device[];
  onClose: () => void;
  onCreated: (job: Job) => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [kind, setKind] = useState<Operation['kind']>('command');
  const [command, setCommand] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [processInput, setProcessInput] = useState('');
  const [closeStdin, setCloseStdin] = useState(false);
  const [path, setPath] = useState('.');
  const [content, setContent] = useState('');
  const [query, setQuery] = useState('');
  const [destination, setDestination] = useState('');
  const [url, setUrl] = useState('');
  const [expectedHash, setExpectedHash] = useState('');
  const [createOnly, setCreateOnly] = useState(true);
  const [timeout, setTimeoutValue] = useState(300);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(65536);
  const [maxResults, setMaxResults] = useState(50);
  const [width, setWidth] = useState(1440);
  const [height, setHeight] = useState(1000);
  const [screenshot, setScreenshot] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const lastPayload = useRef('');
  const project = projects.find((item) => item.id === projectId);
  const device = devices.find((item) => item.id === project?.deviceId);
  const capabilityError =
    (kind === 'command' || kind.startsWith('process.')) && !device?.allowShell
      ? 'На устройстве не разрешены команды терминала.'
      : kind === 'browser.inspect' && !device?.allowBrowser
        ? 'На устройстве не разрешена проверка веб-страниц.'
        : device?.revokedAt
          ? 'Доступ к устройству отозван.'
          : null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    let candidate: unknown;
    if (kind === 'command' || kind === 'process.start')
      candidate = { kind, command, timeoutMs: timeout * 1000 };
    else if (kind === 'process.list') candidate = { kind };
    else if (kind === 'process.input')
      candidate = { kind, sessionId, input: processInput, closeStdin };
    else if (kind === 'process.output') candidate = { kind, sessionId, offset, limit };
    else if (kind === 'process.stop') candidate = { kind, sessionId };
    else if (kind === 'files.list') candidate = { kind, path };
    else if (kind === 'files.read') candidate = { kind, path, offset, limit };
    else if (kind === 'files.write')
      candidate = {
        kind,
        path,
        content,
        createOnly,
        ...(!createOnly && expectedHash ? { expectedHash } : {}),
      };
    else if (kind === 'files.search') candidate = { kind, path, query, maxResults };
    else if (kind === 'files.mkdir') candidate = { kind, path };
    else if (kind === 'files.move') candidate = { kind, from: path, to: destination };
    else candidate = { kind, url, width, height, screenshot };
    const parsed = operationSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(
        `Проверьте параметры операции: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      );
      return;
    }
    const signature = JSON.stringify({ projectId, operation: parsed.data });
    if (lastPayload.current && lastPayload.current !== signature) key.current = crypto.randomUUID();
    lastPayload.current = signature;
    setBusy(true);
    try {
      const job = await api<Job>('/jobs', {
        method: 'POST',
        body: { projectId, operation: parsed.data, idempotencyKey: key.current },
      });
      onCreated(job);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Новая задача"
      subtitle="Операция выполнится в папке выбранного проекта."
      onClose={onClose}
      wide
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          <Field label="Проект">
            <select
              required
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Операция">
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as Operation['kind'])}
            >
              {operations.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {project && (
          <div className="context-path">
            <span>{device?.name}</span>
            <code>{project.root}</code>
            {device && !device.online && (
              <small>Устройство не в сети. Задача будет ждать подключения.</small>
            )}
          </div>
        )}
        {(kind === 'command' || kind === 'process.start') && (
          <>
            <Field
              label="Команда"
              hint="Команда имеет права пользователя устройства. Проверьте её перед запуском."
            >
              <textarea
                className="code-input"
                required
                rows={5}
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="Например: git status --short"
                spellCheck={false}
                maxLength={32768}
              />
            </Field>
            <Field label="Максимальное время, секунд">
              <input
                type="number"
                min={1}
                max={86400}
                required
                value={timeout}
                onChange={(event) => setTimeoutValue(Number(event.target.value))}
              />
            </Field>
          </>
        )}
        {kind.startsWith('process.') && (
          <div className="notice">
            Процессы работают через стандартный ввод и вывод, без интерактивного терминала (PTY).
            Запуск возвращает ID сессии; чтение и ввод отправляются отдельными задачами.
          </div>
        )}
        {['process.input', 'process.output', 'process.stop'].includes(kind) && (
          <Field
            label="ID сессии процесса"
            hint="Полный sessionId из результата запуска или списка процессов."
          >
            <input
              className="mono"
              required
              pattern="ps_[a-f0-9]{64}"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              placeholder="ps_…"
            />
          </Field>
        )}
        {kind === 'process.input' && (
          <>
            <Field
              label="Ввод в процесс"
              hint="Для отправки строки добавьте перевод строки клавишей Enter."
            >
              <textarea
                className="code-input"
                rows={4}
                maxLength={65536}
                value={processInput}
                onChange={(event) => setProcessInput(event.target.value)}
                spellCheck={false}
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={closeStdin}
                onChange={(event) => setCloseStdin(event.target.checked)}
              />
              <span>Закрыть стандартный ввод после отправки</span>
            </label>
          </>
        )}
        {kind === 'process.stop' && (
          <div className="notice warning">
            Остановка завершит процесс и его группу. Выполненные изменения сохранятся.
          </div>
        )}
        {kind.startsWith('files.') && (
          <Field
            label={
              kind === 'files.move' ? 'Откуда, относительно проекта' : 'Путь относительно проекта'
            }
            hint="Используйте точку для корня проекта."
          >
            <input
              className="mono"
              required={kind !== 'files.list' && kind !== 'files.search'}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              maxLength={4096}
              placeholder="src/index.ts"
            />
          </Field>
        )}
        {(kind === 'files.read' || kind === 'process.output') && (
          <div className="form-grid">
            <Field label="Смещение, байт">
              <input
                type="number"
                min={0}
                required
                value={offset}
                onChange={(event) => setOffset(Number(event.target.value))}
              />
            </Field>
            <Field label="Объём чтения, байт">
              <input
                type="number"
                min={1}
                max={kind === 'process.output' ? 65536 : 1048576}
                required
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
              />
            </Field>
          </div>
        )}
        {kind === 'files.write' && (
          <>
            <Field label="Содержимое">
              <textarea
                className="code-input"
                rows={7}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                spellCheck={false}
                maxLength={1048576}
              />
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={createOnly}
                onChange={(event) => setCreateOnly(event.target.checked)}
              />
              <span>Создать только новый файл</span>
            </label>
            {!createOnly && (
              <Field
                label="Ожидаемый SHA-256"
                hint="Хеш из files.read защищает от перезаписи чужих изменений. Без хеша файл будет перезаписан."
              >
                <input
                  className="mono"
                  value={expectedHash}
                  onChange={(event) => setExpectedHash(event.target.value)}
                  pattern="[a-f0-9]{64}"
                  placeholder="64 символа, необязательно"
                />
              </Field>
            )}
          </>
        )}
        {kind === 'files.search' && (
          <div className="form-grid">
            <Field label="Искомый текст">
              <input
                required
                maxLength={512}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
            <Field label="Максимум результатов">
              <input
                type="number"
                min={1}
                max={200}
                required
                value={maxResults}
                onChange={(event) => setMaxResults(Number(event.target.value))}
              />
            </Field>
          </div>
        )}
        {kind === 'files.move' && (
          <Field label="Куда, относительно проекта">
            <input
              className="mono"
              required
              maxLength={4096}
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
            />
          </Field>
        )}
        {kind === 'browser.inspect' && (
          <>
            <Field
              label="URL страницы"
              hint="Изолированный Chromium откроет страницу и вернёт метаданные. Браузер должен быть установлен на устройстве."
            >
              <input
                type="url"
                required
                maxLength={4096}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com"
              />
            </Field>
            <div className="form-grid">
              <Field label="Ширина окна, px">
                <input
                  type="number"
                  min={320}
                  max={1920}
                  required
                  value={width}
                  onChange={(event) => setWidth(Number(event.target.value))}
                />
              </Field>
              <Field label="Высота окна, px">
                <input
                  type="number"
                  min={320}
                  max={1600}
                  required
                  value={height}
                  onChange={(event) => setHeight(Number(event.target.value))}
                />
              </Field>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={screenshot}
                onChange={(event) => setScreenshot(event.target.checked)}
              />
              <span>Сохранить снимок страницы</span>
            </label>
          </>
        )}
        <ErrorBox error={capabilityError} />
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className="button button-primary"
            disabled={busy || !projectId || !!capabilityError}
          >
            {busy ? (
              <Busy>Отправляем…</Busy>
            ) : (
              <>
                Создать задачу
                <ArrowRight size={17} />
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function JobDetail({
  id,
  project,
  onClose,
  onChange,
}: {
  id: string;
  project?: Project;
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const finished = useRef(false);
  const offset = useRef(0);
  const inFlight = useRef(false);
  const activeController = useRef<AbortController | null>(null);
  const readLog = useCallback(
    async (signal?: AbortSignal) => {
      const requestedOffset = offset.current;
      const chunk = await api<LogChunk>(
        `/jobs/${encodeURIComponent(id)}/logs?offset=${requestedOffset}&limit=65536`,
        { signal },
      );
      if (signal?.aborted || requestedOffset !== offset.current) return chunk.hasMore;
      if (chunk.nextOffset > offset.current) {
        setLog((text) => text + chunk.text);
        offset.current = chunk.nextOffset;
      }
      setHasMore(chunk.hasMore);
      return chunk.hasMore;
    },
    [id],
  );
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.hidden || inFlight.current) return;
      const controller = new AbortController();
      activeController.current = controller;
      inFlight.current = true;
      try {
        const current = await api<Job>(`/jobs/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (stopped) return;
        setJob(current);
        const more = await readLog(controller.signal);
        finished.current = terminalStates.has(current.status) && !more;
        if (!stopped) setError(null);
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError'))
          setError((cause as Error).message);
      } finally {
        inFlight.current = false;
        if (!stopped && !finished.current) timer = setTimeout(tick, 2000);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (!document.hidden) void tick();
      else activeController.current?.abort();
    };
    void tick();
    document.addEventListener('visibilitychange', visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      activeController.current?.abort();
      inFlight.current = false;
      document.removeEventListener('visibilitychange', visible);
    };
  }, [id, readLog]);
  async function more() {
    setLoadingMore(true);
    try {
      await readLog();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }
  async function cancel() {
    setCancelling(true);
    try {
      setJob(await api<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }));
      setCancelConfirm(false);
      setError(null);
      await onChange();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setCancelling(false);
    }
  }
  return (
    <Modal title="Детали задачи" subtitle={id} onClose={onClose} wide>
      <ErrorBox error={error} />
      {!job ? (
        <Busy>Загружаем задачу</Busy>
      ) : (
        <>
          <div className="detail-status">
            <Status state={job.status} />
            <span>{project?.name ?? shortId(job.projectId)}</span>
          </div>
          {job.status === 'uncertain' && (
            <div className="notice warning">
              Результат выполнения не подтверждён. Проект заблокирован, чтобы не повторить операцию.
              Проверьте устройство и сохранённые результаты.
            </div>
          )}
          {job.cancelRequestedAt && !terminalStates.has(job.status) && (
            <div className="notice">
              Отмена запрошена {date(job.cancelRequestedAt)}. Ожидаем подтверждения устройства.
            </div>
          )}
          <dl className="detail-meta">
            <div>
              <dt>Создана</dt>
              <dd>{date(job.createdAt)}</dd>
            </div>
            <div>
              <dt>Начало</dt>
              <dd>{date(job.startedAt)}</dd>
            </div>
            <div>
              <dt>Завершение</dt>
              <dd>{date(job.finishedAt)}</dd>
            </div>
            <div>
              <dt>Код выхода</dt>
              <dd>{job.exitCode ?? '—'}</dd>
            </div>
          </dl>
          <details className="operation-details" open>
            <summary>
              Параметры операции
              <ChevronDown size={16} />
            </summary>
            <pre>{JSON.stringify(job.operation, null, 2)}</pre>
          </details>
          {job.error && <ErrorBox error={job.error} />}
          <div className="log-heading">
            <h3>Журнал выполнения</h3>
            <span className="mono">
              {offset.current.toLocaleString('ru-RU')} / {job.logBytes.toLocaleString('ru-RU')} байт
            </span>
          </div>
          <pre className="terminal-output" tabIndex={0} aria-label="Журнал выполнения">
            {log ||
              (terminalStates.has(job.status)
                ? 'Операция не записала сообщений в журнал.'
                : 'Ожидаем вывод устройства…')}
          </pre>
          {hasMore && (
            <button
              className="button button-secondary"
              disabled={loadingMore}
              onClick={() => void more()}
            >
              {loadingMore ? <Busy /> : 'Загрузить следующую часть'}
            </button>
          )}
          {job.result !== null && job.result !== undefined && (
            <div className="result-block">
              <h3>Результат</h3>
              <Result value={job.result} />
            </div>
          )}
          {!terminalStates.has(job.status) && (
            <div className="cancel-area">
              {cancelConfirm ? (
                <>
                  <p>
                    Запросить остановку задачи <code>{shortId(job.id)}</code>? Команда может уже
                    внести изменения; они не будут отменены.
                  </p>
                  <div className="inline-actions">
                    <button
                      className="button button-secondary"
                      onClick={() => setCancelConfirm(false)}
                    >
                      Продолжить выполнение
                    </button>
                    <button
                      className="button button-danger"
                      disabled={cancelling}
                      onClick={() => void cancel()}
                    >
                      {cancelling ? <Busy /> : 'Остановить задачу'}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className="button button-secondary"
                  disabled={!!job.cancelRequestedAt}
                  onClick={() => setCancelConfirm(true)}
                >
                  <Ban size={16} />
                  {job.cancelRequestedAt ? 'Отмена запрошена' : 'Остановить задачу'}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
function Result({ value }: { value: unknown }) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const screenshot =
      typeof record.screenshot === 'string' &&
      record.screenshotMime === 'image/jpeg' &&
      /^[A-Za-z0-9+/=]+$/.test(record.screenshot)
        ? record.screenshot
        : null;
    if (screenshot) {
      const rest = { ...record };
      delete rest.screenshot;
      delete rest.screenshotMime;
      return (
        <>
          <img
            className="browser-screenshot"
            src={`data:image/jpeg;base64,${screenshot}`}
            alt="Снимок проверенной веб-страницы"
          />
          <pre className="result-output" tabIndex={0}>
            {JSON.stringify(rest, null, 2)}
          </pre>
        </>
      );
    }
  }
  return (
    <pre className="result-output" tabIndex={0}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
