import { useState } from 'react';
import { api, setCsrfToken, type User } from '../lib/api.ts';
import { Button, Field, Alert } from '../components/ui.tsx';

export function AuthPage({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const payload = mode === 'login' ? { email, password } : { email, password, name };
      const response = await api.post<{ user: User; csrfToken: string }>(path, payload);
      setCsrfToken(response.csrfToken);
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <aside className="auth__aside">
        <div className="auth__brand">
          <Mark />
          <span className="auth__brand-name">Fieldnote</span>
        </div>

        <p className="auth__tagline">
          Your work, written up the way you would write it — with nothing invented.
        </p>

        <ul className="auth__points">
          <li>
            <Tick />
            <span>
              Every sentence is labelled by where it came from: your own account, the evidence, or
              the model's explanation.
            </span>
          </li>
          <li>
            <Tick />
            <span>
              Reports in DOCX and PDF, decks in PowerPoint, with the speaker notes and the questions
              you will be asked.
            </span>
          </li>
          <li>
            <Tick />
            <span>Projects, uploads and keys stay on this machine.</span>
          </li>
        </ul>
      </aside>

      <main className="auth__panel">
        <form className="auth__form" onSubmit={submit}>
          <h1 className="auth__title">{mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
          <p className="auth__subtitle">
            {mode === 'login'
              ? 'Pick up where you left off.'
              : 'The first account created owns this instance.'}
          </p>

          <div className="segmented" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={`segmented__option ${mode === 'login' ? 'segmented__option--active' : ''}`}
              onClick={() => setMode('login')}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={`segmented__option ${mode === 'register' ? 'segmented__option--active' : ''}`}
              onClick={() => setMode('register')}
            >
              Create account
            </button>
          </div>

          <div className="stack">
            {mode === 'register' ? (
              <Field label="Your name">
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoComplete="name"
                />
              </Field>
            ) : null}

            <Field label="Email">
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="username"
              />
            </Field>

            <Field label="Password" hint={mode === 'register' ? 'At least 10 characters.' : undefined}>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === 'register' ? 10 : undefined}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              />
            </Field>

            {error ? <Alert tone="danger">{error}</Alert> : null}

            <Button type="submit" variant="primary" loading={busy} className="block">
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}

function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5.4 2.8h9.1l4.1 4.1v14.3a.8.8 0 0 1-.8.8H5.4a.8.8 0 0 1-.8-.8V3.6a.8.8 0 0 1 .8-.8Z"
        fill="rgb(255 255 255 / 0.12)"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M14.5 2.8v4.1h4.1M8.4 12.4h7.2M8.4 16h4.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Tick() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="m6.6 10.2 2.4 2.4 4.4-5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
