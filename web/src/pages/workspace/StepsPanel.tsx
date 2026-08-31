import { useState } from 'react';
import { api, type Claim, type Step } from '../../lib/api.ts';
import {
  Button,
  Card,
  CodeBlock,
  ConfidenceDots,
  Empty,
  Field,
  InlineEdit,
  Modal,
  ProvenanceBadge,
  StatusBadge,
} from '../../components/ui.tsx';
import type { WorkspaceContext } from './ProjectWorkspace.tsx';

const SLOT_LABELS: Record<string, string> = {
  what_was_done: 'What was done',
  how_it_was_done: 'How it was done',
  why_it_was_done: 'Why it was done',
  what_the_technology_is: 'What the technology is',
  how_the_technology_works: 'How it works',
  why_it_matters: 'Why this matters',
  dependencies: 'Dependencies',
  expected_result: 'Expected result',
  actual_result: 'Actual result',
  validation: 'Validation',
  technical_significance: 'Technical significance',
  security_considerations: 'Security',
  performance_considerations: 'Performance',
  operational_considerations: 'Operations',
  alternatives: 'Alternatives',
  lessons_learned: 'Lessons learned',
  recommendations: 'Recommendation',
};

export function StepsPanel({ ctx }: { ctx: WorkspaceContext }) {
  const [expanded, setExpanded] = useState<string | null>(ctx.steps[0]?.id ?? null);
  const [adding, setAdding] = useState(false);

  if (ctx.steps.length === 0) {
    return (
      <>
        <Empty
          title="No steps yet"
          action={
            ctx.canEdit ? (
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add the first step
              </Button>
            ) : null
          }
        >
          A step is one thing you did. Write it in your own words — the AI adds the explanation, not the facts.
        </Empty>
        {adding ? <AddStepModal ctx={ctx} onClose={() => setAdding(false)} /> : null}
      </>
    );
  }

  return (
    <div className="stack">
      <div className="row spread">
        <p className="small muted" style={{ margin: 0 }}>
          {ctx.steps.filter((s) => s.aiState === 'elaborated').length} of {ctx.steps.length} steps elaborated.
          Your own wording is never overwritten.
        </p>
        {ctx.canEdit ? <Button onClick={() => setAdding(true)}>Add step</Button> : null}
      </div>

      <div className="stack">
        {ctx.steps.map((step) => (
          <StepCard
            key={step.id}
            ctx={ctx}
            step={step}
            expanded={expanded === step.id}
            onToggle={() => setExpanded(expanded === step.id ? null : step.id)}
          />
        ))}
      </div>

      {adding ? <AddStepModal ctx={ctx} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function StepCard({
  ctx,
  step,
  expanded,
  onToggle,
}: {
  ctx: WorkspaceContext;
  step: Step;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const evidence = ctx.evidence.filter((item) =>
    item.links.some((link) => link.targetType === 'step' && link.targetId === step.id),
  );

  const save = async (patch: Record<string, unknown>) => {
    try {
      await api.patch(`/api/projects/${ctx.projectId}/steps/${step.id}`, patch);
      await ctx.reload();
    } catch (error) {
      ctx.toast.error(error);
    }
  };

  const elaborate = async () => {
    setBusy(true);
    try {
      await api.post(`/api/projects/${ctx.projectId}/steps/${step.id}/ai/elaborate`, { regenerate: true });
      ctx.toast.show('Re-elaborating this step…');
    } catch (error) {
      ctx.toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="card-head" style={{ cursor: 'pointer' }} onClick={onToggle}>
        <span className="badge accent nowrap">Step {step.position}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 className="truncate">{step.title}</h3>
          {!expanded ? <div className="tiny dim truncate">{step.userDescription}</div> : null}
        </div>
        <span className="badge">{step.category}</span>
        <StatusBadge status={step.status} />
        {step.aiState === 'stale' ? <span className="badge warn">needs re-run</span> : null}
        {step.aiState === 'pending' ? <span className="badge">not elaborated</span> : null}
        {evidence.length > 0 ? <span className="badge">{evidence.length} evidence</span> : null}
        <span className="dim">{expanded ? '▾' : '▸'}</span>
      </div>

      {expanded ? (
        <div className="card-body stack loose">
          <div className="stack tight">
            <div className="row spread">
              <span className="label">Your description</span>
              <ProvenanceBadge provenance="USER_FACT" />
            </div>
            {ctx.canEdit ? (
              <InlineEdit
                value={step.userDescription}
                multiline
                onSave={(value) => save({ userDescription: value })}
                placeholder="Describe what you did, in your own words"
                className="small"
              />
            ) : (
              <p className="small">{step.userDescription || '—'}</p>
            )}
          </div>

          {step.configuration ? (
            <div className="stack tight">
              <span className="label">Configuration</span>
              <pre className="code">{step.configuration}</pre>
            </div>
          ) : null}

          {step.commands.length > 0 ? (
            <div className="stack tight">
              <span className="label">Commands</span>
              {step.commands.map((command) => (
                <div key={command.id} className="stack tight">
                  <CodeBlock language={command.language} content={command.content} caption={command.explanation ?? undefined} />
                </div>
              ))}
              {ctx.canEdit && step.commands.some((c) => !c.explanation) ? (
                <Button
                  size="small"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api.post(`/api/projects/${ctx.projectId}/steps/${step.id}/ai/explain-commands`);
                      await ctx.reload();
                    } catch (error) {
                      ctx.toast.error(error);
                    }
                  }}
                >
                  Explain these commands
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="stack tight">
            <div className="row spread">
              <span className="label">
                Elaboration
                {step.aiConfidence ? (
                  <>
                    {' '}
                    <ConfidenceDots level={step.aiConfidence} />
                  </>
                ) : null}
              </span>
              {ctx.canEdit ? (
                <Button size="small" variant="ghost" loading={busy} onClick={() => void elaborate()}>
                  {step.aiState === 'pending' ? 'Elaborate' : 'Regenerate'}
                </Button>
              ) : null}
            </div>

            {step.claims.length === 0 ? (
              <p className="small dim">
                Not elaborated yet. The AI will explain what this step did, what the technology is and why it
                mattered — without inventing anything you did not do.
              </p>
            ) : (
              <div className="stack">
                {step.claims.map((claim) => (
                  <ClaimRow key={claim.id} ctx={ctx} claim={claim} />
                ))}
              </div>
            )}
          </div>

          {evidence.length > 0 ? (
            <div className="stack tight">
              <span className="label">Evidence</span>
              <div className="thumbs">
                {evidence.map((item) => (
                  <div key={item.id} className="thumb" style={{ cursor: 'default' }}>
                    <div className="frame">
                      {item.file ? (
                        <img
                          src={`/api/projects/${ctx.projectId}/files/${item.file.id}?variant=thumb`}
                          alt={item.caption ?? item.title}
                          loading="lazy"
                        />
                      ) : (
                        <span className="dim tiny">no preview</span>
                      )}
                    </div>
                    <div className="meta">
                      <span className="name truncate">{item.title}</span>
                      <span className="tiny dim">
                        {item.links.find((l) => l.targetId === step.id)?.role ?? 'supports'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="row wrap" style={{ gap: '1.5rem' }}>
            <Small label="Expected" value={step.expectedResult} onSave={ctx.canEdit ? (v) => save({ expectedResult: v }) : undefined} />
            <Small label="Actual" value={step.actualResult} onSave={ctx.canEdit ? (v) => save({ actualResult: v }) : undefined} />
            <Small label="Validation" value={step.validation} onSave={ctx.canEdit ? (v) => save({ validation: v }) : undefined} />
          </div>

          {ctx.canEdit ? (
            <div className="row">
              <div style={{ flex: 1 }} />
              <Button
                size="small"
                variant="danger"
                onClick={async () => {
                  if (!confirm(`Delete step "${step.title}"? A version snapshot is kept.`)) return;
                  try {
                    await api.del(`/api/projects/${ctx.projectId}/steps/${step.id}`);
                    await ctx.reload();
                  } catch (error) {
                    ctx.toast.error(error);
                  }
                }}
              >
                Delete step
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function Small({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string | null;
  onSave?: (next: string) => void;
}) {
  return (
    <div className="stack tight" style={{ minWidth: '12rem', flex: 1 }}>
      <span className="label">{label}</span>
      {onSave ? (
        <InlineEdit value={value ?? ''} onSave={onSave} placeholder="—" className="small" />
      ) : (
        <span className="small muted">{value || '—'}</span>
      )}
    </div>
  );
}

function ClaimRow({ ctx, claim }: { ctx: WorkspaceContext; claim: Claim }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(claim.text);

  const save = async () => {
    try {
      await api.patch(`/api/projects/${ctx.projectId}/claims/${claim.id}`, { text: draft });
      setEditing(false);
      await ctx.reload();
    } catch (error) {
      ctx.toast.error(error);
    }
  };

  return (
    <div className={`claim ${claim.provenance}`}>
      <div className="row" style={{ gap: '0.4rem' }}>
        <span className="slot">{SLOT_LABELS[claim.slot] ?? claim.slot.replace(/_/g, ' ')}</span>
        <ProvenanceBadge provenance={claim.provenance} />
        <ConfidenceDots level={claim.confidence} />
        {claim.editedByUser ? <span className="badge ok">edited by you</span> : null}
        <div style={{ flex: 1 }} />
        {ctx.canEdit ? (
          <span className="tools row" style={{ gap: '0.2rem' }}>
            <Button size="small" variant="ghost" onClick={() => setEditing(!editing)}>
              {editing ? 'Cancel' : 'Edit'}
            </Button>
            <Button
              size="small"
              variant="ghost"
              title="Remove this statement"
              onClick={async () => {
                try {
                  await api.del(`/api/projects/${ctx.projectId}/claims/${claim.id}`);
                  await ctx.reload();
                } catch (error) {
                  ctx.toast.error(error);
                }
              }}
            >
              Remove
            </Button>
          </span>
        ) : null}
      </div>

      {editing ? (
        <div className="stack tight" style={{ marginTop: '0.35rem' }}>
          <textarea className="textarea" value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
          <div className="row">
            <Button size="small" variant="primary" onClick={() => void save()}>
              Save
            </Button>
            <span className="tiny dim">Edited statements are kept when the step is regenerated.</span>
          </div>
        </div>
      ) : (
        <div className="text">{claim.text}</div>
      )}
    </div>
  );
}

function AddStepModal({ ctx, onClose }: { ctx: WorkspaceContext; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('configuration');
  const [status, setStatus] = useState('done');
  const [command, setCommand] = useState('');
  const [language, setLanguage] = useState('powershell');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const created = await api.post<{ step: { id: string } }>(`/api/projects/${ctx.projectId}/steps`, {
        title,
        userDescription: description,
        category,
        status,
      });
      if (command.trim()) {
        await api.post(`/api/projects/${ctx.projectId}/steps/${created.step.id}/commands`, {
          language,
          content: command,
        });
      }
      await api.post(`/api/projects/${ctx.projectId}/steps/${created.step.id}/ai/elaborate`, {});
      await ctx.reload();
      onClose();
    } catch (error) {
      ctx.toast.error(error);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add step"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void create()}>
            Add and elaborate
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Configured client DNS" />
        </Field>
        <Field label="What did you do?" hint="Your words are preserved exactly; the AI adds explanation around them.">
          <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid two">
          <Field label="Category">
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
              {ctx.session.meta.categories.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              {['done', 'failed', 'in-progress', 'planned', 'skipped'].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Command (optional)" hint="Stored separately from the prose, with syntax kept intact.">
          <div className="stack tight">
            <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {['bash', 'powershell', 'cmd', 'python', 'sql', 'javascript', 'typescript', 'terraform', 'docker', 'kubernetes', 'yaml', 'text'].map(
                (option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ),
              )}
            </select>
            <textarea className="textarea mono" value={command} onChange={(e) => setCommand(e.target.value)} rows={3} />
          </div>
        </Field>
      </div>
    </Modal>
  );
}
