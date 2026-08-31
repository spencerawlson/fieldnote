import { useRef, useState } from 'react';
import { api, type Evidence } from '../../lib/api.ts';
import {
  Alert,
  Button,
  Card,
  CardHead,
  ConfidenceDots,
  Empty,
  Field,
  Modal,
  StatusBadge,
} from '../../components/ui.tsx';
import type { WorkspaceContext } from './ProjectWorkspace.tsx';

export function EvidencePanel({ ctx }: { ctx: WorkspaceContext }) {
  const [selected, setSelected] = useState<Evidence | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      await api.upload(`/api/projects/${ctx.projectId}/evidence/upload`, list);
      ctx.toast.show(`${list.length} file${list.length === 1 ? '' : 's'} uploaded — analysis queued.`, 'ok');
      await ctx.reload();
    } catch (error) {
      ctx.toast.error(error);
    } finally {
      setUploading(false);
    }
  };

  const unlinked = ctx.evidence.filter((item) => item.links.length === 0);
  const sensitive = ctx.evidence.filter((item) => item.sensitive);

  return (
    <div className="stack">
      {ctx.canEdit ? (
        <div
          className={`empty ${dragging ? 'dragging' : ''}`}
          style={{
            padding: '1.5rem',
            borderColor: dragging ? 'var(--accent)' : undefined,
            background: dragging ? 'var(--accent-soft)' : undefined,
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files);
          }}
        >
          <div className="row" style={{ justifyContent: 'center', gap: '0.6rem' }}>
            {uploading ? <span className="spinner" /> : null}
            <strong>{uploading ? 'Uploading…' : 'Drop screenshots here'}</strong>
          </div>
          <p>
            PNG, JPEG, WEBP, GIF, BMP, TIFF, PDF, DOCX and plain text. Each upload is analysed, transcribed and
            matched to the step or problem it supports.
          </p>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/*,application/pdf,.docx,.txt,.log,.md,.csv,.json,.yaml"
            onChange={(e) => e.target.files && void upload(e.target.files)}
          />
          <Button onClick={() => fileInput.current?.click()} disabled={uploading}>
            Choose files
          </Button>
        </div>
      ) : null}

      {sensitive.length > 0 ? (
        <Alert tone="warn">
          <span>
            <strong>{sensitive.length} item{sensitive.length === 1 ? '' : 's'} may contain secrets.</strong>{' '}
            Extracted text is stored redacted, and the redacted version is what reaches the AI and your exports.
            Review before sharing.
          </span>
        </Alert>
      ) : null}

      {unlinked.length > 0 && ctx.canEdit ? (
        <div className="row spread">
          <span className="small muted">
            {unlinked.length} item{unlinked.length === 1 ? ' is' : 's are'} not attached to any step or problem.
          </span>
          <Button
            size="small"
            onClick={async () => {
              try {
                await api.post(`/api/projects/${ctx.projectId}/ai/link-evidence`, {});
                await ctx.reload();
                ctx.toast.show('Evidence matched to steps and problems.', 'ok');
              } catch (error) {
                ctx.toast.error(error);
              }
            }}
          >
            Match automatically
          </Button>
        </div>
      ) : null}

      {ctx.evidence.length === 0 ? (
        <Empty title="No evidence yet">
          Screenshots are the densest evidence there is — an error message, a command and an outcome in one
          image. Upload them and they become figures in your report and slides in your deck.
        </Empty>
      ) : (
        <div className="thumbs">
          {ctx.evidence.map((item) => (
            <button key={item.id} className="thumb" onClick={() => setSelected(item)}>
              <div className="frame">
                {item.file ? (
                  <img
                    src={`/api/projects/${ctx.projectId}/files/${item.file.id}?variant=thumb`}
                    alt={item.caption ?? item.title}
                    loading="lazy"
                  />
                ) : (
                  <span className="dim tiny">{item.kind}</span>
                )}
              </div>
              <div className="meta">
                <span className="name truncate">{item.title || 'Untitled'}</span>
                <div className="row" style={{ gap: '0.3rem', flexWrap: 'wrap' }}>
                  <StatusBadge status={item.reviewState} />
                  {item.sensitive ? <span className="badge warn">secrets</span> : null}
                  {item.links.length > 0 ? <span className="badge">{item.links.length} link{item.links.length === 1 ? '' : 's'}</span> : null}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <EvidenceDetail
          ctx={ctx}
          evidenceId={selected.id}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function EvidenceDetail({
  ctx,
  evidenceId,
  onClose,
}: {
  ctx: WorkspaceContext;
  evidenceId: string;
  onClose: () => void;
}) {
  const item = ctx.evidence.find((e) => e.id === evidenceId);
  const [caption, setCaption] = useState(item?.caption ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);

  if (!item) return null;

  const review = async (verdict: 'confirm' | 'correct' | 'reject') => {
    setBusy(true);
    try {
      await api.post(`/api/projects/${ctx.projectId}/evidence/${item.id}/review`, {
        verdict,
        ...(verdict === 'correct' ? { description, caption } : { caption }),
      });
      await ctx.reload();
      if (verdict === 'reject') onClose();
    } catch (error) {
      ctx.toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  const analysis = item.analysis;

  return (
    <Modal
      title={item.title || 'Evidence'}
      onClose={onClose}
      footer={
        ctx.canEdit ? (
          <>
            <Button variant="danger" onClick={() => void review('reject')} loading={busy}>
              Reject
            </Button>
            <div style={{ flex: 1 }} />
            <Button onClick={() => void review('correct')} loading={busy}>
              Save correction
            </Button>
            <Button variant="primary" onClick={() => void review('confirm')} loading={busy}>
              Confirm reading
            </Button>
          </>
        ) : null
      }
    >
      <div className="stack loose">
        {item.file ? (
          <img
            src={`/api/projects/${ctx.projectId}/files/${item.file.id}`}
            alt={item.caption ?? item.title}
            style={{ width: '100%', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)' }}
          />
        ) : null}

        <div className="row wrap" style={{ gap: '0.4rem' }}>
          <StatusBadge status={item.reviewState} />
          <span className="badge">{item.kind}</span>
          {item.confidence ? (
            <span className="badge">
              AI confidence <ConfidenceDots level={item.confidence} />
            </span>
          ) : null}
          {item.sensitive ? <span className="badge warn">possible secrets</span> : null}
        </div>

        {analysis ? (
          <Card>
            <CardHead title="What the AI sees" subtitle="Check this. Correct it if it is wrong — your version wins." />
            <div className="card-body stack tight">
              <p className="small">{analysis.description}</p>
              {analysis.detectedApp || analysis.detectedOs ? (
                <div className="row wrap tiny dim" style={{ gap: '0.75rem' }}>
                  {analysis.detectedApp ? <span>Application: {analysis.detectedApp}</span> : null}
                  {analysis.detectedOs ? <span>OS: {analysis.detectedOs}</span> : null}
                </div>
              ) : null}

              {analysis.observations.length > 0 ? (
                <ul className="small muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                  {analysis.observations.map((observation, index) => (
                    <li key={index}>
                      {observation.text} <ConfidenceDots level={observation.confidence} />
                    </li>
                  ))}
                </ul>
              ) : null}

              {Object.entries(analysis.entities).filter(([, values]) => values.length > 0).length > 0 ? (
                <div className="stack tight">
                  <span className="label">Detected</span>
                  <table className="data">
                    <tbody>
                      {Object.entries(analysis.entities)
                        .filter(([, values]) => values.length > 0)
                        .map(([key, values]) => (
                          <tr key={key}>
                            <td className="dim" style={{ width: '8rem' }}>{key}</td>
                            <td className="mono tiny">{values.join(', ')}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </Card>
        ) : (
          <Alert tone="info">This item has not been analysed yet.</Alert>
        )}

        {item.ocr ? (
          <div className="stack tight">
            <span className="label">
              Extracted text{item.ocr.redacted ? ' (secrets redacted)' : ''} — {item.ocr.chars} characters, searchable
            </span>
            <pre className="code" style={{ maxHeight: '10rem' }}>{item.ocr.preview}</pre>
          </div>
        ) : null}

        {ctx.canEdit ? (
          <>
            <Field label="Caption" hint="Used as the figure caption in reports and under slide images.">
              <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} />
            </Field>
            <Field label="Your description" hint="Overrides the AI reading everywhere this evidence is used.">
              <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
            </Field>
          </>
        ) : null}

        <div className="stack tight">
          <div className="row spread">
            <span className="label">Attached to</span>
            {ctx.canEdit ? (
              <Button size="small" variant="ghost" onClick={() => setLinking(!linking)}>
                {linking ? 'Cancel' : 'Attach to…'}
              </Button>
            ) : null}
          </div>

          {item.links.length === 0 ? (
            <p className="small dim">Not attached to anything yet.</p>
          ) : (
            <table className="data">
              <tbody>
                {item.links.map((link) => {
                  const target =
                    link.targetType === 'step'
                      ? ctx.steps.find((s) => s.id === link.targetId)?.title
                      : link.targetType === 'problem'
                        ? ctx.problems.find((p) => p.id === link.targetId)?.title
                        : link.targetId;
                  return (
                    <tr key={link.id}>
                      <td>
                        <span className="badge">{link.role}</span>
                      </td>
                      <td>{target ?? link.targetId}</td>
                      <td className="tiny dim">{link.origin === 'ai' ? 'matched by AI' : 'set by you'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {ctx.canEdit ? (
                          <Button
                            size="small"
                            variant="ghost"
                            onClick={async () => {
                              try {
                                await api.del(`/api/projects/${ctx.projectId}/evidence/links/${link.id}`);
                                await ctx.reload();
                              } catch (error) {
                                ctx.toast.error(error);
                              }
                            }}
                          >
                            Detach
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {linking ? <LinkForm ctx={ctx} evidenceId={item.id} onDone={() => setLinking(false)} /> : null}
        </div>
      </div>
    </Modal>
  );
}

function LinkForm({ ctx, evidenceId, onDone }: { ctx: WorkspaceContext; evidenceId: string; onDone: () => void }) {
  const [targetType, setTargetType] = useState<'step' | 'problem'>('step');
  const [targetId, setTargetId] = useState(ctx.steps[0]?.id ?? '');
  const [role, setRole] = useState('supports');

  const options = targetType === 'step' ? ctx.steps : ctx.problems;

  return (
    <div className="stack tight" style={{ padding: '0.7rem', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
      <div className="grid three">
        <Field label="Attach to">
          <select
            className="select"
            value={targetType}
            onChange={(e) => {
              const next = e.target.value as 'step' | 'problem';
              setTargetType(next);
              setTargetId((next === 'step' ? ctx.steps[0]?.id : ctx.problems[0]?.id) ?? '');
            }}
          >
            <option value="step">Step</option>
            <option value="problem">Problem</option>
          </select>
        </Field>
        <Field label="Which one">
          <select className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Role">
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            {['supports', 'before', 'after', 'symptom', 'investigation', 'resolution', 'validation'].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Button
        size="small"
        variant="primary"
        disabled={!targetId}
        onClick={async () => {
          try {
            await api.post(`/api/projects/${ctx.projectId}/evidence/${evidenceId}/links`, { targetType, targetId, role });
            await ctx.reload();
            onDone();
          } catch (error) {
            ctx.toast.error(error);
          }
        }}
      >
        Attach
      </Button>
    </div>
  );
}
