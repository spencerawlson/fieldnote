import type { Database } from '../db/index.ts';
import { getExport, updateExport } from '../db/repositories/outputs.ts';
import { resolvePresentation, resolveReport } from './document.ts';
import { validatePresentation, validateReport, type ValidationFinding } from './validate.ts';
import { renderReportDocx } from './docx.ts';
import { renderPresentationPdf, renderReportPdf } from './pdf.ts';
import { renderPresentationPptx } from './pptx.ts';
import {
  renderPresentationHtml,
  renderPresentationMarkdown,
  renderReportHtml,
  renderReportMarkdown,
} from './markdown.ts';
import { buildExportKey, getStorage } from '../files/storage.ts';
import { buildProjectContext } from '../ai/context.ts';
import { AppError } from '../lib/core.ts';

/**
 * Export dispatcher.
 *
 * One path for every format: resolve the document, validate it, render it,
 * store it, record the findings. Validation results are attached to the export
 * row rather than thrown, so the user gets both the file and an honest list of
 * what is imperfect about it.
 */

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

export function contentTypeFor(format: string): string {
  return CONTENT_TYPES[format] ?? 'application/octet-stream';
}

export interface RenderResult {
  exportId: string;
  bytes: number;
  findings: ValidationFinding[];
}

export async function renderExport(
  db: Database,
  exportId: string,
  onProgress: (message: string) => void = () => {},
): Promise<RenderResult> {
  const record = getExport(db, exportId);
  if (!record) throw new AppError(404, 'not_found', 'Export not found');

  updateExport(db, exportId, { status: 'running' });

  try {
    let buffer: Buffer;
    let findings: ValidationFinding[] = [];

    if (record.subjectType === 'report') {
      onProgress('Assembling the report');
      const report = await resolveReport(db, record.subjectId);
      findings = validateReport(report);

      onProgress(`Rendering ${record.format.toUpperCase()}`);
      switch (record.format) {
        case 'pdf':
          buffer = await renderReportPdf(report);
          break;
        case 'docx':
          buffer = await renderReportDocx(report);
          break;
        case 'html':
          buffer = Buffer.from(renderReportHtml(report), 'utf8');
          break;
        case 'md':
          buffer = Buffer.from(renderReportMarkdown(report), 'utf8');
          break;
        default:
          throw new AppError(400, 'unsupported_format', `Reports cannot be exported as ${record.format}`);
      }
    } else if (record.subjectType === 'presentation') {
      onProgress('Assembling the deck');
      const presentation = await resolvePresentation(db, record.subjectId);
      findings = validatePresentation(presentation);

      onProgress(`Rendering ${record.format.toUpperCase()}`);
      switch (record.format) {
        case 'pptx':
          buffer = await renderPresentationPptx(presentation);
          break;
        case 'pdf':
          buffer = await renderPresentationPdf(presentation, { includeNotes: true });
          break;
        case 'html':
          buffer = Buffer.from(renderPresentationHtml(presentation), 'utf8');
          break;
        case 'md':
          buffer = Buffer.from(renderPresentationMarkdown(presentation), 'utf8');
          break;
        default:
          throw new AppError(400, 'unsupported_format', `Presentations cannot be exported as ${record.format}`);
      }
    } else {
      // Whole-project export: the knowledge base itself, for backup or transfer.
      onProgress('Serialising the project');
      const context = buildProjectContext(db, record.subjectId, { evidenceTextChars: 100_000, includeClaims: true });
      buffer = Buffer.from(JSON.stringify(context, null, 2), 'utf8');
    }

    const key = buildExportKey(record.projectId, exportId, record.format);
    await getStorage().writeBuffer(key, buffer);

    updateExport(db, exportId, {
      status: 'ready',
      storageKey: key,
      byteSize: buffer.length,
      validation: findings,
      error: null,
    });

    return { exportId, bytes: buffer.length, findings };
  } catch (error) {
    updateExport(db, exportId, { status: 'failed', error: (error as Error).message });
    throw error;
  }
}

export function exportFileName(
  subjectTitle: string,
  format: string,
  kind: 'report' | 'presentation' | 'project',
): string {
  const base = subjectTitle
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .toLowerCase() || kind;
  return `${base}.${format}`;
}
