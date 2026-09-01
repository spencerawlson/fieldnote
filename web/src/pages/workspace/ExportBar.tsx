import { useEffect, useState } from 'react';
import { api } from '../../lib/api.ts';
import { Alert, Button } from '../../components/ui.tsx';
import type { WorkspaceContext } from './ProjectWorkspace.tsx';

/** What the desktop shell reports back once a download has been written. */
interface DownloadFinished {
  success: boolean;
  path: string | null;
  name: string;
}

/** The slice of the Tauri global this file uses; absent in a browser. */
interface TauriGlobal {
  event?: {
    listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
  };
}

interface ExportRecord {
  id: string;
  format: string;
  status: 'pending' | 'running' | 'ready' | 'failed';
  byteSize: number | null;
  /** Present on a fetched record; the name the download will be saved under. */
  fileName?: string;
  error: string | null;
  validation: { level: string; code: string; message: string }[];
}

/**
 * Export controls.
 *
 * Nothing here fabricates a download link: the button only becomes a download
 * once the server reports the file is rendered and stored. Validation findings
 * are shown next to it rather than hidden.
 *
 * The format a given output is normally wanted in gets the primary button;
 * the rest sit behind "Other formats". A deck is a PowerPoint file; a report is
 * a Word file or a PDF.
 */
const PRIMARY: Record<string, string[]> = {
  report: ['docx', 'pdf'],
  presentation: ['pptx'],
};

const FORMAT_LABELS: Record<string, string> = {
  docx: 'Word (.docx)',
  pdf: 'PDF',
  pptx: 'PowerPoint (.pptx)',
  html: 'HTML',
  md: 'Markdown',
};

export function ExportBar({
  ctx,
  subjectType,
  subjectId,
  formats,
}: {
  ctx: WorkspaceContext;
  subjectType: 'report' | 'presentation';
  subjectId: string;
  formats: string[];
}) {
  const [showAll, setShowAll] = useState(false);
  const primary = formats.filter((format) => PRIMARY[subjectType]?.includes(format));
  const secondary = formats.filter((format) => !primary.includes(format));
  const [busy, setBusy] = useState<string | null>(null);
  const [record, setRecord] = useState<ExportRecord | null>(null);

  // In the desktop build the shell handles the download itself and reports
  // back; in a browser these events never fire and the browser's own download
  // UI does the telling.
  useEffect(() => {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    if (!tauri?.event?.listen) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void tauri.event
      .listen<DownloadFinished>('export-download-finished', ({ payload }) => {
        if (payload.success) {
          ctx.toast.show(payload.path ? `Saved to ${payload.path}` : `Saved ${payload.name}`, 'ok');
        } else {
          ctx.toast.show(`${payload.name} could not be saved`, 'danger');
        }
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [ctx.toast]);

  const run = async (format: string) => {
    setBusy(format);
    setRecord(null);
    try {
      const requested = await api.post<{ export: ExportRecord }>(`/api/projects/${ctx.projectId}/exports`, {
        subjectType,
        subjectId,
        format,
      });

      // Poll until the render job finishes; exports take a second or two.
      const exportId = requested.export.id;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const current = await api.get<{ export: ExportRecord }>(`/api/projects/${ctx.projectId}/exports/${exportId}`);
        if (current.export.status === 'ready') {
          setRecord(current.export);
          // The filename travels in the URL as well as in Content-Disposition:
          // the desktop shell handles the download itself and only sees the
          // URL, so this is how the saved file gets a real name.
          const name = current.export.fileName ?? `${subjectType}.${format}`;
          window.location.href =
            `/api/projects/${ctx.projectId}/exports/${exportId}/download/${encodeURIComponent(name)}`;
          ctx.toast.show(`Saving ${name}…`, 'info');
          return;
        }
        if (current.export.status === 'failed') {
          setRecord(current.export);
          ctx.toast.show(`Export failed: ${current.export.error ?? 'unknown error'}`, 'danger');
          return;
        }
      }
      ctx.toast.show('The export is taking longer than expected. Check back shortly.', 'info');
    } catch (error) {
      ctx.toast.error(error);
    } finally {
      setBusy(null);
    }
  };

  const errors = record?.validation.filter((finding) => finding.level === 'error') ?? [];
  const warnings = record?.validation.filter((finding) => finding.level === 'warning') ?? [];

  return (
    <div className="stack tight">
      <div className="export-primary">
        <span className="label" style={{ marginRight: '0.25rem' }}>Save as</span>
        {primary.map((format) => (
          <Button
            key={format}
            size="small"
            variant="primary"
            loading={busy === format}
            onClick={() => void run(format)}
          >
            {FORMAT_LABELS[format] ?? format.toUpperCase()}
          </Button>
        ))}
        {secondary.length > 0 ? (
          <Button size="small" variant="ghost" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Fewer formats' : 'Other formats'}
          </Button>
        ) : null}
        {record?.status === 'ready' ? (
          <span className="tiny dim">{Math.round((record.byteSize ?? 0) / 1024)} KB · downloaded</span>
        ) : null}
      </div>

      {showAll ? (
        <div className="export-secondary">
          {secondary.map((format) => (
            <Button key={format} size="small" loading={busy === format} onClick={() => void run(format)}>
              {FORMAT_LABELS[format] ?? format.toUpperCase()}
            </Button>
          ))}
        </div>
      ) : null}

      {errors.length > 0 ? (
        <Alert tone="danger">
          <span>
            <strong>The file was produced, but with problems:</strong>
            <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.1rem' }}>
              {errors.map((finding, index) => (
                <li key={index}>{finding.message}</li>
              ))}
            </ul>
          </span>
        </Alert>
      ) : null}

      {warnings.length > 0 ? (
        <details>
          <summary className="tiny dim" style={{ cursor: 'pointer' }}>
            {warnings.length} formatting warning{warnings.length === 1 ? '' : 's'}
          </summary>
          <ul className="tiny muted" style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
            {warnings.map((finding, index) => (
              <li key={index}>{finding.message}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
