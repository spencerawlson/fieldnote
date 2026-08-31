import { useEffect, useState } from 'react';
import {
  api,
  type ReportBlock,
  type ReportSection,
  type ReportSummary,
  type TemplateInfo,
} from '../../lib/api.ts';
import { Alert, Button, Card, CardHead, Empty, Field, Modal, StatusBadge } from '../../components/ui.tsx';
import { ThemePicker, themeStyle, useThemes } from '../../components/ThemePicker.tsx';
import type { WorkspaceContext } from './ProjectWorkspace.tsx';
import { ExportBar } from './ExportBar.tsx';

export function ReportPanel({ ctx }: { ctx: WorkspaceContext }) {
  const [reports, setReports] = useState<ReportSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      const response = await api.get<{ reports: ReportSummary[] }>(`/api/projects/${ctx.projectId}/reports`);
      setReports(response.reports);
      if (!openId && response.reports[0]) setOpenId(response.reports[0].id);
    } catch (error) {
      ctx.toast.error(error);
      setReports([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.projectId, ctx.activeJobs.length]);

  if (reports === null) {
    return (
      <div className="row muted">
        <span className="spinner" /> Loading reports…
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row spread">
        <p className="small muted" style={{ margin: 0 }}>
          Reports are generated from the project record. Change a fact and regenerate — you never maintain two
          copies.
        </p>
        {ctx.canEdit ? <Button variant="primary" onClick={() => setCreating(true)}>New report</Button> : null}
      </div>

      {reports.length === 0 ? (
        <Empty
          title="No report yet"
          action={ctx.canEdit ? <Button variant="primary" onClick={() => setCreating(true)}>Generate a report</Button> : null}
        >
          Pick a template and Fieldnote writes the document from your steps, evidence and problems — with figures
          numbered, captions attached and inferences marked as inferences.
        </Empty>
      ) : (
        <div className="stack">
          <div className="row wrap" style={{ gap: '0.4rem' }}>
            {reports.map((report) => (
              <button
                key={report.id}
                className={`chip ${openId === report.id ? '' : ''}`}
                style={
                  openId === report.id
                    ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-soft)' }
                    : undefined
                }
                onClick={() => setOpenId(report.id)}
              >
                {report.title} · {report.templateKey}
                {report.stale ? ' · stale' : ''}
              </button>
            ))}
          </div>

          {openId ? <ReportView key={openId} ctx={ctx} reportId={openId} onChanged={load} /> : null}
        </div>
      )}

      {creating ? (
        <NewReportModal
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

function ReportView({ ctx, reportId, onChanged }: { ctx: WorkspaceContext; reportId: string; onChanged: () => void }) {
  const [data, setData] = useState<{ report: ReportSummary; sections: ReportSection[]; stale: boolean } | null>(null);
  const themes = useThemes('report');

  const load = async () => {
    try {
      const response = await api.get<{ report: ReportSummary; sections: ReportSection[]; stale: boolean }>(
        `/api/projects/${ctx.projectId}/reports/${reportId}`,
      );
      setData(response);
    } catch (error) {
      ctx.toast.error(error);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId, ctx.activeJobs.length]);

  if (!data) {
    return (
      <div className="row muted">
        <span className="spinner" /> Loading report…
      </div>
    );
  }

  const { report, sections, stale } = data;

  return (
    <Card>
      <CardHead
        title={report.title}
        subtitle={`${report.templateKey} · depth ${report.depth} · ${report.audience} · v${report.version}`}
        actions={
          <div className="row" style={{ gap: '0.4rem' }}>
            <StatusBadge status={report.status} />
            {ctx.canEdit ? (
              <>
                <select
                  className="select"
                  style={{ width: 'auto' }}
                  value={report.theme ?? 'slate'}
                  title="Changes the look of the preview and every export"
                  onChange={async (event) => {
                    try {
                      // Only the look changes, so there is nothing to
                      // regenerate — the next export simply renders differently.
                      await api.patch(`/api/projects/${ctx.projectId}/reports/${reportId}`, {
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
                <Button
                  size="small"
                  onClick={async () => {
                    try {
                      await api.post(`/api/projects/${ctx.projectId}/reports/${reportId}/generate`);
                      ctx.toast.show('Regenerating the report…');
                      onChanged();
                    } catch (error) {
                      ctx.toast.error(error);
                    }
                  }}
                >
                  Regenerate
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      <div className="card-body stack loose">
        {stale ? (
          <Alert tone="warn">
            <span>
              <strong>This report is out of date.</strong> The project has changed since it was generated.
              Regenerate to pick up your edits — your hand-edited sections are preserved.
            </span>
          </Alert>
        ) : null}

        {report.status === 'ready' ? (
          <ExportBar ctx={ctx} subjectType="report" subjectId={reportId} formats={['pdf', 'docx', 'html', 'md']} />
        ) : report.status === 'generating' ? (
          <div className="row muted">
            <span className="spinner" /> Writing the report…
          </div>
        ) : report.status === 'failed' ? (
          <Alert tone="danger">Generation failed. Try again, or check the AI provider settings.</Alert>
        ) : null}

        <div
          className="report-body doc-preview"
          style={themeStyle(themes.find((t) => t.key === (report.theme ?? 'slate')))}
        >
          {/* The cover mirrors the title page in the DOCX and PDF exports, so
              the preview is a fair representation rather than a rough guide. */}
          <header className={`doc-cover ${coverStyleFor(report.theme ?? 'slate')}`}>
            <h1 style={{ marginBottom: '0.35rem' }}>{report.title}</h1>
            <div className="small dim">{ctx.project.title}</div>
            <div className="tiny dim">
              {report.generatedAt ? new Date(report.generatedAt).toLocaleDateString() : 'not yet generated'}
            </div>
          </header>
          {sections.map((section) => (
            <section key={section.id}>
              <h2>
                {section.heading}
                {section.editedByUser ? <span className="badge ok" style={{ marginLeft: '0.5rem' }}>edited</span> : null}
              </h2>
              {section.blocks.length === 0 ? (
                <p className="small dim">Nothing recorded for this section.</p>
              ) : (
                section.blocks.map((block, index) => <BlockView key={index} ctx={ctx} block={block} />)
              )}
            </section>
          ))}
        </div>
      </div>
    </Card>
  );
}

function BlockView({ ctx, block }: { ctx: WorkspaceContext; block: ReportBlock }) {
  switch (block.type) {
    case 'paragraph':
      return <p>{block.text}</p>;
    case 'heading':
      return block.level === 2 ? <h3>{block.text}</h3> : <h4>{block.text}</h4>;
    case 'bullets':
      return block.ordered ? (
        <ol>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ol>
      ) : (
        <ul>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
      );
    case 'procedure':
      return (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>
              <strong>{item.text}</strong>
              {item.detail ? <div className="small muted">{item.detail}</div> : null}
            </li>
          ))}
        </ol>
      );
    case 'code':
      return (
        <>
          <pre className="code">
            <code>{block.content}</code>
          </pre>
          {block.caption ? <div className="tiny dim">{block.caption}</div> : null}
        </>
      );
    case 'table':
      return (
        <>
          <table className="data">
            <thead>
              <tr>
                {block.headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {block.caption ? <div className="tiny dim">{block.caption}</div> : null}
        </>
      );
    case 'figure': {
      const evidence = ctx.evidence.find((e) => e.id === block.evidenceId);
      return (
        <figure>
          {evidence?.file ? (
            <img src={`/api/projects/${ctx.projectId}/files/${evidence.file.id}`} alt={block.caption} loading="lazy" />
          ) : (
            <div className="alert warn small">Image unavailable</div>
          )}
          <figcaption>
            Figure {block.number ?? '?'} — {block.caption}
          </figcaption>
        </figure>
      );
    }
    case 'callout': {
      const labels = { note: 'Note', warning: 'Caution', inference: 'Inferred', recommendation: 'Recommendation' };
      return (
        <div className={`callout ${block.variant}`}>
          <span className="lbl">{labels[block.variant]}</span>
          {block.text}
        </div>
      );
    }
    case 'diagram':
      return (
        <figure>
          <pre className="code">
            <code>{block.ascii}</code>
          </pre>
          {block.caption ? <figcaption>{block.caption}</figcaption> : null}
        </figure>
      );
    case 'reference-list':
      return (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>
              {item.label}
              {item.url ? (
                <>
                  {' — '}
                  <a href={item.url} target="_blank" rel="noreferrer noopener">
                    {item.url}
                  </a>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      );
    default:
      return null;
  }
}

function NewReportModal({
  ctx,
  onClose,
  onCreated,
}: {
  ctx: WorkspaceContext;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [templateKey, setTemplateKey] = useState('technical');
  const [title, setTitle] = useState(ctx.project.title);
  const [depth, setDepth] = useState(Math.max(2, ctx.project.elaborationDepth));
  const [tone, setTone] = useState(ctx.project.tone);
  const [audience, setAudience] = useState(ctx.project.audience);
  const [voice, setVoice] = useState(ctx.project.voice);
  const [theme, setTheme] = useState('slate');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get<{ reports: TemplateInfo[] }>('/api/templates')
      .then((response) => setTemplates(response.reports))
      .catch(() => setTemplates([]));
  }, []);

  const selected = templates.find((t) => t.key === templateKey);

  return (
    <Modal
      title="New report"
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
                const created = await api.post<{ report: { id: string } }>(`/api/projects/${ctx.projectId}/reports`, {
                  templateKey,
                  title,
                  depth,
                  tone,
                  audience,
                  voice,
                  theme,
                  generate: true,
                });
                ctx.toast.show('Generating the report…');
                onCreated(created.report.id);
              } catch (error) {
                ctx.toast.error(error);
                setBusy(false);
              }
            }}
          >
            Generate
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
        {selected ? (
          <>
            <p className="small muted">{selected.description}</p>
            <div className="row wrap" style={{ gap: '0.3rem' }}>
              {selected.sections?.map((section) => (
                <span key={section.key} className="badge" title={section.derived ? 'Built from your project records' : 'Written by the AI'}>
                  {section.heading}
                </span>
              ))}
            </div>
          </>
        ) : null}

        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        <ThemePicker kind="report" value={theme} onChange={setTheme} />

        <div className="grid three">
          <Field label="Detail level">
            <select className="select" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              {ctx.session.meta.depths.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value} — {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tone">
            <select className="select" value={tone} onChange={(e) => setTone(e.target.value)}>
              {ctx.session.meta.tones.map((option) => (
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
          <Field label="Voice" hint="Your own account of your own work, unless you say otherwise.">
            <select className="select" value={voice} onChange={(e) => setVoice(e.target.value)}>
              {(ctx.session.meta.voices ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Which cover treatment a theme uses. Kept in step with the server registry:
 * academic is plain, midnight and ember are filled, everything else is banded.
 */
function coverStyleFor(themeKey: string): 'plain' | 'banded' | 'filled' {
  if (themeKey === 'academic') return 'plain';
  if (themeKey === 'midnight' || themeKey === 'ember') return 'filled';
  return 'banded';
}
