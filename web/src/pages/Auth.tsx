import { useState } from 'react';
import { api, setCsrfToken, type User } from '../lib/api.ts';
import { Button, Card, Field, Alert } from '../components/ui.tsx';

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
    <div className="auth-wrap">
      <div className="auth-card stack">
        <div className="row" style={{ justifyContent: 'center', marginBottom: '0.25rem' }}>
          <span className="mark" style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'linear-gradient(140deg, var(--accent), #7c3aed)', color: '#fff', fontWeight: 700 }}>
            FN
          </span>
        </div>
        <div style={{ textAlign: 'center' }}>
          <h1>Fieldnote</h1>
          <p className="muted small">
            Document what you did. Get the report, the deck and the questions you'll be asked.
          </p>
        </div>

        <Card>
          <form className="card-body stack" onSubmit={submit}>
            {mode === 'register' ? (
              <Field label="Your name">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
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

            <div className="tiny dim" style={{ textAlign: 'center' }}>
              {mode === 'login' ? (
                <>
                  No account?{' '}
                  <button type="button" className="chip" onClick={() => setMode('register')}>
                    Create one
                  </button>
                </>
              ) : (
                <>
                  Already registered?{' '}
                  <button type="button" className="chip" onClick={() => setMode('login')}>
                    Sign in
                  </button>
                </>
              )}
            </div>
          </form>
        </Card>

        <p className="tiny dim" style={{ textAlign: 'center' }}>
          Projects and uploads stay on this server. The first account created owns the instance.
        </p>
      </div>
    </div>
  );
}
