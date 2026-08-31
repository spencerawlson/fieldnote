import { useEffect, useState } from 'react';
import { api, type Problem } from '../../lib/api.ts';
import {
  Alert,
  Button,
  Card,
  CardHead,
  ConfidenceDots,
  Empty,
  Field,
  InlineEdit,
  Modal,
  ProvenanceBadge,
  StatusBadge,
} from '../../components/ui.tsx';
import type { WorkspaceContext } from './ProjectWorkspace.tsx';

interface TestRecord {
  id: string;
  name: string;
  method: string | null;
  expected: string | null;
  observed: string | null;
  outcome: string;
}

interface ResultRecord {
  id: string;
  title: string;
  detail: string | null;
  metric: string | null;
  value: string | null;
}

export function ProblemsPanel({ ctx }: { ctx: WorkspaceContext }) {
  const [adding, setAdding] = useState(false);
  const [tests, setTests] = useState<TestRecord[]>([]);
  const [results, setResults] = useState<ResultRecord[]>([]);

  const loadSide = async () => {
    try {
      const [testResponse, resultResponse] = await Promise.all([
        api.get<{ tests: TestRecord[] }>(`/api/projects/${ctx.projectId}/tests`),
        api.get<{ results: ResultRecord[] }>(`/api/projects/${ctx.projectId}/results`),
      ]);
      setTests(testResponse.tests);
      setResults(resultResponse.results);
    } catch {
      /* non-fatal */
    }
  };

  useEffect(() => {
    void loadSide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.projectId]);

  return (
    <div className="stack loose">
      <div className="row spread">
        <p className="small muted" style={{ margin: 0 }}>
          Each problem is structured as symptoms → investigation → root cause → resolution → validation.
        </p>
        {ctx.canEdit ? <Button onClick={() => setAdding(true)}>Add problem</Button> : null}
      </div>

      {ctx.problems.length === 0 ? (
        <Empty title="No problems recorded">
          Nothing went wrong, or nothing was written down. Troubleshooting is usually the most valuable part of
          a write-up — it shows how you think.
        </Empty>
      ) : (
        ctx.problems.map((problem) => <ProblemCard key={problem.id} ctx={ctx} problem={problem} />)
      )}

      <div className="grid two">
        <TestsCard ctx={ctx} tests={tests} onChange={loadSide} />
        <ResultsCard ctx={ctx} results={results} onChange={loadSide} />
      </div>

      {adding ? <AddProblemModal ctx={ctx} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function ProblemCard({ ctx, problem }: { ctx: WorkspaceContext; problem: Problem }) {
  const [busy, setBusy] = useState(false);
  const evidence = ctx.evidence.filter((item) =>
    item.links.some((link) => link.targetType === 'problem' && link.targetId === problem.id),
  );

  const save = async (patch: Record<string, unknown>) => {
    try {
      await api.patch(`/api/projects/${ctx.projectId}/problems/${problem.id}`, patch);
      await ctx.reload();
    } catch (error) {
      ctx.toast.error(error);
    }
  };

  const hasValidationEvidence = evidence.some(
    (item) => item.links.some((l) => l.role === 'validation' || l.role === 'after'),
  );

  return (
    <Card>
      <CardHead
        title={problem.title}
        subtitle={problem.stepId ? `During: ${ctx.steps.find((s) => s.id === problem.stepId)?.title ?? '—'}` : undefined}
        actions={
          <div className="row" style={{ gap: '0.4rem' }}>
            <StatusBadge status={problem.status} />
            {ctx.canEdit ? (
              <Button
                size="small"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.post(`/api/projects/${ctx.projectId}/problems/${problem.id}/ai/elaborate`, { regenerate: true });
                    ctx.toast.show('Analysing this problem…');
                  } catch (error) {
                    ctx.toast.error(error);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Analyse
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="card-body stack loose">
        <Section label="Symptoms" provenance="USER_FACT">
          {ctx.canEdit ? (
            <InlineEdit value={problem.symptoms ?? ''} multiline onSave={(v) => save({ symptoms: v })} className="small" />
          ) : (
            <span className="small">{problem.symptoms || '—'}</span>
          )}
        </Section>

        {problem.investigations.length > 0 ? (
          <Section label="Investigation">
            <ol className="small" style={{ margin: 0, paddingLeft: '1.2rem' }}>
              {problem.investigations.map((step) => (
                <li key={step.id}>
                  <strong>{step.action}</strong>
                  {step.tool ? <span className="dim"> · {step.tool}</span> : null}
                  {step.finding ? <div className="muted">{step.finding}</div> : null}
                </li>
              ))}
            </ol>
          </Section>
        ) : null}

        <Section
          label="Root cause"
          provenance={problem.rootCause ? problem.rootCauseProvenance : undefined}
          extra={problem.rootCauseConfidence ? <ConfidenceDots level={problem.rootCauseConfidence} /> : null}
        >
          {ctx.canEdit ? (
            <InlineEdit
              value={problem.rootCause ?? ''}
              multiline
              onSave={(v) => save({ rootCause: v })}
              placeholder="Not established — click to record what was actually wrong"
              className="small"
            />
          ) : (
            <span className="small">{problem.rootCause || '—'}</span>
          )}
          {problem.rootCause && problem.rootCauseProvenance === 'AI_INFERENCE' ? (
            <div className="tiny dim" style={{ marginTop: '0.25rem' }}>
              This is the AI's inference from your notes and evidence. Edit it to record what you actually found —
              that changes it to a documented fact.
            </div>
          ) : null}
        </Section>

        {problem.resolutions.length > 0 ? (
          <Section label="Resolution">
            {problem.resolutions.map((resolution) => (
              <div key={resolution.id} className="stack tight">
                <span className="small">{resolution.description}</span>
                {resolution.validation ? (
                  <div className="small muted">Validation: {resolution.validation}</div>
                ) : null}
                {!hasValidationEvidence ? (
                  <Alert tone="warn">
                    No evidence in this project shows the fix working. Reports will say so rather than claim it
                    was validated.
                  </Alert>
                ) : null}
              </div>
            ))}
          </Section>
        ) : null}

        {problem.claims.length > 0 ? (
          <Section label="Analysis">
            <div className="stack tight">
              {problem.claims.map((claim) => (
                <div key={claim.id} className={`claim ${claim.provenance}`}>
                  <div className="row" style={{ gap: '0.35rem' }}>
                    <span className="slot">{claim.slot.replace(/_/g, ' ')}</span>
                    <ProvenanceBadge provenance={claim.provenance} />
                    <ConfidenceDots level={claim.confidence} />
                  </div>
                  <div className="text small">{claim.text}</div>
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        {evidence.length > 0 ? (
          <Section label="Evidence chain">
            <div className="row wrap" style={{ gap: '0.5rem' }}>
              {evidence.map((item) => {
                const link = item.links.find((l) => l.targetId === problem.id);
                return (
                  <span key={item.id} className="badge">
                    {link?.role ?? 'supports'}: {item.title}
                  </span>
                );
              })}
            </div>
          </Section>
        ) : null}
      </div>
    </Card>
  );
}

function Section({
  label,
  provenance,
  extra,
  children,
}: {
  label: string;
  provenance?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="stack tight">
      <div className="row" style={{ gap: '0.4rem' }}>
        <span className="label">{label}</span>
        {provenance ? <ProvenanceBadge provenance={provenance as never} /> : null}
        {extra}
      </div>
      {children}
    </div>
  );
}

function TestsCard({ ctx, tests, onChange }: { ctx: WorkspaceContext; tests: TestRecord[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [outcome, setOutcome] = useState('pass');

  return (
    <Card>
      <CardHead title="Testing" subtitle="What you checked, and what you observed." />
      <div className="card-body stack tight">
        {tests.length === 0 ? (
          <p className="small dim">No tests recorded. A documented result with no test behind it gets flagged.</p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Test</th>
                <th>Observed</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {tests.map((test) => (
                <tr key={test.id}>
                  <td>{test.name}</td>
                  <td className="muted">{test.observed ?? '—'}</td>
                  <td>
                    <StatusBadge status={test.outcome} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {ctx.canEdit ? (
          <div className="row" style={{ gap: '0.4rem' }}>
            <input className="input" placeholder="Test name" value={name} onChange={(e) => setName(e.target.value)} />
            <select className="select" style={{ width: '8rem' }} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {['pass', 'fail', 'partial', 'untested'].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <Button
              size="small"
              disabled={!name.trim()}
              onClick={async () => {
                try {
                  await api.post(`/api/projects/${ctx.projectId}/tests`, { name, outcome });
                  setName('');
                  onChange();
                } catch (error) {
                  ctx.toast.error(error);
                }
              }}
            >
              Add
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function ResultsCard({ ctx, results, onChange }: { ctx: WorkspaceContext; results: ResultRecord[]; onChange: () => void }) {
  const [title, setTitle] = useState('');

  return (
    <Card>
      <CardHead title="Results" subtitle="What the work achieved." />
      <div className="card-body stack tight">
        {results.length === 0 ? (
          <p className="small dim">No results recorded yet.</p>
        ) : (
          <ul className="small" style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {results.map((result) => (
              <li key={result.id}>
                <strong>{result.title}</strong>
                {result.detail ? <span className="muted"> — {result.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}

        {ctx.canEdit ? (
          <div className="row" style={{ gap: '0.4rem' }}>
            <input className="input" placeholder="Result" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Button
              size="small"
              disabled={!title.trim()}
              onClick={async () => {
                try {
                  await api.post(`/api/projects/${ctx.projectId}/results`, { title });
                  setTitle('');
                  onChange();
                } catch (error) {
                  ctx.toast.error(error);
                }
              }}
            >
              Add
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function AddProblemModal({ ctx, onClose }: { ctx: WorkspaceContext; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [symptoms, setSymptoms] = useState('');
  const [stepId, setStepId] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Add problem"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!title.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const created = await api.post<{ problem: { id: string } }>(`/api/projects/${ctx.projectId}/problems`, {
                  title,
                  symptoms: symptoms || null,
                  stepId: stepId || null,
                });
                await api.post(`/api/projects/${ctx.projectId}/problems/${created.problem.id}/ai/elaborate`, {});
                await ctx.reload();
                onClose();
              } catch (error) {
                ctx.toast.error(error);
                setBusy(false);
              }
            }}
          >
            Add and analyse
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="What went wrong?">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Domain join failed" />
        </Field>
        <Field label="Symptoms" hint="The exact error text if you have it — that is what makes diagnosis possible.">
          <textarea className="textarea" value={symptoms} onChange={(e) => setSymptoms(e.target.value)} />
        </Field>
        <Field label="Which step was this during?">
          <select className="select" value={stepId} onChange={(e) => setStepId(e.target.value)}>
            <option value="">Not tied to a specific step</option>
            {ctx.steps.map((step) => (
              <option key={step.id} value={step.id}>
                {step.position}. {step.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
