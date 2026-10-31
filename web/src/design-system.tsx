/** Adapted from Apcosys saas/primitives.tsx and components/ui/DoubleButton.tsx.
 * See web/DESIGN.md for source provenance and Comand adaptations. */
import {
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { ArrowUpRight, Command, Eye, EyeOff, LoaderCircle } from 'lucide-react';

export function Brand() {
  return (
    <span className="brand">
      <span className="brand-icon">
        <Command size={22} strokeWidth={2} />
      </span>
      <span>
        comand<span className="brand-period">.</span>
      </span>
    </span>
  );
}

export function SaasButton({
  variant = 'primary',
  busy = false,
  children,
  className = '',
  disabled,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button
      className={`s-button s-button--${variant} ${className}`}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy && <LoaderCircle className="spin" size={16} aria-hidden="true" />}
      {children}
    </button>
  );
}

export function SaasField({
  label,
  hint,
  error,
  id,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const generated = useId();
  const fieldId = id || generated;
  return (
    <div className={`s-field ${className}`}>
      <label htmlFor={fieldId}>{label}</label>
      <input
        id={fieldId}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        {...props}
      />
      {error ? (
        <small id={`${fieldId}-error`} className="s-field-error" role="alert">
          {error}
        </small>
      ) : (
        hint && <small id={`${fieldId}-hint`}>{hint}</small>
      )}
    </div>
  );
}

export function PasswordField({
  label = 'Пароль',
  hint,
  id,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string }) {
  const generated = useId();
  const fieldId = id || generated;
  const [visible, setVisible] = useState(false);
  return (
    <div className="s-field">
      <label htmlFor={fieldId}>{label}</label>
      <div className="password-control">
        <input
          {...props}
          id={fieldId}
          type={visible ? 'text' : 'password'}
          aria-describedby={hint ? `${fieldId}-hint` : undefined}
        />
        <button
          type="button"
          aria-label={
            visible ? `Скрыть: ${label.toLowerCase()}` : `Показать: ${label.toLowerCase()}`
          }
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {hint && <small id={`${fieldId}-hint`}>{hint}</small>}
    </div>
  );
}

/** Two visible shapes; one semantic action and one keyboard stop (Apcosys). */
export function DoubleButton({
  children,
  className = '',
  busy,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; busy?: boolean }) {
  return (
    <button
      type="button"
      className={`double-button ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      <span className="double-button__label">{children}</span>
      <span className="double-button__icon" aria-hidden="true">
        {busy ? <LoaderCircle className="spin" size={18} /> : <ArrowUpRight size={19} />}
      </span>
    </button>
  );
}
