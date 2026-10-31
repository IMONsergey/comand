import { useState, type FormEvent } from 'react';
import { ArrowRight, Folder, Monitor, Pencil, Plus, Search } from 'lucide-react';
import { ProjectSearch } from './ProjectSearch';
import type { Device, Project } from '../../src/shared/protocol';
import { api } from './api';
import { Busy, date, DeviceStatus, Empty, ErrorBox, Field, Modal } from './components';

export function Projects({
  projects,
  devices,
  onChange,
  onPair,
}: {
  projects: Project[];
  devices: Device[];
  onChange: () => Promise<void>;
  onPair: () => void;
}) {
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState('');
  const availableDevices = devices.filter((device) => !device.revokedAt);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">КОНТЕКСТ ДЛЯ РАБОТЫ</div>
          <h1>
            Проекты<span className="title-dot">.</span>
            <span className="heading-count">{projects.length}</span>
          </h1>
          <p>Рабочая папка, устройство и заметки — точная точка входа для каждой задачи.</p>
        </div>
        <div className="action-group">
          <button
            className="button button-primary"
            disabled={!availableDevices.length}
            onClick={() => setSearching(true)}
          >
            <Search size={18} />
            Найти проект
          </button>
          <button
            className="button button-secondary"
            disabled={!availableDevices.length}
            onClick={() => setEditing('new')}
          >
            <Plus size={18} />
            Добавить папку вручную
          </button>
        </div>
      </div>
      {projects.length ? (
        <>
          <Field label="Поиск добавленных проектов">
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Название или путь"
            />
          </Field>
          <div className="project-grid">
            {projects
              .filter((project) =>
                `${project.name} ${project.root}`
                  .toLocaleLowerCase()
                  .includes(filter.toLocaleLowerCase()),
              )
              .map((project) => {
                const device = devices.find((item) => item.id === project.deviceId);
                return (
                  <article className="panel project-card" key={project.id}>
                    <div className="project-card-heading">
                      <span className="project-icon">
                        <Folder size={23} strokeWidth={1.5} />
                      </span>
                      <button
                        className="icon-button"
                        onClick={() => setEditing(project)}
                        aria-label={`Редактировать проект ${project.name}`}
                      >
                        <Pencil size={17} />
                      </button>
                    </div>
                    <h2>{project.name}</h2>
                    <code className="project-root">{project.root}</code>
                    <div className="project-device">
                      <Monitor size={15} />
                      <span>{device?.name ?? project.deviceId}</span>
                      {device && (
                        <DeviceStatus online={device.online} revoked={!!device.revokedAt} />
                      )}
                    </div>
                    <div className="project-notes">
                      <span className="eyebrow">ЗАМЕТКИ К ПРОЕКТУ</span>
                      <p>
                        {project.notes || (
                          <span className="subdued">
                            Добавьте контекст: как запускать проект, где искать файлы и что
                            учитывать.
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="project-card-footer">
                      Изменён {date(project.updatedAt)}
                      <button className="text-button" onClick={() => setEditing(project)}>
                        Изменить
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  </article>
                );
              })}
          </div>
        </>
      ) : (
        <section className="panel">
          <Empty
            title="Дайте работе контекст"
            action={
              <button
                className="button button-primary"
                onClick={() => (availableDevices.length ? setSearching(true) : onPair())}
              >
                <Plus size={17} />
                {availableDevices.length ? 'Найти существующий проект' : 'Подключить устройство'}
              </button>
            }
          >
            Проект связывает задачи с конкретной папкой на вашем устройстве. Заметки помогают
            сохранить инструкции и рабочий контекст.
          </Empty>
        </section>
      )}
      {searching && (
        <ProjectSearch
          devices={availableDevices}
          projects={projects}
          onClose={() => setSearching(false)}
          onSaved={async (project) => {
            setSearching(false);
            if (project) setFilter(project.root);
            await onChange();
          }}
          onManual={() => {
            setSearching(false);
            setEditing('new');
          }}
        />
      )}
      {editing && (
        <ProjectForm
          project={editing === 'new' ? undefined : editing}
          devices={availableDevices}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChange();
          }}
        />
      )}
    </>
  );
}
function ProjectForm({
  project,
  devices,
  onClose,
  onSaved,
}: {
  project?: Project;
  devices: Device[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [deviceId, setDeviceId] = useState(project?.deviceId ?? devices[0]?.id ?? '');
  const [root, setRoot] = useState(project?.root ?? '');
  const [notes, setNotes] = useState(project?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const device = devices.find((item) => item.id === deviceId);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(project ? `/projects/${encodeURIComponent(project.id)}` : '/projects', {
        method: project ? 'PATCH' : 'POST',
        body: project ? { name, notes } : { name, deviceId, root, notes },
      });
      await onSaved();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={project ? 'Настройки проекта' : 'Добавить папку вручную'}
      subtitle={
        project
          ? 'Название и заметки можно обновить в любое время.'
          : 'Укажите существующую папку в разрешённых границах устройства.'
      }
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <Field label="Название проекта">
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            placeholder="Например: Личный сайт"
          />
        </Field>
        {!project && (
          <>
            <Field label="Устройство">
              <select
                required
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
              >
                {devices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.online ? '' : ' · не в сети'}
                  </option>
                ))}
              </select>
            </Field>
            {device && (
              <div className="allowed-roots">
                <span>Разрешённые папки на устройстве</span>
                {device.roots.map((item) => (
                  <code key={item}>{item}</code>
                ))}
              </div>
            )}
            <Field label="Папка проекта, абсолютный путь">
              <input
                className="mono"
                required
                value={root}
                onChange={(event) => setRoot(event.target.value)}
                maxLength={4096}
                placeholder="/Users/you/Projects/my-project"
                pattern="/.*"
              />
            </Field>
          </>
        )}
        <Field
          label="Заметки и инструкции"
          hint="Контекст проекта доступен через MCP. Не добавляйте пароли и ключи."
        >
          <textarea
            rows={6}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={50000}
            placeholder="Как запустить проект? Где находятся важные файлы?"
          />
        </Field>
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="button button-primary" disabled={busy}>
            {busy ? <Busy>Сохраняем…</Busy> : project ? 'Сохранить изменения' : 'Добавить проект'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
