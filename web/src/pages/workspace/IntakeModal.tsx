import { useEffect, useState } from 'react';
import { api } from '../../lib/api.ts';
import { Alert, Button, Field, Modal, StatusBadge } from '../../components/ui.tsx';
import type { WorkspaceContext } from './ProjectWorkspace.tsx';

interface Proposal {
  steps: {
    title: string;
    userDescription: string;
    category: string;
    status?: string;
    order: number;
    confidence?: string;
  }[];
  problems: {
    title: string;
    symptoms?: string | null;
    relatedStepOrder?: number | null;
    resolutionStepOrder?: number | null;
    resolution?: string | null;
    status?: string;
  }[];
  suggestedTitle?: string | null;
  suggestedObjective?: string | null;
  domain?: string | null;
  clarifications?: string[];
  injectionDetected?: string[];
}

/**
 * Intake.
 *
 * The user writes the way they think — one action per line, no structure. This
 * shows exactly what will be created before anything is written, because the
 * structuring step is where a misreading would propagate into every output.
 */
export function IntakeModal({
  ctx,
  initialNotes,
  onClose,
}: {
  ctx: WorkspaceContext;
  initialNotes: string;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyObjective, setApplyObjective] = useState(true);

  const analyse = async () => {
    setBusy(true);
    try {
      const response = await api.post<{ proposal: Proposal }>(`/api/projects/${ctx.projectId}/ai/structure`, { notes });
      setProposal(response.proposal);
    } catch (error) {
      ctx.toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  // Notes handed over from project creation are structured immediately.
  useEffect(() => {
    if (initialNotes.trim()) void analyse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = async () => {
    if (!proposal) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${ctx.projectId}/ai/structure/commit`, {
        proposal,
        applyObjective,
        analyze: true,
      });
      ctx.toast.show('Steps created. Analysis is running — evidence, elaboration and review.', 'ok');
      await ctx.reload();
      onClose();
    } catch (error) {
      ctx.toast.error(error);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Structure your notes"
      onClose={onClose}
      footer={
        proposal ? (
          <>
            <Button onClick={() => setProposal(null)}>Back to notes</Button>
            <div style={{ flex: 1 }} />
            <Button onClick={onClose}>Discard</Button>
            <Button variant="primary" loading={busy} onClick={() => void commit()}>
              Create {proposal.steps.length} steps
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!notes.trim()} onClick={() => void analyse()}>
              Structure these notes
            </Button>
          </>
        )
      }
    >
      {!proposal ? (
        <div className="stack">
          <Field
            label="What did you do?"
            hint="One action per line. Write it the way you would tell a colleague — the AI will not change your words."
          >
            <textarea
              className="textarea"
              style={{ minHeight: 220 }}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              autoFocus
            />
          </Field>
          {busy ? (
            <div className="row muted small">
              <span className="spinner" /> Reading your notes…
            </div>
          ) : null}
        </div>
      ) : (
        <div className="stack loose">
          <Alert tone="info">
            Nothing has been saved yet. Review what will be created — your original sentence is kept verbatim on
            every step.
          </Alert>

          {proposal.injectionDetected?.length ? (
            <Alert tone="warn">
              These notes contain text that looks like instructions to an AI ({proposal.injectionDetected.join(', ')}).
              It was treated as content, not obeyed.
            </Alert>
          ) : null}

          {proposal.clarifications?.length ? (
            <div className="stack tight">
              <span className="label">Worth clarifying</span>
              <ul className="small muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {proposal.clarifications.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {proposal.suggestedObjective && !ctx.project.objective ? (
            <label className="row" style={{ gap: '0.5rem', alignItems: 'flex-start' }}>
              <input type="checkbox" checked={applyObjective} onChange={(e) => setApplyObjective(e.target.checked)} />
              <span className="small">
                Use suggested objective: <em>{proposal.suggestedObjective}</em>
              </span>
            </label>
          ) : null}

          <div className="stack tight">
            <span className="label">{proposal.steps.length} steps</span>
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: '2rem' }}>#</th>
                  <th>Title</th>
                  <th style={{ width: '8rem' }}>Category</th>
                  <th style={{ width: '5rem' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {proposal.steps.map((step) => (
                  <tr key={step.order}>
                    <td className="dim">{step.order}</td>
                    <td>
                      <div>{step.title}</div>
                      <div className="tiny dim">{step.userDescription}</div>
                    </td>
                    <td>
                      <span className="badge">{step.category}</span>
                    </td>
                    <td>
                      <StatusBadge status={step.status ?? 'done'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {proposal.problems.length > 0 ? (
            <div className="stack tight">
              <span className="label">{proposal.problems.length} problems detected</span>
              <table className="data">
                <tbody>
                  {proposal.problems.map((problem, index) => (
                    <tr key={index}>
                      <td>
                        <div>{problem.title}</div>
                        {problem.symptoms ? <div className="tiny dim">{problem.symptoms}</div> : null}
                      </td>
                      <td style={{ width: '9rem' }}>
                        <StatusBadge status={problem.status ?? 'open'} />
                        {problem.resolutionStepOrder ? (
                          <div className="tiny dim">resolved at step {problem.resolutionStepOrder}</div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
