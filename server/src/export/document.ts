import type { Database } from '../db/index.ts';
import { getProject } from '../db/repositories/projects.ts';
import { getEvidence, getFile, listEvidence } from '../db/repositories/evidence.ts';
import { getReport, listSections, getPresentation, listSlides } from '../db/repositories/outputs.ts';
import { getUser } from '../db/repositories/system.ts';
import { readFileBytes } from '../files/storage.ts';
import type { ReportBlock, SlideBody } from '../domain/types.ts';
import { logger } from '../lib/logger.ts';

/**
 * Export assembly.
 *
 * Renderers receive a fully resolved document: every figure already carries its
 * image bytes, every caption is final, and every reference is checked. That
 * keeps DOCX/PDF/HTML/Markdown output identical in substance and lets export
 * validation run once, before any format-specific code.
 */

export interface ResolvedFigure {
  evidenceId: string;
  number: number;
  caption: string;
  bytes: Buffer | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  missingReason?: string;
}

export interface ResolvedSection {
  key: string;
  heading: string;
  blocks: ReportBlock[];
}

export interface ResolvedReport {
  kind: 'report';
  id: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  projectTitle: string;
  templateKey: string;
  theme: string;
  generatedAt: string;
  sections: ResolvedSection[];
  figures: Map<string, ResolvedFigure>;
  meta: { tone: string; audience: string; depth: number; version: number };
}

export interface ResolvedSlide {
  id: string;
  position: number;
  layout: string;
  title: string;
  subtitle: string | null;
  bullets: string[];
  body: SlideBody;
  speakerNotes: string;
  figures: ResolvedFigure[];
}

export interface ResolvedPresentation {
  kind: 'presentation';
  id: string;
  title: string;
  subtitle: string | null;
  presenter: string | null;
  projectTitle: string;
  generatedAt: string;
  theme: string;
  slides: ResolvedSlide[];
}

async function loadFigure(
  db: Database,
  evidenceId: string,
  number: number,
  fallbackCaption: string,
): Promise<ResolvedFigure> {
  const evidence = getEvidence(db, evidenceId);
  if (!evidence) {
    return { evidenceId, number, caption: fallbackCaption, bytes: null, mimeType: null, width: null, height: null, missingReason: 'Evidence record no longer exists' };
  }
  const caption = evidence.caption || evidence.title || fallbackCaption;
  if (!evidence.fileId) {
    return { evidenceId, number, caption, bytes: null, mimeType: null, width: null, height: null, missingReason: 'Evidence has no attached file' };
  }
  const file = getFile(db, evidence.fileId);
  if (!file) {
    return { evidenceId, number, caption, bytes: null, mimeType: null, width: null, height: null, missingReason: 'Stored file is missing' };
  }
  try {
    const bytes = await readFileBytes(file.storageKey);
    return {
      evidenceId,
      number,
      caption,
      bytes,
      mimeType: file.mimeType,
      width: file.width,
      height: file.height,
    };
  } catch (error) {
    logger.warn({ evidenceId, error: (error as Error).message }, 'Could not read evidence bytes for export');
    return { evidenceId, number, caption, bytes: null, mimeType: null, width: null, height: null, missingReason: 'File could not be read from storage' };
  }
}

export async function resolveReport(db: Database, reportId: string): Promise<ResolvedReport> {
  const report = getReport(db, reportId);
  if (!report) throw new Error('Report not found');
  const project = getProject(db, report.projectId);
  if (!project) throw new Error('Project not found');
  const sections = listSections(db, reportId);
  const author = report.author ?? getUser(db, project.ownerId)?.name ?? null;

  const figures = new Map<string, ResolvedFigure>();
  let figureNumber = 0;
  for (const section of sections) {
    for (const block of section.blocks) {
      if (block.type !== 'figure') continue;
      figureNumber += 1;
      const resolved = await loadFigure(db, block.evidenceId, figureNumber, block.caption);
      // Renumber sequentially in final document order.
      block.number = figureNumber;
      block.caption = resolved.caption;
      figures.set(block.evidenceId, resolved);
    }
  }

  return {
    kind: 'report',
    id: report.id,
    title: report.title,
    subtitle: report.subtitle,
    author,
    projectTitle: project.title,
    templateKey: report.templateKey,
    theme: report.theme,
    generatedAt: report.generatedAt ?? report.updatedAt,
    sections: sections.map((s) => ({ key: s.key, heading: s.heading, blocks: s.blocks })),
    figures,
    meta: { tone: report.tone, audience: report.audience, depth: report.depth, version: report.version },
  };
}

export async function resolvePresentation(db: Database, presentationId: string): Promise<ResolvedPresentation> {
  const presentation = getPresentation(db, presentationId);
  if (!presentation) throw new Error('Presentation not found');
  const project = getProject(db, presentation.projectId);
  if (!project) throw new Error('Project not found');
  const slides = listSlides(db, presentationId);
  const presenter = presentation.presenter ?? getUser(db, project.ownerId)?.name ?? null;

  const resolved: ResolvedSlide[] = [];
  let figureNumber = 0;
  for (const slide of slides) {
    const figures: ResolvedFigure[] = [];
    for (const evidenceId of slide.evidenceIds) {
      figureNumber += 1;
      figures.push(await loadFigure(db, evidenceId, figureNumber, slide.title));
    }
    resolved.push({
      id: slide.id,
      position: slide.position,
      layout: slide.layout,
      title: slide.title,
      subtitle: slide.subtitle,
      bullets: slide.bullets,
      body: slide.body,
      speakerNotes: slide.speakerNotes,
      figures,
    });
  }

  return {
    kind: 'presentation',
    id: presentation.id,
    title: presentation.title,
    subtitle: presentation.subtitle,
    presenter,
    projectTitle: project.title,
    generatedAt: presentation.generatedAt ?? presentation.updatedAt,
    theme: presentation.theme,
    slides: resolved,
  };
}

/** Evidence that exists in the project but is cited nowhere in the document. */
export function unusedEvidence(db: Database, projectId: string, usedIds: Set<string>): string[] {
  return listEvidence(db, projectId)
    .filter((e) => e.reviewState !== 'rejected' && !usedIds.has(e.id))
    .map((e) => e.title || e.id);
}
