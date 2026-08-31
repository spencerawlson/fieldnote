import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams, Link } from 'react-router-dom';
import { api, setCsrfToken, type Meta, type User } from './lib/api.ts';
import { AuthPage } from './pages/Auth.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { ProjectsPage } from './pages/Projects.tsx';
import { TemplatesPage } from './pages/Templates.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { ProjectWorkspace } from './pages/workspace/ProjectWorkspace.tsx';
import { Button } from './components/ui.tsx';

export interface Session {
  user: User;
  meta: Meta;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      const [session, metaResponse] = await Promise.all([
        api.get<{ user: User; csrfToken: string }>('/api/auth/me'),
        api.get<Meta>('/api/meta'),
      ]);
      setCsrfToken(session.csrfToken);
      setUser(session.user);
      setMeta(metaResponse);
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!ready) {
    return (
      <div className="auth-wrap">
        <div className="row">
          <span className="spinner" style={{ color: 'var(--accent)' }} />
          <span className="muted">Loading…</span>
        </div>
      </div>
    );
  }

  if (!user || !meta) {
    return <AuthPage onAuthenticated={load} />;
  }

  const session: Session = {
    user,
    meta,
    refresh: load,
    signOut: async () => {
      await api.post('/api/auth/logout');
      setCsrfToken(null);
      setUser(null);
    },
  };

  return (
    <BrowserRouter>
      <Shell session={session} />
    </BrowserRouter>
  );
}

function Shell({ session }: { session: Session }) {
  return (
    <div className="app">
      <Sidebar session={session} />
      <div className="main">
        <Routes>
          <Route path="/" element={<Dashboard session={session} />} />
          <Route path="/projects" element={<ProjectsPage session={session} />} />
          <Route path="/projects/:projectId/*" element={<WorkspaceRoute session={session} />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/settings" element={<SettingsPage session={session} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function WorkspaceRoute({ session }: { session: Session }) {
  const { projectId } = useParams();
  if (!projectId) return <Navigate to="/projects" replace />;
  return <ProjectWorkspace key={projectId} projectId={projectId} session={session} />;
}

function Sidebar({ session }: { session: Session }) {
  const location = useLocation();
  const navigate = useNavigate();
  const is = (path: string) =>
    path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="mark">FN</span>
        <span className="name">Fieldnote</span>
      </div>

      <nav className="sidebar-nav">
        <Link className={`nav-item ${is('/') ? 'active' : ''}`} to="/">
          <span className="glyph">▦</span> Dashboard
        </Link>
        <Link className={`nav-item ${is('/projects') ? 'active' : ''}`} to="/projects">
          <span className="glyph">◇</span> Projects
        </Link>
        <Link className={`nav-item ${is('/templates') ? 'active' : ''}`} to="/templates">
          <span className="glyph">▤</span> Templates
        </Link>
        <Link className={`nav-item ${is('/settings') ? 'active' : ''}`} to="/settings">
          <span className="glyph">⚙</span> Settings
        </Link>
      </nav>

      <div className="sidebar-foot">
        {session.meta.ai.offline ? (
          <div className="alert warn tiny" style={{ marginBottom: '0.6rem' }}>
            <span>
              <strong>Offline mode.</strong> No API key configured — AI output comes from the built-in local
              provider. Add one in Settings.
            </span>
          </div>
        ) : null}
        <div className="row" style={{ gap: '0.5rem' }}>
          <div style={{ minWidth: 0 }}>
            <div className="small truncate" style={{ fontWeight: 600 }}>{session.user.name}</div>
            <div className="tiny dim truncate">{session.user.email}</div>
          </div>
          <div style={{ flex: 1 }} />
          <Button
            variant="ghost"
            size="small"
            title="Sign out"
            onClick={() => {
              void session.signOut().then(() => navigate('/'));
            }}
          >
            ⏻
          </Button>
        </div>
      </div>
    </aside>
  );
}
