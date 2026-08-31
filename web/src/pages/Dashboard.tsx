import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Project } from '../lib/api.ts';
import { Alert, Button, Card, CardHead, Empty, Meter } from '../components/ui.tsx';
import type { Session } from '../App.tsx';

export function Dashboard({ session }: { session: Session }) {
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    void api
      .get<{ projects: Project[] }>('/api/projects')
      .then((response) => setProjects(response.projects))
      .catch(() => setProjects([]));
  }, []);

  const drafts = projects?.filter((p) => p.status === 'draft') ?? [];
  const active = projects?.filter((p) => p.status === 'active' || p.status === 'complete') ?? [];
  const needsWork = (projects ?? []).filter((p) => (p.completeness ?? 0) < 60);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="crumb">Welcome back</div>
          <h1>{session.user.name.split(' ')[0]}</h1>
        </div>
        <div className="spacer" />
        <Link to="/projects">
          <Button variant="primary">New project</Button>
        </Link>
      </div>

      <div className="content stack loose">
        {session.meta.ai.offline ? (
          <Alert tone="warn">
            <span>
              <strong>Offline mode.</strong> No <code>OPENAI_API_KEY</code> is configured, so elaboration comes
              from the built-in deterministic provider. Everything works — reports, decks, exports — but the
              writing is generic. Add a key to <code>.env</code> and restart to switch on real elaboration.
            </span>
          </Alert>
        ) : null}

        {projects === null ? (
          <div className="row muted">
            <span className="spinner" /> Loading…
          </div>
        ) : projects.length === 0 ? (
          <Empty
            title="Nothing documented yet"
            action={
              <Link to="/projects">
                <Button variant="primary">Create your first project</Button>
              </Link>
            }
          >
            Paste the notes you already have. Fieldnote turns them into steps, explains the technology behind each
            one, links your screenshots to the work they prove, and produces the report and the deck.
          </Empty>
        ) : (
          <>
            <div className="grid three">
              <Stat label="Projects" value={String(projects.length)} />
              <Stat label="Drafts" value={String(drafts.length)} />
              <Stat
                label="Average completeness"
                value={`${Math.round(projects.reduce((sum, p) => sum + (p.completeness ?? 0), 0) / projects.length)}%`}
              />
            </div>

            <Card>
              <CardHead title="Recent projects" actions={<Link to="/projects" className="small">See all</Link>} />
              <div className="card-body stack tight">
                {projects.slice(0, 6).map((project) => (
                  <Link
                    key={project.id}
                    to={`/projects/${project.id}`}
                    className="row"
                    style={{ color: 'inherit', textDecoration: 'none', padding: '0.4rem 0', gap: '0.75rem' }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="truncate" style={{ fontWeight: 600 }}>{project.title}</div>
                      <div className="tiny dim truncate">
                        {project.counts?.steps ?? 0} steps · {project.counts?.evidence ?? 0} evidence ·{' '}
                        updated {new Date(project.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div style={{ width: '6rem' }}>
                      <Meter value={project.completeness ?? 0} />
                    </div>
                    <span className="tiny dim nowrap" style={{ width: '2.5rem', textAlign: 'right' }}>
                      {project.completeness ?? 0}%
                    </span>
                  </Link>
                ))}
              </div>
            </Card>

            {needsWork.length > 0 ? (
              <Card>
                <CardHead
                  title="Needs attention"
                  subtitle="These projects would not hold up to questioning yet"
                />
                <div className="card-body stack tight">
                  {needsWork.slice(0, 5).map((project) => (
                    <div key={project.id} className="row spread">
                      <Link to={`/projects/${project.id}`}>{project.title}</Link>
                      <span className="tiny dim">
                        {project.counts?.evidence === 0 ? 'no evidence' : `${project.completeness}% complete`}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}

            {active.length > 0 ? null : (
              <p className="small dim">
                Everything is still a draft. Mark a project complete in its settings once you have presented it.
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="card-body">
        <div className="tiny dim">{label}</div>
        <div style={{ fontSize: '1.7rem', fontWeight: 650, letterSpacing: '-0.02em' }}>{value}</div>
      </div>
    </Card>
  );
}
