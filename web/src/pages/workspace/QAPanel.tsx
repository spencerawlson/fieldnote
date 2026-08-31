import { useEffect, useState } from 'react';
import { api, type QaItem } from '../../lib/api.ts';
import { Alert, Button, Card, CardHead, ConfidenceDots, Empty, InlineEdit } from '../../components/ui.tsx';
import type { WorkspaceContext } from './ProjectWorkspace.tsx';

export function QAPanel({ ctx }: { ctx: WorkspaceContext }) {
  const [items, setItems] = useState<QaItem[] | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const load = async () => {
    try {
      const response = await api.get<{ questions: QaItem[] }>(`/api/projects/${ctx.projectId}/questions`);
      setItems(response.questions);
    } catch (error) {
      ctx.toast.error(error);
      setItems([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.projectId, ctx.activeJobs.length]);

  if (items === null) {
    return (
      <div className="row muted">
        <span className="spinner" /> Loading questions…
      </div>
    );
  }

  const categories = ['all', ...new Set(items.map((item) => item.question.category))];
  const visible = filter === 'all' ? items : items.filter((item) => item.question.category === filter);

  const generate = async () => {
    try {
      await api.post(`/api/projects/${ctx.projectId}/questions/generate`, { count: 14 });
      ctx.toast.show('Preparing questions…');
    } catch (error) {
      ctx.toast.error(error);
    }
  };

  if (items.length === 0) {
    return (
      <Empty
        title="No questions prepared"
        action={ctx.canEdit ? <Button variant="primary" onClick={() => void generate()}>Prepare me for questions</Button> : null}
      >
        Fieldnote generates the questions a reviewer is likely to ask about this specific work — including the ones
        your documentation cannot yet answer.
      </Empty>
    );
  }

  return (
    <div className="stack">
      <div className="row spread wrap">
        <div className="row wrap" style={{ gap: '0.35rem' }}>
          {categories.map((category) => (
            <button
              key={category}
              className="chip"
              style={filter === category ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
              onClick={() => setFilter(category)}
            >
              {category}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: '0.4rem' }}>
          <Button size="small" onClick={() => setRevealed(new Set(items.map((i) => i.question.id)))}>
            Reveal all
          </Button>
          <Button size="small" onClick={() => setRevealed(new Set())}>
            Hide all
          </Button>
          {ctx.canEdit ? <Button size="small" onClick={() => void generate()}>Regenerate</Button> : null}
        </div>
      </div>

      <div className="stack">
        {visible.map((item) => {
          const open = revealed.has(item.question.id);
          const grounded = (item.answer?.grounding.length ?? 0) > 0;
          return (
            <Card key={item.question.id}>
              <CardHead
                title={item.question.text}
                subtitle={
                  <span className="row" style={{ gap: '0.35rem' }}>
                    <span className="badge">{item.question.category}</span>
                    <span className="badge">{item.question.level}</span>
                    {grounded ? (
                      <span className="badge ok">answerable from your project</span>
                    ) : (
                      <span className="badge warn">not established in your project</span>
                    )}
                  </span>
                }
                actions={
                  <Button
                    size="small"
                    onClick={() =>
                      setRevealed((current) => {
                        const next = new Set(current);
                        if (next.has(item.question.id)) next.delete(item.question.id);
                        else next.add(item.question.id);
                        return next;
                      })
                    }
                  >
                    {open ? 'Hide answer' : 'Show answer'}
                  </Button>
                }
              />
              {open && item.answer ? (
                <div className="card-body stack">
                  <div className="stack tight">
                    <div className="row" style={{ gap: '0.4rem' }}>
                      <span className="label">From your project</span>
                      <ConfidenceDots level={item.answer.confidence} />
                    </div>
                    {ctx.canEdit ? (
                      <InlineEdit
                        value={item.answer.text}
                        multiline
                        className="small"
                        onSave={async (value) => {
                          try {
                            await api.patch(`/api/projects/${ctx.projectId}/answers/${item.answer!.id}`, { text: value });
                            await load();
                          } catch (error) {
                            ctx.toast.error(error);
                          }
                        }}
                      />
                    ) : (
                      <p className="small">{item.answer.text}</p>
                    )}
                  </div>

                  {item.answer.generalKnowledge ? (
                    <div className="stack tight">
                      <span className="label">General background (not from your project)</span>
                      <p className="small muted">{item.answer.generalKnowledge}</p>
                    </div>
                  ) : null}

                  {grounded ? (
                    <div className="row wrap" style={{ gap: '0.3rem' }}>
                      <span className="tiny dim">Based on:</span>
                      {item.answer.grounding.map((source, index) => {
                        const label =
                          source.type === 'step'
                            ? ctx.steps.find((s) => s.id === source.id)?.title
                            : source.type === 'problem'
                              ? ctx.problems.find((p) => p.id === source.id)?.title
                              : ctx.evidence.find((e) => e.id === source.id)?.title;
                        return (
                          <span key={index} className="badge">
                            {source.type}: {label ?? source.id}
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <Alert tone="warn">
                      Your project does not answer this. If you expect to be asked, add the missing step, evidence
                      or explanation before you present.
                    </Alert>
                  )}
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
