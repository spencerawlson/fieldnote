import { useEffect, useState } from 'react';
import { api, type Insight } from '../../lib/api.ts';
import { Alert, Button, Card, CardHead, Empty, InlineEdit, Meter } from '../../components/ui.tsx';
import type { TabKey, WorkspaceContext } from './ProjectWorkspace.tsx';

interface TimelineEvent {
  type: 'step' | 'problem';
  id: string;
  at: string;
  hasExplicitTime: boolean;
  title: string;
  detail: string;
  category: string;
  status: string;
}

export function OverviewPanel({
  ctx,
  onNavigate,
  analysisOnly,
}: {
  ctx: WorkspaceContext;
  onNavigate: (tab: TabKey) => void;
  analysisOnly?: boolean;
}) {
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);

  useEffect(() => {
    if (analysisOnly) return;
    void api
      .get<{ events: TimelineEvent[] }>(`/api/projects/${ctx.projectId}/timeline`)
      .then((response) => setTimeline(response.events))
      .catch(() => setTimeline([]));
  }, [ctx.projectId, ctx.steps.length, ctx.problems.length, analysisOnly]);

  if (analysisOnly) {
    return <AnalysisSection ctx={ctx} onNavigate={onNavigate} full />;
  }

  const save = async (patch: Record<string, unknown>) => {
    try {
      await api.patch(`/api/projects/${ctx.projectId}`, patch);
      await ctx.reload();
    } catch (error) {
      ctx.toast.error(error);
    }
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', alignItems: 'start' }}>
      <div className="stack">
        <Card>
          <CardHead title="Project framing" subtitle="Click any field to edit. These feed every generated output." />
          <div className="card-body stack">
            <Framing label="Objective" value={ctx.project.objective ?? ''} onSave={(v) => save({ objective: v })} canEdit={ctx.canEdit} />
            <Framing label="Scope" value={ctx.project.scope ?? ''} onSave={(v) => save({ scope: v })} canEdit={ctx.canEdit} />
            <Framing label="Environment" value={ctx.project.environment ?? ''} onSave={(v) => save({ environment: v })} canEdit={ctx.canEdit} />
            <Framing label="Architecture" value={ctx.project.architecture ?? ''} onSave={(v) => save({ architecture: v })} canEdit={ctx.canEdit} />
            <Framing label="Conclusion" value={ctx.project.conclusion ?? ''} onSave={(v) => save({ conclusion: v })} canEdit={ctx.canEdit} />
          </div>
        </Card>

        <Card>
          <CardHead
            title="Timeline"
            subtitle="Ordered by your step sequence; timestamps used where you recorded them."
            actions={
              <Button size="small" onClick={() => onNavigate('steps')}>
                Edit steps
              </Button>
            }
          />
          <div className="card-body">
            {timeline.length === 0 ? (
              <Empty title="Nothing recorded yet">
                Add steps, or paste your notes and let Fieldnote structure them.
              </Empty>
            ) : (
              <div className="timeline">
                {timeline.map((event) => (
                  <div key={event.id} className={`timeline-item ${event.type === 'problem' ? 'problem' : event.status}`}>
                    <div className="row" style={{ gap: '0.5rem', alignItems: 'baseline' }}>
                      <strong className="small">{event.title}</strong>
                      <span className="badge">{event.category}</span>
                      {event.type === 'problem' ? <span className="badge danger">problem</span> : null}
                      <div style={{ flex: 1 }} />
                      <span className="tiny dim nowrap">
                        {event.hasExplicitTime ? new Date(event.at).toLocaleString() : '—'}
                      </span>
                    </div>
                    {event.detail ? <div className="small muted">{event.detail}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="stack">
        <CompletenessCard ctx={ctx} />
        <AnalysisSection ctx={ctx} onNavigate={onNavigate} />
        <Card>
          <CardHead title="At a glance" />
          <div className="card-body">
            <table className="data">
              <tbody>
                <Row label="Steps" value={String(ctx.steps.length)} />
                <Row label="Elaborated" value={`${ctx.steps.filter((s) => s.aiState === 'elaborated').length} of ${ctx.steps.length}`} />
                <Row label="Evidence" value={String(ctx.evidence.length)} />
                <Row label="Unreviewed evidence" value={String(ctx.evidence.filter((e) => e.reviewState === 'unreviewed' || e.reviewState === 'ai-analyzed').length)} />
                <Row label="Problems" value={String(ctx.problems.length)} />
                <Row label="Unresolved" value={String(ctx.problems.filter((p) => p.status !== 'resolved' && p.status !== 'wont-fix').length)} />
                <Row label="Audience" value={ctx.project.audience} />
                <Row label="Tone" value={ctx.project.tone} />
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="dim">{label}</td>
      <td style={{ textAlign: 'right', fontWeight: 600 }}>{value}</td>
    </tr>
  );
}

function Framing({
  label,
  value,
  onSave,
  canEdit,
}: {
  label: string;
  value: string;
  onSave: (next: string) => void;
  canEdit: boolean;
}) {
  return (
    <div className="stack tight">
      <span className="label">{label}</span>
      {canEdit ? (
        <InlineEdit value={value} multiline onSave={onSave} placeholder={`No ${label.toLowerCase()} recorded — click to add`} className="small" />
      ) : (
        <span className="small muted">{value || '—'}</span>
      )}
    </div>
  );
}

function CompletenessCard({ ctx }: { ctx: WorkspaceContext }) {
  const { completeness } = ctx;
  return (
    <Card>
      <CardHead title="Completeness" subtitle={`${completeness.percent}% — documentation coverage estimate`} />
      <div className="card-body stack">
        <Meter value={completeness.percent} />
        <div className="stack tight">
          {completeness.categories.map((category) => (
            <div key={category.key} className="row" style={{ gap: '0.6rem' }}>
              <span className="tiny" style={{ width: '9.5rem' }}>{category.label}</span>
              <div style={{ flex: 1 }}>
                <Meter value={category.score * 100} />
              </div>
              <span className="tiny dim nowrap">{Math.round(category.score * 100)}%</span>
            </div>
          ))}
        </div>
        {completeness.missing.length > 0 ? (
          <div className="stack tight">
            <span className="label">Missing</span>
            <ul className="small muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {completeness.missing.slice(0, 6).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="tiny dim">{completeness.note}</p>
      </div>
    </Card>
  );
}

function AnalysisSection({
  ctx,
  onNavigate,
  full,
}: {
  ctx: WorkspaceContext;
  onNavigate: (tab: TabKey) => void;
  full?: boolean;
}) {
  const insights = full ? ctx.insights : ctx.insights.slice(0, 5);

  const setState = async (insight: Insight, state: string) => {
    try {
      await api.patch(`/api/projects/${ctx.projectId}/insights/${insight.id}`, { state });
      await ctx.reload();
    } catch (error) {
      ctx.toast.error(error);
    }
  };

  const jump = (insight: Insight) => {
    const target = insight.targets[0];
    if (!target) return;
    if (target.type === 'step') onNavigate('steps');
    else if (target.type === 'problem') onNavigate('problems');
    else if (target.type === 'evidence') onNavigate('evidence');
    else if (target.type === 'slide') onNavigate('presentation');
  };

  return (
    <Card>
      <CardHead
        title="What needs attention"
        subtitle={ctx.insights.length === 0 ? 'Nothing outstanding' : `${ctx.insights.length} open findings`}
        actions={
          ctx.canEdit ? (
            <Button
              size="small"
              onClick={async () => {
                try {
                  await api.post(`/api/projects/${ctx.projectId}/ai/review`);
                  ctx.toast.show('Re-checking the documentation…');
                } catch (error) {
                  ctx.toast.error(error);
                }
              }}
            >
              Re-check
            </Button>
          ) : null
        }
      />
      <div className="card-body stack">
        {insights.length === 0 ? (
          <p className="small muted">
            No gaps found. Run <em>Analyse project</em> after adding new work to check again.
          </p>
        ) : (
          insights.map((insight) => (
            <div key={insight.id} className="stack tight" style={{ paddingBottom: '0.6rem', borderBottom: '1px solid var(--line)' }}>
              <div className="row" style={{ gap: '0.4rem', alignItems: 'flex-start' }}>
                <span className={`badge ${insight.severity === 'critical' ? 'danger' : insight.severity === 'warning' ? 'warn' : ''}`}>
                  {insight.severity}
                </span>
                <strong className="small" style={{ flex: 1 }}>{insight.title}</strong>
              </div>
              <p className="small muted">{insight.detail}</p>
              {insight.suggestion ? <p className="tiny" style={{ color: 'var(--accent)' }}>{insight.suggestion}</p> : null}
              {ctx.canEdit ? (
                <div className="row" style={{ gap: '0.35rem' }}>
                  {insight.targets.length > 0 ? (
                    <Button size="small" variant="ghost" onClick={() => jump(insight)}>
                      Go to {insight.targets[0]!.type}
                    </Button>
                  ) : null}
                  <Button size="small" variant="ghost" onClick={() => void setState(insight, 'resolved')}>
                    Mark handled
                  </Button>
                  <Button size="small" variant="ghost" onClick={() => void setState(insight, 'dismissed')}>
                    Dismiss
                  </Button>
                </div>
              ) : null}
            </div>
          ))
        )}

        {!full && ctx.insights.length > 5 ? (
          <Button size="small" variant="ghost" onClick={() => onNavigate('analysis')}>
            See all {ctx.insights.length} findings
          </Button>
        ) : null}

        {full && ctx.session.meta.ai.offline ? (
          <Alert tone="warn">
            Offline mode is active, so these findings come from the built-in rule-based checks rather than a
            model. Configure an API key for full analysis.
          </Alert>
        ) : null}
      </div>
    </Card>
  );
}
