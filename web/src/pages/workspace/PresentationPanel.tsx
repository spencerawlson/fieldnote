import { useEffect, useState } from 'react';
import { api, type Insight, type PresentationSummary, type Slide, type TemplateInfo } from '../../lib/api.ts';
import { Alert, Button, Card, CardHead, Empty, Field, InlineEdit, Modal, StatusBadge } from '../../components/ui.tsx';
import { ThemePicker, themeStyle, useThemes } from '../../components/ThemePicker.tsx';
import type { WorkspaceContext } from './ProjectWorkspace.tsx';
import { ExportBar } from './ExportBar.tsx';

export function PresentationPanel({ ctx }: { ctx: WorkspaceContext }) {
  const [decks, setDecks] = useState<PresentationSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      const response = await api.get<{ presentations: PresentationSummary[] }>(
        `/api/projects/${ctx.projectId}/presentations`,
      );
      setDecks(response.presentations);
      if (!openId && response.presentations[0]) setOpenId(response.presentations[0].id);
    } catch (error) {
      ctx.toast.error(error);
      setDecks([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.projectId, ctx.activeJobs.length]);

  if (decks === null) {
    return (
      <div className="row muted">
        <span className="spinner" /> Loading presentations…
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row spread">
        <p className="small muted" style={{ margin: 0 }}>
          A deck is not a shortened report. Slides stay short; the explanation goes into the speaker notes.
        </p>
        {ctx.canEdit ? <Button variant="primary" onClick={() => setCreating(true)}>New presentation</Button> : null}
      </div>

      {decks.length === 0 ? (
        <Empty
          title="No presentation yet"
          action={ctx.canEdit ? <Button variant="primary" onClick={() => setCreating(true)}>Build a deck</Button> : null}
        >
          Choose an audience and a length. Fieldnote decides what belongs on the slide, what belongs in the notes,
          and which screenshots actually earn their place.
        </Empty>
      ) : (
        <div className="stack">
          <div className="row wrap" style={{ gap: '0.4rem' }}>
            {decks.map((deck) => (
              <button
                key={deck.id}
                className="chip"
                style={
                  openId === deck.id
                    ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' }
                    : undefined
                }
                onClick={() => setOpenId(deck.id)}
              >
                {deck.title} · {deck.slides} slides{deck.stale ? ' · stale' : ''}
              </button>
            ))}
          </div>
          {openId ? <DeckView key={openId} ctx={ctx} presentationId={openId} onChanged={load} /> : null}
        </div>
      )}

      {creating ? (
        <NewDeckModal
          ctx={ctx}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function DeckView({
  ctx,
  presentationId,
  onChanged,
}: {
  ctx: WorkspaceContext;
  presentationId: string;
  onChanged: () => void;
}) {
  const [data, setData] = useState<{
    presentation: PresentationSummary;
    slides: Slide[];
    coaching: Insight[];
    stale: boolean;
  } | null>(null);
  const themes = useThemes('presentation');

  const load = async () => {
    try {
      setData(
        await api.get(`/api/projects/${ctx.projectId}/presentations/${presentationId}`),
      );
    } catch (error) {
      ctx.toast.error(error);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentationId, ctx.activeJobs.length]);

  if (!data) {
    return (
      <div className="row muted">
        <span className="spinner" /> Loading deck…
      </div>
    );
  }

  const { presentation, slides, coaching, stale } = data;

  const action = async (path: string, message: string) => {
    try {
      await api.post(`/api/projects/${ctx.projectId}/presentations/${presentationId}/${path}`);
      ctx.toast.show(message);
      onChanged();
    } catch (error) {
      ctx.toast.error(error);
    }
  };

  return (
    <div className="stack loose">
      <Card>
        <CardHead
          title={presentation.title}
          subtitle={`${presentation.templateKey} · ${presentation.audience} · ${slides.length} slides`}
          actions={
            <div className="row" style={{ gap: '0.4rem' }}>
              <StatusBadge status={presentation.status} />
              {ctx.canEdit ? (
                <>
                  <select
                    className="select"
                    style={{ width: 'auto' }}
                    value={presentation.theme ?? 'slate'}
                    title="Changes the look of the preview, the PPTX and the PDF"
                    onChange={async (event) => {
                      try {
                        // Purely visual, so the deck does not need rebuilding.
                        await api.patch(`/api/projects/${ctx.projectId}/presentations/${presentationId}`, {
                          theme: event.target.value,
                        });
                        await load();
                      } catch (error) {
                        ctx.toast.error(error);
                      }
                    }}
                  >
                    {themes.map((theme) => (
                      <option key={theme.key} value={theme.key}>
                        {theme.name}
                      </option>
                    ))}
                  </select>
                  <Button size="small" onClick={() => void action('notes', 'Rewriting speaker notes…')}>
                    Speaker notes
                  </Button>
                  <Button size="small" onClick={() => void action('review', 'Reviewing the deck…')}>
                    Coach
                  </Button>
                  <Button size="small" onClick={() => void action('generate', 'Rebuilding the deck…')}>
                    Regenerate
                  </Button>
                </>
              ) : null}
            </div>
          }
        />
        <div className="card-body stack">
          {stale ? (
            <Alert tone="warn">
              The project has changed since this deck was built. Regenerate to bring it up to date.
            </Alert>
          ) : null}
          {presentation.status === 'ready' ? (
            <ExportBar ctx={ctx} subjectType="presentation" subjectId={presentationId} formats={['pptx', 'pdf', 'html', 'md']} />
          ) : null}
        </div>
      </Card>

      {coaching.length > 0 ? (
        <Card>
          <CardHead title="Presentation coach" subtitle={`${coaching.length} suggestions before you present`} />
          <div className="card-body stack tight">
            {coaching.map((insight) => (
              <div key={insight.id} className="stack tight">
                <div className="row" style={{ gap: '0.4rem' }}>
                  <span className={`badge ${insight.severity === 'critical' ? 'danger' : insight.severity === 'warning' ? 'warn' : ''}`}>
                    {insight.severity}
                  </span>
                  <strong className="small">{insight.title}</strong>
                </div>
                <p className="small muted">{insight.detail}</p>
                {insight.suggestion ? <p className="tiny" style={{ color: 'var(--accent)' }}>{insight.suggestion}</p> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* Slide previews inherit the deck's theme, so what is on screen is what
          lands in the PPTX. */}
      <div className="grid two" style={themeStyle(themes.find((t) => t.key === (presentation.theme ?? 'slate')))}>
        {slides.map((slide) => (
          <SlideCard key={slide.id} ctx={ctx} slide={slide} onChanged={load} />
        ))}
      </div>
    </div>
  );
}

function SlideCard({ ctx, slide, onChanged }: { ctx: WorkspaceContext; slide: Slide; onChanged: () => void }) {
  const isCover = slide.layout === 'title' || slide.layout === 'closing';
  const evidence = slide.evidenceIds
    .map((id) => ctx.evidence.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const save = async (patch: Record<string, unknown>) => {
    try {
      await api.patch(`/api/projects/${ctx.projectId}/slides/${slide.id}`, patch);
      onChanged();
    } catch (error) {
      ctx.toast.error(error);
    }
  };

  const wordCount = slide.bullets.join(' ').split(/\s+/).filter(Boolean).length;

  return (
    <div className="slide-card">
      <div className={`canvas ${isCover ? 'cover' : ''}`}>
        <h3>{slide.title}</h3>
        {!isCover ? <span className="rule" /> : null}
        {slide.subtitle ? <div className="small dim">{slide.subtitle}</div> : null}
        <div className="row" style={{ alignItems: 'flex-start', gap: '0.75rem', flex: 1, minHeight: 0 }}>
          <ul style={{ flex: 1 }}>
            {slide.bullets.map((bullet, index) => (
              <li key={index}>{bullet}</li>
            ))}
          </ul>
          {evidence[0]?.file ? (
            <img
              src={`/api/projects/${ctx.projectId}/files/${evidence[0].file.id}?variant=thumb`}
              alt={evidence[0].caption ?? evidence[0].title}
              style={{ width: '38%', borderRadius: 4, border: '1px solid var(--line)', alignSelf: 'flex-start' }}
            />
          ) : null}
        </div>
      </div>

      <div className="notes">
        <div className="label" style={{ marginBottom: '0.25rem' }}>Speaker notes</div>
        {ctx.canEdit ? (
          <InlineEdit
            value={slide.speakerNotes}
            multiline
            onSave={(value) => save({ speakerNotes: value })}
            placeholder="No notes yet — click to write what you'll say"
            className="small"
          />
        ) : (
          <span className="small">{slide.speakerNotes || '—'}</span>
        )}
      </div>

      <div className="bar">
        <span>Slide {slide.position + 1}</span>
        <span className="badge">{slide.layout}</span>
        <span className={wordCount > 60 ? 'badge warn' : 'badge'}>{wordCount} words</span>
        {slide.editedByUser ? <span className="badge ok">edited</span> : null}
        <div style={{ flex: 1 }} />
        {ctx.canEdit ? (
          <Button
            size="small"
            variant="ghost"
            onClick={async () => {
              if (!confirm(`Delete slide "${slide.title}"?`)) return;
              try {
                await api.del(`/api/projects/${ctx.projectId}/slides/${slide.id}`);
                onChanged();
              } catch (error) {
                ctx.toast.error(error);
              }
            }}
          >
            Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function NewDeckModal({
  ctx,
  onClose,
  onCreated,
}: {
  ctx: WorkspaceContext;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [templateKey, setTemplateKey] = useState('technical-demo');
  const [slideTarget, setSlideTarget] = useState(12);
  const [audience, setAudience] = useState(ctx.project.audience);
  const [theme, setTheme] = useState('slate');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get<{ presentations: TemplateInfo[] }>('/api/templates')
      .then((response) => setTemplates(response.presentations))
      .catch(() => setTemplates([]));
  }, []);

  const selected = templates.find((t) => t.key === templateKey);

  return (
    <Modal
      title="New presentation"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const created = await api.post<{ presentation: { id: string } }>(
                  `/api/projects/${ctx.projectId}/presentations`,
                  { templateKey, slideTarget, audience, theme, generate: true },
                );
                ctx.toast.show('Building the deck…');
                onCreated(created.presentation.id);
              } catch (error) {
                ctx.toast.error(error);
                setBusy(false);
              }
            }}
          >
            Build deck
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Template">
          <select className="select" value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
            {templates.map((template) => (
              <option key={template.key} value={template.key}>
                {template.name}
              </option>
            ))}
          </select>
        </Field>
        {selected ? <p className="small muted">{selected.description}</p> : null}

        <div className="grid two">
          <Field label="Slides" hint="Low-priority slides are dropped first.">
            <select className="select" value={slideTarget} onChange={(e) => setSlideTarget(Number(e.target.value))}>
              {[5, 8, 10, 12, 15, 20].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Audience">
            <select className="select" value={audience} onChange={(e) => setAudience(e.target.value)}>
              {ctx.session.meta.audiences.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <ThemePicker kind="presentation" value={theme} onChange={setTheme} />
      </div>
    </Modal>
  );
}
