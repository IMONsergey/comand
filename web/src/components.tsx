import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AlertCircle, Check, Copy as CopyIcon, LoaderCircle, X, Inbox } from 'lucide-react';
import type { JobState } from '../../src/shared/protocol';

export const stateNames: Record<JobState, string> = {
  queued: 'В очереди',
  dispatched: 'Передана',
  running: 'Выполняется',
  succeeded: 'Завершена',
  failed: 'Ошибка',
  cancelled: 'Отменена',
  uncertain: 'Неизвестный исход',
};
export function Status({ state }: { state: JobState }) {
  return (
    <span className={`status status-${state}`}>
      <i />
      {stateNames[state]}
    </span>
  );
}
export function DeviceStatus({ online, revoked }: { online: boolean; revoked?: boolean }) {
  return (
    <span
      className={`status ${revoked ? 'status-muted' : online ? 'status-succeeded' : 'status-muted'}`}
    >
      <i />
      {revoked ? 'Доступ отозван' : online ? 'В сети' : 'Не в сети'}
    </span>
  );
}
export function date(value: string | null) {
  return value
    ? new Date(value).toLocaleString('ru-RU', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}
export function relative(value: string | null) {
  if (!value) return 'Ещё не подключалось';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  return seconds < 60
    ? 'Только что'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} мин. назад`
      : date(value);
}
export function shortId(id: string) {
  return id.slice(0, 8);
}
export function ErrorBox({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  return error ? (
    <div className="error-box" role="alert">
      <AlertCircle size={18} />
      <span>{error}</span>
      {onRetry && (
        <button className="text-button" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  ) : null;
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={25} strokeWidth={1.5} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Busy({ children = 'Загрузка…' }: { children?: ReactNode }) {
  return (
    <span className="busy">
      <LoaderCircle size={16} className="spin" />
      {children}
    </span>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}) {
  const generatedId = useId();
  const controlId = children.props.id ?? generatedId;
  const hintId = `${generatedId}-hint`;
  const describedBy =
    [children.props['aria-describedby'], hint ? hintId : undefined].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={controlId}>
        {label}
      </label>
      {cloneElement(children, { id: controlId, 'aria-describedby': describedBy })}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(
      () =>
        ref.current
          ?.querySelector<HTMLElement>('input, select, textarea, button')
          ?.focus({ preventScroll: true }),
      0,
    );
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key === 'Tab') {
        const items = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        );
        if (!items?.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', key);
      document.body.style.overflow = oldOverflow;
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`modal ${wide ? 'modal-wide' : ''}`}
      >
        <div className="modal-heading">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-button" aria-label="Закрыть" onClick={onClose}>
            <X size={21} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Copy({ value, label = 'Скопировать' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setError(false);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(true);
    }
  }
  return (
    <button type="button" className="button button-secondary copy-button" onClick={copy}>
      {copied ? <Check size={16} /> : <CopyIcon size={16} />}
      {error ? 'Выделите и скопируйте текст' : copied ? 'Скопировано' : label}
    </button>
  );
}
