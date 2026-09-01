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
import { AppearanceToggle } from './components/AppearanceToggle.tsx';

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
        <Mark />
        <span className="name">Fieldnote</span>
      </div>

      <nav className="sidebar-nav">
        {NAV_SECTIONS.map((section) => (
          <div key={section.heading}>
            <div className="sidebar-section">{section.heading}</div>
            {section.items.map((item) => (
              <Link
                key={item.to}
                className={`nav-item ${is(item.to) ? 'active' : ''}`}
                to={item.to}
              >
                {ICONS[item.icon]}
                {item.label}
              </Link>
            ))}
          </div>
        ))}
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
        <div className="row" style={{ marginBottom: '0.55rem' }}>
          <AppearanceToggle />
        </div>
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

// ---------------------------------------------------------------- navigation

const NAV_SECTIONS: {
  heading: string;
  items: { to: string; label: string; icon: keyof typeof ICONS }[];
}[] = [
  {
    heading: 'Work',
    items: [
      { to: '/', label: 'Dashboard', icon: 'dashboard' },
      { to: '/projects', label: 'Projects', icon: 'briefcase' },
    ],
  },
  {
    heading: 'Reference',
    items: [
      { to: '/templates', label: 'Templates', icon: 'layers' },
      { to: '/settings', label: 'Settings', icon: 'gear' },
    ],
  },
];

// ---------------------------------------------------------------- icons

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5.4 2.8h9.1l4.1 4.1v14.3a.8.8 0 0 1-.8.8H5.4a.8.8 0 0 1-.8-.8V3.6a.8.8 0 0 1 .8-.8Z"
        fill="var(--accent-soft)"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M14.5 2.8v4.1h4.1M8.4 12.4h7.2M8.4 16h4.8"
        stroke="var(--accent)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const ICONS = {
  dashboard: (
    <svg className="glyph" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <rect x="2.5" y="2.5" width="6" height="6" rx="1.4" {...stroke} />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1.4" {...stroke} />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1.4" {...stroke} />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1.4" {...stroke} />
    </svg>
  ),
  briefcase: (
    <svg className="glyph" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <rect x="2.5" y="6" width="15" height="11" rx="1.6" {...stroke} />
      <path d="M7 6V4.6A1.6 1.6 0 0 1 8.6 3h2.8A1.6 1.6 0 0 1 13 4.6V6" {...stroke} />
      <path d="M2.5 10.5h15" {...stroke} />
    </svg>
  ),
  layers: (
    <svg className="glyph" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path d="m10 2.8 7 3.6-7 3.6-7-3.6 7-3.6Z" {...stroke} />
      <path d="m3 10.4 7 3.6 7-3.6M3 14l7 3.6L17 14" {...stroke} />
    </svg>
  ),
  gear: (
    <svg className="glyph" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" {...stroke} />
      <path
        d="M10 2.6v2M10 15.4v2M17.4 10h-2M4.6 10h-2M15.2 4.8 13.8 6.2M6.2 13.8l-1.4 1.4M15.2 15.2l-1.4-1.4M6.2 6.2 4.8 4.8"
        {...stroke}
      />
    </svg>
  ),
};
