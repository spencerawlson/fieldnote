import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Project } from '../lib/api.ts';
import { Button, Card, Empty, Field, Meter, Modal, StatusBadge, useToast } from '../components/ui.tsx';
import type { Session } from '../App.tsx';

export function ProjectsPage({ session }: { session: Session }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const load = async () => {
    try {
      const response = await api.get<{ projects: Project[] }>('/api/projects');
      setProjects(response.projects);
    } catch (error) {
      toast.error(error);
      setProjects([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="topbar">
        <h1>Projects</h1>
        <div className="spacer" />
        <Button variant="primary" onClick={() => setCreating(true)}>
          New project
        </Button>
      </div>

      <div className="content stack loose">
        {projects === null ? (
          <div className="row muted">
            <span className="spinner" /> Loading projects…
          </div>
        ) : projects.length === 0 ? (
          <Empty
            title="No projects yet"
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                Start your first project
              </Button>
            }
          >
            A project is one piece of work — a lab, a deployment, an incident. Paste your notes, drop in your
            screenshots, and Fieldnote turns them into documentation.
          </Empty>
        ) : (
          <div className="grid cards">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </div>

      {creating ? (
        <NewProjectModal
          session={session}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      ) : null}
      {toast.node}
    </>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const counts = project.counts ?? {};
  return (
    <Link to={`/projects/${project.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
      <Card>
        <div className="card-body stack tight">
          <div className="row spread" style={{ alignItems: 'flex-start' }}>
            <h3 style={{ minWidth: 0 }}>{project.title}</h3>
            <StatusBadge status={project.status} />
          </div>
          <p className="small muted" style={{ minHeight: '2.6em' }}>
            {project.summary || project.objective || 'No objective recorded yet.'}
          </p>

          <div className="row wrap tiny dim" style={{ gap: '0.75rem' }}>
            <span>{counts.steps ?? 0} steps</span>
            <span>{counts.evidence ?? 0} evidence</span>
            {(counts.openProblems ?? 0) > 0 ? (
              <span style={{ color: 'var(--danger)' }}>{counts.openProblems} open problems</span>
            ) : (
              <span>{counts.problems ?? 0} problems</span>
            )}
          </div>

          <div className="stack tight" style={{ marginTop: '0.35rem' }}>
            <div className="row spread tiny dim">
              <span>Documentation completeness</span>
              <span>{project.completeness ?? 0}%</span>
            </div>
            <Meter value={project.completeness ?? 0} />
          </div>
        </div>
      </Card>
    </Link>
  );
}

function NewProjectModal({
  session,
  onClose,
  onCreated,
}: {
  session: Session;
  onClose: () => void;
  onCreated: () => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [notes, setNotes] = useState('');
  const [tone, setTone] = useState('technical');
  const [audience, setAudience] = useState('technical-team');
  const [depth, setDepth] = useState(2);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const create = async () => {
    setBusy(true);
    try {
      const created = await api.post<{ project: Project }>('/api/projects', {
        title,
        objective: objective || null,
        tone,
        audience,
        elaborationDepth: depth,
      });
      const projectId = created.project.id;

      // Carrying the notes straight through means the first thing the user sees
      // is their own work already structured, not an empty form.
      if (notes.trim()) {
        navigate(`/projects/${projectId}?intake=${encodeURIComponent(notes)}`);
      } else {
        navigate(`/projects/${projectId}`);
      }
      onCreated();
    } catch (error) {
      toast.error(error);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void create()}>
            Create project
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Title">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Active Directory Lab"
            autoFocus
          />
        </Field>

        <Field label="Objective" hint="What was this work for? Leave blank and the AI will suggest one.">
          <textarea
            className="textarea"
            style={{ minHeight: 60 }}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Stand up a Windows domain and join a client to it."
          />
        </Field>

        <Field
          label="What did you do? (optional)"
          hint="Rough notes are fine — one action per line. Fieldnote turns them into structured steps."
        >
          <textarea
            className="textarea"
            style={{ minHeight: 120 }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={'Installed Windows Server.\nConfigured static IP.\nInstalled AD DS.\nDomain join failed.\nChanged client DNS.\nJoined successfully.'}
          />
        </Field>

        <div className="grid three">
          <Field label="Tone">
            <select className="select" value={tone} onChange={(e) => setTone(e.target.value)}>
              {session.meta.tones.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Audience">
            <select className="select" value={audience} onChange={(e) => setAudience(e.target.value)}>
              {session.meta.audiences.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Detail level">
            <select className="select" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              {session.meta.depths.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value} — {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      {toast.node}
    </Modal>
  );
}
