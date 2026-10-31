import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { Device, Project } from '../../src/shared/protocol';
import type { Discovery } from '../../src/shared/discovery';
import { api } from './api';
import { Busy, ErrorBox, Field, Modal } from './components';

export function ProjectSearch({
  devices,
  projects,
  onClose,
  onSaved,
  onManual,
}: {
  devices: Device[];
  projects: Project[];
  onClose: () => void;
  onSaved: (project?: Project) => Promise<void>;
  onManual: () => void;
}) {
  const [deviceId, setDeviceId] = useState(devices.length === 1 ? devices[0]!.id : '');
  const [query, setQuery] = useState('');
  const [searchPath, setSearchPath] = useState('');
  const [search, setSearch] = useState<Discovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const device = devices.find((item) => item.id === deviceId);
  const known = projects.filter(
    (project) =>
      project.deviceId === deviceId &&
      `${project.name} ${project.root}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (!search || search.status !== 'queued') return;
    const controller = new AbortController();
    const current = generation.current;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api<Discovery>(`/discoveries/${encodeURIComponent(search!.id)}`, {
          signal: controller.signal,
        });
        if (current !== generation.current) return;
        setSearch(next);
        setError(null);
        if (next.status === 'queued') timer = setTimeout(() => void poll(), 1500);
      } catch (cause) {
        if (controller.signal.aborted || current !== generation.current) return;
        setError((cause as Error).message);
        timer = setTimeout(() => void poll(), 3000);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [search?.id, search?.status]);
  function reset() {
    generation.current++;
    setSearch(null);
    setError(null);
    setBusy(false);
  }
  async function find() {
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setSearch(null);
    try {
      const next = await api<Discovery>('/discoveries', {
        method: 'POST',
        body: { deviceId, query, ...(searchPath ? { path: searchPath } : {}) },
      });
      if (generation.current === current) setSearch(next);
    } catch (cause) {
      if (generation.current === current) setError((cause as Error).message);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  async function select(root: string) {
    if (!search) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api<Project>('/projects/open', {
        method: 'POST',
        body: { discoveryId: search.id, root },
      });
      await onSaved(project);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Найти проект"
      subtitle="Сначала найдём существующую папку. Поиск не создаёт и не меняет файлы."
      onClose={onClose}
      wide
    >
      <Field label="Устройство для поиска">
        <select
          disabled={busy || search?.status === 'queued'}
          value={deviceId}
          onChange={(event) => {
            reset();
            setDeviceId(event.target.value);
            setSearchPath('');
          }}
        >
          <option value="" disabled>
            Выберите устройство
          </option>
          {devices.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
              {item.online ? '' : ' · не в сети'}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Название или часть пути">
        <input
          disabled={busy || search?.status === 'queued'}
          value={query}
          onChange={(event) => {
            reset();
            setQuery(event.target.value);
          }}
          placeholder="Например: comand или сайт клиента"
          maxLength={200}
        />
      </Field>
      {known.length > 0 && (
        <section className="project-search-results" aria-label="Уже добавленные проекты">
          <h3>Уже добавлены</h3>
          {known.map((project) => (
            <div className="project-search-row" key={project.id}>
              <div>
                <strong>{project.name}</strong>
                <code>{project.root}</code>
              </div>
              <button className="button button-secondary" onClick={() => void onSaved(project)}>
                Использовать
              </button>
            </div>
          ))}
        </section>
      )}
      <div className="allowed-roots">
        <span>Ищем только в этих папках</span>
        {device?.roots.map((root) => (
          <code key={root}>{root}</code>
        ))}
      </div>
      <details className="pair-advanced">
        <summary>Уточнить папку поиска</summary>
        <Field label="Папка поиска">
          <input
            disabled={busy || search?.status === 'queued'}
            value={searchPath}
            onChange={(event) => {
              reset();
              setSearchPath(event.target.value);
            }}
            placeholder="Абсолютный путь внутри разрешённых папок"
          />
        </Field>
      </details>
      <button
        className="button button-primary"
        disabled={
          busy || search?.status === 'queued' || !device?.online || !device.projectDiscovery
        }
        onClick={() => void find()}
      >
        {busy || search?.status === 'queued' ? (
          <Busy>Ищем на устройстве…</Busy>
        ) : (
          <>
            <Search size={17} />
            Найти на устройстве
          </>
        )}
      </button>
      {!device ? (
        <p role="status">Выберите компьютер, на котором находится проект.</p>
      ) : !device.online ? (
        <p role="status">Устройство не в сети. Поиск станет доступен после подключения.</p>
      ) : (
        !device.projectDiscovery && (
          <p role="status">
            Обновите агент на этом устройстве, чтобы искать проекты без ручного ввода пути.
          </p>
        )
      )}
      <ErrorBox error={error || search?.error || null} />
      {search?.result && (
        <section className="project-search-results" aria-label="Найденные папки">
          <h3>Найдено: {search.result.candidates.length}</h3>
          {search.result.candidates.map((candidate) => {
            const existing = projects.find(
              (project) => project.deviceId === deviceId && project.root === candidate.root,
            );
            return (
              <div className="project-search-row" key={candidate.root}>
                <div>
                  <strong>{candidate.name}</strong>
                  <code>{candidate.root}</code>
                  <small>
                    {existing
                      ? 'Уже добавлен — будет использован существующий проект'
                      : candidate.markers.join(' · ') || 'Совпадение по пути'}
                  </small>
                </div>
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void select(candidate.root)}
                >
                  {existing ? 'Использовать' : 'Выбрать папку'}
                </button>
              </div>
            );
          })}
          {!search.result.candidates.length && (
            <p>
              В проверенной области совпадений нет. Уточните название или путь; проект может
              находиться в другой папке.
            </p>
          )}
          {search.result.truncated && (
            <p className="notice warning">
              Показана часть результатов: достигнут предел глубины, времени или количества. Уточните
              папку поиска.
            </p>
          )}
          {search.result.warnings.map((warning, index) => (
            <p className="notice warning" key={index}>
              {warning}
            </p>
          ))}
        </section>
      )}
      <p className="field-hint">
        Выбор добавляет ссылку на существующую папку. Копии проекта и новые рабочие среды не
        создаются.
      </p>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onManual}>
          Указать существующую папку вручную
        </button>
        <button className="button button-secondary" onClick={onClose}>
          Закрыть поиск
        </button>
      </div>
    </Modal>
  );
}
