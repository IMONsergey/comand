import { useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  KeyRound,
  Link2,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
  Terminal,
} from 'lucide-react';
import type { SessionInfo } from '../../src/shared/protocol';
import { api, setSession } from './api';
import { Busy, Copy, ErrorBox } from './components';
import { Brand, DoubleButton, PasswordField, SaasButton, SaasField } from './design-system';

export type AccountResult = SessionInfo & { recoveryCode?: string };
type Mode = 'login' | 'register' | 'recover' | 'token';

export function RecoveryCode({ code, onContinue }: { code: string; onContinue: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="recovery-panel">
      <span className="auth-symbol">
        <KeyRound size={24} />
      </span>
      <h1>
        Сохраните код восстановления<span className="title-dot">.</span>
      </h1>
      <p>
        Это единственный показ кода. Он поможет вернуть доступ, если вы забудете пароль. Сохраните
        его в менеджере паролей.
      </p>
      <div className="recovery-code">
        <code data-testid="recovery-code">{code}</code>
        <Copy value={code} label="Скопировать код" />
      </div>
      <div className="notice">
        Письма для восстановления не отправляются. После использования кода вы получите новый.
      </div>
      <label className="checkbox recovery-check">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        <span>Я сохранил код в надёжном месте</span>
      </label>
      <DoubleButton disabled={!saved} onClick={onContinue}>
        Перейти в рабочую среду
      </DoubleButton>
    </div>
  );
}

