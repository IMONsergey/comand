import { useEffect, useState } from 'react';
import { ArrowRight, Check, Folder, Monitor, Plus, Shield, Terminal, Unplug } from 'lucide-react';
import type { Device, Pairing } from '../../src/shared/protocol';
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
            Установите агент на Mac или Linux. Вы сами укажете папки и разрешённые операции.
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
                <span>Доступ к указанным папкам</span>
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [stateDir, setStateDir] = useState('');
  const [shell, setShell] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      setPairing(await api<Pairing>('/pairings', { method: 'POST' }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const remaining = pairing
    ? Math.max(0, Math.ceil((new Date(pairing.expiresAt).getTime() - now) / 1000))
    : 0;
  const validFields = name.trim() && root.startsWith('/') && stateDir.startsWith('/');
  const command =
    pairing && validFields
      ? `comand-agent pair --url ${shellQuote(window.location.origin)} --code ${shellQuote(pairing.code)} --name ${shellQuote(name.trim())} --root ${shellQuote(root)} --data-dir ${shellQuote(stateDir)}${shell ? ' --allow-shell' : ''}${browser ? ' --allow-browser' : ''}`
      : '';
  const runCommand = `comand-agent run --data-dir ${shellQuote(stateDir)}`;
  return (
    <Modal
      title="Подключить устройство"
      subtitle="Одноразовый код связывает агент с этим хабом."
      onClose={onClose}
      wide
    >
      <div className="setup-step">
        <span className="step-number">1</span>
        <div>
          <h3>Установите агент на компьютере</h3>
          <p>
            На Mac или Linux установите Comand из вашего репозитория:{' '}
            <code>npm ci && npm run build && npm link</code>. Для сборки и запуска нужен Node.js 24
            или новее.
          </p>
        </div>
      </div>
      <div className="setup-step">
        <span className="step-number">2</span>
        <div>
          <h3>Задайте границы доступа</h3>
          <p>
            Пути указываются на подключаемом компьютере. Агент получит доступ только к выбранной
            папке.
          </p>
        </div>
      </div>
      <div className="form-grid">
        <Field label="Название устройства">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            placeholder="Например: Рабочий Mac"
          />
        </Field>
        <Field label="Рабочая папка, абсолютный путь">
          <input
            className="mono"
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            maxLength={4096}
            placeholder="/Users/you/Projects"
          />
        </Field>
      </div>
      <Field
        label="Папка состояния агента"
        hint="Отдельная папка вне проектов. В ней хранятся ключ устройства и результаты задач."
      >
        <input
          className="mono"
          value={stateDir}
          onChange={(event) => setStateDir(event.target.value)}
          placeholder="/Users/you/.comand-agent"
          maxLength={4096}
        />
      </Field>
      <div className="permission-options">
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
            <small>Для browser.inspect нужен установленный Chromium.</small>
          </span>
        </label>
      </div>
      <div className="setup-step">
        <span className="step-number">3</span>
        <div>
          <h3>Создайте код и выполните команду</h3>
          <p>Код действует 10 минут и используется один раз. Не передавайте его посторонним.</p>
        </div>
      </div>
      <ErrorBox error={error} />
      {!pairing ? (
        <button
          className="button button-primary"
          onClick={() => void create()}
          disabled={busy || !validFields}
        >
          {busy ? (
            <Busy>Создаём код…</Busy>
          ) : (
            <>
              Создать код подключения
              <ArrowRight size={17} />
            </>
          )}
        </button>
      ) : (
        <>
          <div className="pairing-code">
            <span className="eyebrow">ОДНОРАЗОВЫЙ КОД</span>
            <strong className="mono">{pairing.code}</strong>
            <span>
              {remaining
                ? `Действует ещё ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
                : 'Срок действия кода истёк'}
            </span>
          </div>
          {command && remaining > 0 && (
            <>
              <div className="command-box">
                <pre>{command}</pre>
                <Copy value={command} label="Скопировать команду" />
              </div>
              <p className="muted small">После подключения запустите агент:</p>
              <div className="command-box">
                <pre>{runCommand}</pre>
                <Copy value={runCommand} />
              </div>
            </>
          )}
          {remaining === 0 && (
            <button
              className="button button-secondary"
              onClick={() => void create()}
              disabled={busy}
            >
              Создать новый код
            </button>
          )}
          <div className="modal-actions">
            <button className="button button-primary" onClick={onDone}>
              <Check size={17} />
              Проверить подключение
            </button>
          </div>
        </>
      )}
      <p className="modal-footnote">
        Для другого компьютера адрес хаба должен быть доступен по сети. Loopback-адрес подходит
        только для агента на этом же компьютере.
      </p>
    </Modal>
  );
}
