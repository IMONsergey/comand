import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Folder,
  LoaderCircle,
  Monitor,
  Plus,
  Shield,
  Terminal,
  Unplug,
} from 'lucide-react';
import type { Device, Pairing, PairingStatus } from '../../src/shared/protocol';
import { api, shellQuote } from './api';
import {
  Busy,
  Copy,
  date,
  DeviceStatus,
  Empty,
  ErrorBox,
  Field,
  Modal,
  relative,
  shortId,
} from './components';

export function Devices({
  devices,
  onPair,
  onChange,
}: {
  devices: Device[];
  onPair: () => void;
  onChange: () => Promise<void>;
}) {
  const [revoke, setRevoke] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirmRevoke() {
    if (!revoke) return;
    setBusy(true);
    try {
      await api(`/devices/${encodeURIComponent(revoke.id)}/revoke`, { method: 'POST' });
      setRevoke(null);
      setError(null);
      await onChange();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ВАША ИНФРАСТРУКТУРА</div>
          <h1>
            Устройства<span className="title-dot">.</span>
            <span className="heading-count">{devices.length}</span>
          </h1>
          <p>Компьютеры, на которых выполняются задачи и хранятся ваши файлы.</p>
        </div>
        <button className="button button-primary" onClick={onPair}>
          <Plus size={18} />
          Подключить устройство
        </button>
      </div>
      <ErrorBox error={!revoke ? error : null} />
      {!devices.length ? (
        <section className="panel">
          <Empty
            title="Подключите рабочий компьютер"
            action={
              <button className="button button-primary" onClick={onPair}>
                <Plus size={17} />
                Подключить устройство
              </button>
            }
          >
            Вставьте одну команду в Терминал на Mac или Linux. Остальное агент настроит сам.
          </Empty>
        </section>
      ) : (
        <div className="device-grid">
          {devices.map((device) => (
            <article
              className={`panel device-card ${device.revokedAt ? 'device-revoked' : ''}`}
              key={device.id}
            >
              <div className="device-card-top">
                <span className="device-large-icon">
                  <Monitor size={27} strokeWidth={1.5} />
                </span>
                <DeviceStatus online={device.online} revoked={!!device.revokedAt} />
              </div>
              <h2>{device.name}</h2>
              <p className="device-platform">
                {device.platform} <span>·</span> агент {device.version}
              </p>
              <div className="device-card-fields">
                <div>
                  <span>Последний контакт</span>
                  <strong title={date(device.lastSeenAt)}>{relative(device.lastSeenAt)}</strong>
                </div>
                <div>
                  <span>Подключено</span>
                  <strong>{date(device.createdAt)}</strong>
                </div>
                <div>
                  <span>ID устройства</span>
                  <code>{shortId(device.id)}</code>
                </div>
              </div>
              <div className="device-roots">
                <span className="eyebrow">
                  <Folder size={13} /> РАЗРЕШЁННЫЕ ПАПКИ
                </span>
                {device.roots.map((root) => (
                  <code key={root}>{root}</code>
                ))}
              </div>
              <div className="capabilities">
                <span className={device.allowShell ? 'enabled' : ''}>
                  <Terminal size={14} />
                  Терминал {device.allowShell ? 'разрешён' : 'выключен'}
                </span>
                <span className={device.allowBrowser ? 'enabled' : ''}>
                  Браузер {device.allowBrowser ? 'разрешён' : 'выключен'}
                </span>
              </div>
              <div className="device-card-footer">
                <Shield size={14} />
                <span>Файлы в разрешённых папках</span>
                {!device.revokedAt && (
                  <button
                    className="text-button danger-text"
                    onClick={() => {
                      setRevoke(device);
                      setError(null);
                    }}
                  >
                    <Unplug size={14} />
                    Отозвать
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {revoke && (
        <Modal title={`Отозвать доступ: ${revoke.name}`} onClose={() => setRevoke(null)}>
          <p className="modal-copy">
            Устройство <strong>{revoke.name}</strong> ({shortId(revoke.id)}) больше не сможет
            получать задачи или отправлять результаты. Уже запущенная команда на компьютере может
            продолжить работу. Для повторного подключения понадобится новый код.
          </p>
          <ErrorBox error={error} />
          <div className="modal-actions">
            <button className="button button-secondary" onClick={() => setRevoke(null)}>
              Сохранить доступ
            </button>
            <button
              className="button button-danger"
              disabled={busy}
              onClick={() => void confirmRevoke()}
            >
              {busy ? <Busy /> : 'Отозвать доступ'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function PairDevice({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [stateDir, setStateDir] = useState('');
  const [shell, setShell] = useState(true);
  const [browser, setBrowser] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [device, setDevice] = useState<Device | null>(null);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(false);
  const started = useRef(false);
  const generation = useRef(0);
  const creating = useRef<AbortController | null>(null);
  const create = useCallback(async () => {
    const current = ++generation.current;
    creating.current?.abort();
    const controller = new AbortController();
    creating.current = controller;
    setBusy(true);
    setCreateError(null);
    setPollError(null);
    setPairing(null);
    setDevice(null);
    try {
      const value = await api<Pairing>('/pairings', { method: 'POST', signal: controller.signal });
      if (mounted.current && current === generation.current) {
        setPairing(value);
        setNow(Date.now());
      }
    } catch (cause) {
      if (mounted.current && current === generation.current && !controller.signal.aborted)
        setCreateError((cause as Error).message);
    } finally {
      if (mounted.current && current === generation.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    // React StrictMode replays effects; retain the one in-flight pairing request.
    if (!started.current) {
      started.current = true;
      void create();
    }
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(clock);
      queueMicrotask(() => {
        if (!mounted.current) creating.current?.abort();
      });
    };
  }, [create]);
  useEffect(() => {
    if (!pairing) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const current = generation.current;
    async function poll() {
      if (stopped) return;
      if (!document.hidden) {
        try {
          const value = await api<PairingStatus>(`/pairings/${encodeURIComponent(pairing!.id)}`, {
            signal: controller.signal,
          });
          if (stopped || current !== generation.current) return;
          setDevice(value.device);
          setPollError(null);
          if (value.device?.online && !value.device.revokedAt) return;
          if (!value.device && Date.now() >= new Date(value.expiresAt).getTime()) return;
        } catch (cause) {
          if (stopped || controller.signal.aborted || current !== generation.current) return;
          setPollError((cause as Error).message);
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [pairing, retry]);
  const remaining = pairing
    ? Math.max(0, Math.ceil((new Date(pairing.expiresAt).getTime() - now) / 1000))
    : 0;
  const rootError = root !== '' && !root.startsWith('/');
  const stateError = stateDir !== '' && !stateDir.startsWith('/');
  const validFields = !rootError && !stateError;
  const connected = !!device?.online && !device.revokedAt;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  const command =
    pairing && validFields
      ? `(comand_installer=$(mktemp) &&\ncurl -fsSL ${shellQuote(`${window.location.origin}/install.sh`)} -o "$comand_installer" &&\nbash "$comand_installer" --url ${shellQuote(window.location.origin)} --code ${shellQuote(pairing.code)}${pairing.installationProfile ? ` --profile ${shellQuote(pairing.installationProfile)}` : ''}${name.trim() ? ` --name ${shellQuote(name.trim())}` : ''}${root ? ` --root ${shellQuote(root)}` : ''}${stateDir ? ` --data-dir ${shellQuote(stateDir)}` : ''}${shell ? ' --allow-shell' : ''}${browser ? ' --allow-browser' : ''};\ncomand_status=$?; rm -f "$comand_installer"; exit "$comand_status")`
      : '';
  return (
    <Modal
      title="Подключить устройство"
      subtitle="Скопируйте команду и вставьте в Терминал на вашем Mac или Linux."
      onClose={onClose}
      wide
    >
      <div className="pair-connect">
        {connected ? (
          <div className="pair-success" role="status">
            <span className="pair-success-icon">
              <Check size={27} />
            </span>
            <h3>Устройство подключено</h3>
            <p>
              <strong>{device.name}</strong> в сети и готово к работе.
            </p>
            <button className="button button-primary" onClick={onDone}>
              Готово
            </button>
          </div>
        ) : (
          <>
            <ErrorBox error={createError} onRetry={() => void create()} />
            {busy && (
              <div className="pair-loading">
                <Busy>Готовим команду подключения…</Busy>
              </div>
            )}
            {pairing && (
              <>
                {remaining > 0 && (
                  <>
                    <p className="pair-permission">
                      <Shield size={18} />
                      <span>
                        {shell ? (
                          <>
                            Разрешает команды терминала с правами вашего пользователя и работу с
                            файлами в <code>{root || '~/Projects или ~/Comand'}</code>. Команды
                            терминала не ограничены этой папкой.
                          </>
                        ) : (
                          <>
                            Разрешает файловые операции в{' '}
                            <code>{root || '~/Projects или ~/Comand'}</code>. Команды терминала
                            выключены.
                          </>
                        )}
                        {browser && ' Также разрешает просмотр веб-страниц.'}
                      </span>
                    </p>
                    {validFields ? (
                      <div className="pair-install-command">
                        <div className="pair-command-label">
                          <Terminal size={15} />
                          <span>ВСТАВЬТЕ В ТЕРМИНАЛ</span>
                        </div>
                        <pre tabIndex={0} aria-label="Команда подключения">
                          {command.split(shellQuote(pairing.code))[0]}
                          <span className="pair-command-secret">{shellQuote(pairing.code)}</span>
                          {command.split(shellQuote(pairing.code))[1]}
                        </pre>
                        <Copy value={command} label="Скопировать команду" />
                      </div>
                    ) : (
                      <div className="notice warning" role="alert">
                        Проверьте пути в дополнительных настройках. Нужен абсолютный путь,
                        начинающийся с /, или оставьте поле пустым.
                      </div>
                    )}
                    <p className="pair-defaults">
                      {name || root
                        ? 'Агент подключится с выбранными настройками и включит автозапуск.'
                        : 'Имя компьютера определится автоматически. Агент использует папку Projects; если её нет — создаст Comand. Существующие проекты сохраняются.'}
                    </p>
                  </>
                )}
                {remaining === 0 && !device && (
                  <div className="pair-expired">
                    <h3>Срок действия команды истёк</h3>
                    <p>Получите новую команду и вставьте её в Терминал.</p>
                    <button className="button button-primary" onClick={() => void create()}>
                      Получить новую команду
                    </button>
                  </div>
                )}
                {device?.revokedAt && (
                  <ErrorBox error="Доступ к этому устройству отозван. Закройте окно и подключите его заново." />
                )}
                <ErrorBox error={pollError} onRetry={() => setRetry((value) => value + 1)} />
                {!device?.revokedAt && (remaining > 0 || device) && (
                  <div className="pair-waiting" role="status">
                    <LoaderCircle size={18} className="spin" />
                    <div>
                      <strong>
                        {device
                          ? 'Устройство зарегистрировано. Ждём агента…'
                          : 'Ожидаем подключения компьютера…'}
                      </strong>
                      <span>
                        {pollError
                          ? 'Проверка возобновится автоматически.'
                          : 'Эта страница обновится сама.'}
                      </span>
                    </div>
                    {remaining > 0 && (
                      <small title="Срок действия одноразовой команды">
                        {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
                      </small>
                    )}
                  </div>
                )}
              </>
            )}
            <details className="pair-advanced">
              <summary>
                Дополнительные настройки <ChevronDown size={16} />
              </summary>
              <div className="pair-advanced-body">
                <p>Можно оставить всё как есть. Меняйте настройки до копирования команды.</p>
                <Field label="Название устройства" hint="По умолчанию — имя компьютера.">
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={100}
                    placeholder="Определится автоматически"
                  />
                </Field>
                <Field
                  label="Рабочая папка, абсолютный путь"
                  hint="По умолчанию используется существующая Projects; если её нет — Comand в домашней папке."
                >
                  <input
                    className="mono"
                    value={root}
                    onChange={(event) => setRoot(event.target.value)}
                    maxLength={4096}
                    placeholder="Автоматически: Projects или Comand"
                    aria-invalid={rootError || undefined}
                  />
                </Field>
                <Field
                  label="Папка состояния агента"
                  hint="Отдельная папка вне проектов. Оставьте пустым для автоматической настройки."
                >
                  <input
                    className="mono"
                    value={stateDir}
                    onChange={(event) => setStateDir(event.target.value)}
                    maxLength={4096}
                    placeholder="Автоматически"
                    aria-invalid={stateError || undefined}
                  />
                </Field>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={shell}
                    onChange={(event) => setShell(event.target.checked)}
                  />
                  <span>
                    Разрешить команды терминала
                    <small>Команды выполняются с правами пользователя устройства.</small>
                  </span>
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={browser}
                    onChange={(event) => setBrowser(event.target.checked)}
                  />
                  <span>
                    Разрешить проверку веб-страниц
                    <small>Нужен Chromium или Google Chrome на компьютере.</small>
                  </span>
                </label>
              </div>
            </details>
            {local && (
              <p className="pair-local-note">
                Этот адрес работает для подключения компьютера, на котором запущен Comand. Для
                другого компьютера откройте публичный HTTPS-адрес сервера.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
