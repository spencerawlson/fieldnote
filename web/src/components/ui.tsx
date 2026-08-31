import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Confidence, Provenance } from '../lib/api.ts';

/** Shared presentational primitives. No business logic lives here. */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function CardHead({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card-head">
      <div>
        <h3>{title}</h3>
        {subtitle ? <div className="tiny dim">{subtitle}</div> : null}
      </div>
      <div className="spacer" />
      {actions}
    </div>
  );
}

export function Button({
  children,
  variant = 'default',
  size,
  loading,
  ...rest
}: {
  children: ReactNode;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'small';
  loading?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={`btn ${variant === 'default' ? '' : variant} ${size ?? ''} ${rest.className ?? ''}`}
    >
      {loading ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

const PROVENANCE_LABEL: Record<Provenance, string> = {
  USER_FACT: 'you documented',
  EVIDENCE: 'from evidence',
  AI_EXPLANATION: 'background',
  AI_INFERENCE: 'inferred',
  AI_RECOMMENDATION: 'recommendation',
};

const PROVENANCE_TITLE: Record<Provenance, string> = {
  USER_FACT: 'Restates something you wrote. Treated as fact.',
  EVIDENCE: 'Read out of an uploaded artifact.',
  AI_EXPLANATION: 'General technical knowledge, not a claim about this project.',
  AI_INFERENCE: 'A conclusion the model drew. It may be wrong — check it.',
  AI_RECOMMENDATION: 'Advice for the future, not something that happened.',
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  return (
    <span className={`prov ${provenance}`} title={PROVENANCE_TITLE[provenance]}>
      {PROVENANCE_LABEL[provenance]}
    </span>
  );
}

export function ConfidenceDots({ level }: { level: Confidence | null }) {
  if (!level) return null;
  return (
    <span className={`conf ${level}`} title={`${level} confidence`} aria-label={`${level} confidence`}>
      <i />
      <i />
      <i />
    </span>
  );
}

export function Meter({ value, max = 100 }: { value: number; max?: number }) {
  const percent = Math.max(0, Math.min(100, (value / max) * 100));
  const tone = percent >= 75 ? 'ok' : percent >= 40 ? 'warn' : '';
  return (
    <div className={`meter ${tone}`}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div style={{ marginTop: '1rem' }}>{action}</div> : null}
    </div>
  );
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  return <div className={`alert ${tone}`}>{children}</div>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" size="small" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: T; label: string; count?: number }[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={active === tab.key}
          className={`tab ${active === tab.key ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function CodeBlock({ language, content, caption }: { language: string; content: string; caption?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="code-head">
        <span className="lang">{language}</span>
        <div style={{ flex: 1 }} />
        <Button
          variant="ghost"
          size="small"
          onClick={() => {
            void navigator.clipboard?.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="code">
        <code>{content}</code>
      </pre>
      {caption ? <div className="tiny dim" style={{ marginTop: '0.35rem' }}>{caption}</div> : null}
    </div>
  );
}

/** Inline editable text. Click to edit, Escape to cancel, blur or Enter to save. */
export function InlineEdit({
  value,
  onSave,
  multiline,
  placeholder,
  className = '',
}: {
  value: string;
  onSave: (next: string) => void | Promise<void>;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement>(null);

  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <span
        className={`${className} ${value ? '' : 'dim'}`}
        style={{ cursor: 'text', display: 'inline-block', minWidth: '2rem' }}
        onClick={() => setEditing(true)}
        title="Click to edit"
      >
        {value || placeholder || 'Click to add'}
      </span>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft !== value) void onSave(draft);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  return multiline ? (
    <textarea
      ref={ref as React.RefObject<HTMLTextAreaElement>}
      className="textarea"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Escape' && cancel()}
      rows={Math.max(2, Math.min(12, draft.split('\n').length + 1))}
    />
  ) : (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      className="input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') cancel();
      }}
    />
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'done' || status === 'ready' || status === 'resolved' || status === 'pass' || status === 'succeeded'
      ? 'ok'
      : status === 'failed' || status === 'fail' || status === 'open'
        ? 'danger'
        : status === 'stale' || status === 'generating' || status === 'running' || status === 'investigating'
          ? 'warn'
          : '';
  return <span className={`badge ${tone}`}>{status}</span>;
}

export function useToast() {
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'danger' | 'ok' } | null>(null);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 4500);
    return () => clearTimeout(timer);
  }, [message]);

  const node = message ? (
    <div style={{ position: 'fixed', bottom: '1.25rem', right: '1.25rem', zIndex: 200, maxWidth: '26rem' }}>
      <div className={`alert ${message.tone}`} style={{ boxShadow: 'var(--shadow-lg)' }}>
        {message.text}
      </div>
    </div>
  ) : null;

  return {
    node,
    show: (text: string, tone: 'info' | 'danger' | 'ok' = 'info') => setMessage({ text, tone }),
    error: (error: unknown) =>
      setMessage({ text: error instanceof Error ? error.message : String(error), tone: 'danger' }),
  };
}
