import { useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound, ShieldCheck, UserRound } from 'lucide-react';
import type { SessionInfo } from '../../src/shared/protocol';
import { api, setSession } from './api';
import { ErrorBox } from './components';
import { RecoveryCode, type AccountResult } from './Auth';
import { PasswordField, SaasButton, SaasField } from './design-system';

function RecoveryConfirmation({ code, onContinue }: { code: string; onContinue: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      className="recovery-dialog"
      ref={dialog}
      aria-label="Сохраните код восстановления"
      onCancel={(event) => event.preventDefault()}
    >
      <RecoveryCode code={code} onContinue={onContinue} />
    </dialog>
  );
}

export function Account({
  session,
  onSession,
}: {
  session: SessionInfo;
  onSession: (session: SessionInfo) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [result, setResult] = useState<AccountResult | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      const value = await api<AccountResult>(
        session.user ? '/account/password' : '/account/claim',
        {
          method: 'POST',
          body: session.user ? { currentPassword, password } : { name, email, password },
        },
      );
      setPassword('');
      setCurrentPassword('');
      setSession(value);
      if (value.recoveryCode) setResult(value);
      else {
        onSession(value);
        setSuccess(true);
      }
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
          <div className="eyebrow">ВАШ ПРОФИЛЬ И ДОСТУП</div>
          <h1>
            Аккаунт<span className="title-dot">.</span>
          </h1>
          <p>Управляйте входом в свою рабочую среду.</p>
        </div>
      </div>
      <div className="account-layout">
        <section className="panel account-card">
          {result?.recoveryCode ? (
            <RecoveryConfirmation
              code={result.recoveryCode}
              onContinue={() => {
                onSession(result);
                setResult(null);
                setSuccess(true);
              }}
            />
          ) : (
            <>
              <div className="account-identity">
                <span className="account-avatar">
                  <UserRound size={25} />
                </span>
                <div>
                  <h2>{session.user?.name ?? 'Владелец сервера'}</h2>
                  <p>{session.user?.email ?? 'Вход по токену администратора'}</p>
                </div>
              </div>
              <div className="account-section-heading">
                <KeyRound size={19} />
                <h3>{session.user ? 'Изменить пароль' : 'Добавить вход по email'}</h3>
              </div>
              {!session.user && (
                <p className="account-description">
                  Привяжите аккаунт к текущей рабочей среде. Подключённые устройства, проекты и
                  задачи останутся на месте.
                </p>
              )}
              <ErrorBox error={error} />
              {success && (
                <div className="notice" role="status">
                  <ShieldCheck size={17} /> Данные входа обновлены. Другие сессии завершены.
                </div>
              )}
              <form onSubmit={(event) => void submit(event)}>
                {!session.user && (
                  <>
                    <SaasField
                      label="Ваше имя"
                      name="name"
                      autoComplete="name"
                      required
                      maxLength={100}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                    <SaasField
                      label="Электронная почта"
                      name="email"
                      type="email"
                      autoComplete="username"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </>
                )}
                {session.user && (
                  <PasswordField
                    label="Текущий пароль"
                    name="currentPassword"
                    autoComplete="current-password"
                    required
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                )}
                <PasswordField
                  label="Новый пароль"
                  name="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  hint="От 12 до 128 символов. Можно использовать парольную фразу."
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <SaasButton type="submit" busy={busy}>
                  {session.user ? 'Обновить пароль' : 'Привязать аккаунт'}
                </SaasButton>
              </form>
            </>
          )}
        </section>
        <aside className="panel info-card">
          <ShieldCheck size={24} />
          <h3>Восстановление доступа</h3>
          <p>Храните код восстановления отдельно от пароля. Ссылка на email не отправляется.</p>
          <p>
            Использование кода завершает предыдущие сессии и отзывает доступ MCP-приложений. Вы
            получите новый код.
          </p>
          {session.user && (
            <div className="technical-note">
              Email используется для входа. Доставка писем и подтверждение адреса не настроены.
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