export function Auth({
  session,
  error,
  onSession,
  retry,
  dark,
  onTheme,
}: {
  session: SessionInfo | null;
  error: string | null;
  onSession: (value: SessionInfo) => void;
  retry: () => Promise<void>;
  dark: boolean;
  onTheme: () => void;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AccountResult | null>(null);
  function changeMode(next: Mode) {
    setMode(next);
    setPassword('');
    setFailure(null);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const value = await api<AccountResult>(
        mode === 'register' ? '/register' : mode === 'recover' ? '/recover' : '/login',
        {
          method: 'POST',
          body:
            mode === 'token'
              ? { token }
              : mode === 'register'
                ? { name, email, password }
                : mode === 'recover'
                  ? { email, recoveryCode, password }
                  : { email, password },
        },
      );
      setPassword('');
      setToken('');
      setRecoveryCode('');
      setSession(value);
      if (value.recoveryCode) setResult(value);
      else onSession(value);
    } catch (cause) {
      setFailure((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title = {
    login: 'Вернёмся к работе',
    register: 'Ваша рабочая среда',
    recover: 'Восстановить доступ',
    token: 'Вход владельца',
  }[mode];
  return (
    <div className="auth-shell">
      <header className="auth-header">
        <Brand />
        <button
          className="icon-button"
          onClick={onTheme}
          aria-label={dark ? 'Светлая тема' : 'Тёмная тема'}
        >
          {dark ? <Sun size={19} /> : <Moon size={19} />}
        </button>
      </header>
      <div className="auth-layout">
        <section className="auth-story" aria-label="Возможности Comand">
          <div className="eyebrow">КОМПЬЮТЕРЫ / ПРОЕКТЫ / ЗАДАЧИ</div>
          <h2>
            Ваша работа.
            <br />
            На ваших
            <br />
            <span>устройствах.</span>
          </h2>
          <p>
            Подключите компьютер и управляйте проектами из единого пространства — в браузере или
            прямо из AI-чата.
          </p>
          <div className="auth-flow">
            <div>
              <Monitor size={21} />
              <span>
                <strong>Подключите компьютер</strong>
                <small>Mac или Linux · установка одной командой</small>
              </span>
            </div>
            <div>
              <Terminal size={21} />
              <span>
                <strong>Работайте с проектами</strong>
                <small>Команды, файлы и проверка веб-страниц</small>
              </span>
            </div>
            <div>
              <Link2 size={21} />
              <span>
                <strong>Продолжайте в AI-чате</strong>
                <small>ChatGPT и другие клиенты с MCP</small>
              </span>
            </div>
          </div>
          <div className="auth-story-foot">
            <span className="auth-foot-mark">C/</span>
            <span>
              Контекст сохраняется.
              <br />
              Контроль остаётся у вас.
            </span>
          </div>
        </section>
        <section className="auth-form-region">
          <div className="auth-card">
            {result?.recoveryCode ? (
              <RecoveryCode code={result.recoveryCode} onContinue={() => onSession(result)} />
            ) : (
              <>
                {(mode === 'recover' || mode === 'token') && (
                  <button className="text-button auth-back" onClick={() => changeMode('login')}>
                    <ArrowLeft size={15} /> К обычному входу
                  </button>
                )}
                <span className="eyebrow">
                  {mode === 'register' ? 'НАЧНИТЕ СВОЙ ПРОЕКТ' : 'COMAND WORKSPACE'}
                </span>
                <h1>
                  {title}
                  <span className="title-dot">.</span>
                </h1>
                <p className="auth-subtitle">
                  {
                    {
                      login: 'Войдите, чтобы продолжить с того места, где остановились.',
                      register: 'Создайте аккаунт, затем подключите свой первый компьютер.',
                      recover:
                        'Введите код, который вы сохранили при регистрации, и задайте новый пароль.',
                      token: 'Для существующего сервера с ключом администратора.',
                    }[mode]
                  }
                </p>
                <ErrorBox error={error} onRetry={() => void retry()} />
                <ErrorBox error={failure} />
                {!session && !error ? (
                  <Busy>Подключаемся к серверу</Busy>
                ) : (
                  <form onSubmit={(event) => void submit(event)} aria-label={title}>
                    {mode === 'register' && (
                      <SaasField
                        label="Ваше имя"
                        name="name"
                        autoComplete="name"
                        placeholder="Как к вам обращаться"
                        required
                        maxLength={100}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    )}
                    {mode !== 'token' && (
                      <SaasField
                        label="Электронная почта"
                        name="email"
                        type="email"
                        autoComplete="username"
                        inputMode="email"
                        placeholder="you@company.com"
                        required
                        maxLength={254}
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                      />
                    )}
                    {mode === 'recover' && (
                      <SaasField
                        label="Код восстановления"
                        name="recoveryCode"
                        autoComplete="off"
                        spellCheck={false}
                        required
                        value={recoveryCode}
                        onChange={(event) => setRecoveryCode(event.target.value)}
                      />
                    )}
                    {mode === 'token' ? (
                      <PasswordField
                        label="Токен владельца"
                        name="token"
                        autoComplete="current-password"
                        required
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                      />
                    ) : (
                      <PasswordField
                        label={mode === 'recover' ? 'Новый пароль' : 'Пароль'}
                        name="password"
                        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                        required
                        minLength={mode === 'login' ? undefined : 12}
                        maxLength={128}
                        hint={
                          mode !== 'login'
                            ? 'От 12 до 128 символов. Можно использовать парольную фразу.'
                            : undefined
                        }
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    )}
                    {mode === 'login' && (
                      <button
                        type="button"
                        className="text-button forgot-password"
                        onClick={() => changeMode('recover')}
                      >
                        Забыли пароль?
                      </button>
                    )}
                    <DoubleButton type="submit" busy={busy} disabled={!session || !!error}>
                      {busy
                        ? 'Подождите…'
                        : mode === 'register'
                          ? 'Создать аккаунт'
                          : mode === 'recover'
                            ? 'Восстановить доступ'
                            : 'Войти в Comand'}
                    </DoubleButton>
                    {mode === 'register' && (
                      <p className="auth-form-note">
                        <ShieldCheck size={16} /> После регистрации сохраните код восстановления. Мы
                        не отправляем письма и не подтверждаем email.
                      </p>
                    )}
                  </form>
                )}
                {mode === 'login' && session?.registrationEnabled !== false && (
                  <div className="auth-switch">
                    Впервые здесь?{' '}
                    <button className="text-button" onClick={() => changeMode('register')}>
                      Создать аккаунт <ArrowUpRight size={14} />
                    </button>
                  </div>
                )}
                {mode === 'register' && (
                  <div className="auth-switch">
                    Уже есть аккаунт?{' '}
                    <button className="text-button" onClick={() => changeMode('login')}>
                      Войти
                    </button>
                  </div>
                )}
                {mode === 'login' && (
                  <details className="advanced-login">
                    <summary>Другой способ входа</summary>
                    <p>Уже пользуетесь собственным сервером Comand?</p>
                    <SaasButton variant="secondary" onClick={() => changeMode('token')}>
                      <KeyRound size={15} /> Войти по токену владельца
                    </SaasButton>
                  </details>
                )}
              </>
            )}
          </div>
          <div className="auth-card-caption">
            <Check size={13} /> Устройства и задачи доступны только вашему аккаунту
          </div>
        </section>
      </div>
      <footer className="auth-footer">
        <span>comand. / Ваша рабочая среда</span>
        <span>macOS · Linux · MCP</span>
      </footer>
    </div>
  );
}
