import type { Database } from '../index.ts';
import { mapRow, mapRows, buildUpdate } from '../mapper.ts';
import { newId, nowIso } from '../../lib/core.ts';
import type { Confidence, ReportBlock, SlideBody } from '../../domain/types.ts';

// --- reports --------------------------------------------------------------

export interface ReportRecord {
  id: string;
  projectId: string;
  templateKey: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  tone: string;
  audience: string;
  voice: string;
  depth: number;
  theme: string;
  status: 'draft' | 'generating' | 'ready' | 'failed';
  version: number;
  sourceHash: string | null;
  generatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportSectionRecord {
  id: string;
  reportId: string;
  parentId: string | null;
  key: string;
  heading: string;
  position: number;
  blocks: ReportBlock[];
  claimIds: string[];
  editedByUser: boolean;
  createdAt: string;
  updatedAt: string;
}

const SECTION_SPEC = { json: { blocks: [] as ReportBlock[], claimIds: [] as string[] }, bool: ['edited_by_user'] };

export function createReport(
  db: Database,
  input: {
    projectId: string;
    templateKey: string;
    title: string;
    subtitle?: string | null;
    author?: string | null;
    tone?: string;
    audience?: string;
    voice?: string;
    depth?: number;
    theme?: string;
  },
): ReportRecord {
  const id = newId('report');
  const now = nowIso();
  db.run(
    `INSERT INTO reports (id, project_id, template_key, title, subtitle, author, tone, audience, voice,
       depth, theme, status, version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    input.templateKey,
    input.title,
    input.subtitle ?? null,
    input.author ?? null,
    input.tone ?? 'technical',
    input.audience ?? 'technical-team',
    input.voice ?? 'first-person',
    input.depth ?? 3,
    input.theme ?? 'slate',
    'draft',
    1,
    now,
    now,
  );
  return getReport(db, id)!;
}

export function getReport(db: Database, id: string): ReportRecord | undefined {
  return mapRow<ReportRecord>(db.get('SELECT * FROM reports WHERE id = ? AND deleted_at IS NULL', id));
}

export function listReports(db: Database, projectId: string): ReportRecord[] {
  return mapRows<ReportRecord>(
    db.all(
      'SELECT * FROM reports WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC',
      projectId,
    ),
  );
}

export function updateReport(db: Database, id: string, patch: Record<string, unknown>): ReportRecord | undefined {
  const { sql, params } = buildUpdate(patch, {
    title: 'title',
    subtitle: 'subtitle',
    author: 'author',
    tone: 'tone',
    audience: 'audience',
    voice: 'voice',
    depth: 'depth',
    theme: 'theme',
    templateKey: 'template_key',
    status: 'status',
    version: 'version',
    sourceHash: 'source_hash',
    generatedAt: 'generated_at',
  });
  if (sql) db.run(`UPDATE reports SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return getReport(db, id);
}

export function deleteReport(db: Database, id: string): void {
  db.run('UPDATE reports SET deleted_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
}

export function replaceSections(
  db: Database,
  reportId: string,
  sections: { key: string; heading: string; blocks: ReportBlock[]; claimIds?: string[] }[],
): ReportSectionRecord[] {
  return db.tx(() => {
    const edited = db.all<{ key: string; blocks_json: string; heading: string }>(
      'SELECT key, blocks_json, heading FROM report_sections WHERE report_id = ? AND edited_by_user = 1',
      reportId,
    );
    const editedByKey = new Map(edited.map((r) => [r.key, r]));
    db.run('DELETE FROM report_sections WHERE report_id = ?', reportId);
    const now = nowIso();
    const out: ReportSectionRecord[] = [];
    sections.forEach((section, index) => {
      const id = newId('section');
      const preserved = editedByKey.get(section.key);
      db.run(
        `INSERT INTO report_sections (id, report_id, parent_id, key, heading, position, blocks_json, claim_ids_json, edited_by_user, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        reportId,
        null,
        section.key,
        preserved?.heading ?? section.heading,
        index,
        preserved?.blocks_json ?? JSON.stringify(section.blocks),
        JSON.stringify(section.claimIds ?? []),
        preserved ? 1 : 0,
        now,
        now,
      );
      out.push(mapRow<ReportSectionRecord>(db.get('SELECT * FROM report_sections WHERE id = ?', id), SECTION_SPEC)!);
    });
    return out;
  });
}

export function listSections(db: Database, reportId: string): ReportSectionRecord[] {
  return mapRows<ReportSectionRecord>(
    db.all('SELECT * FROM report_sections WHERE report_id = ? ORDER BY position', reportId),
    SECTION_SPEC,
  );
}

export function getSection(db: Database, id: string): ReportSectionRecord | undefined {
  return mapRow<ReportSectionRecord>(db.get('SELECT * FROM report_sections WHERE id = ?', id), SECTION_SPEC);
}

export function updateSection(db: Database, id: string, patch: Record<string, unknown>) {
  const { sql, params } = buildUpdate(patch, {
    heading: 'heading',
    blocks: 'blocks_json',
    position: 'position',
    editedByUser: 'edited_by_user',
  });
  if (sql) db.run(`UPDATE report_sections SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return getSection(db, id);
}

// --- presentations --------------------------------------------------------

export interface PresentationRecord {
  id: string;
  projectId: string;
  templateKey: string;
  title: string;
  subtitle: string | null;
  presenter: string | null;
  audience: string;
  tone: string;
  voice: string;
  slideTarget: number;
  theme: string;
  status: 'draft' | 'generating' | 'ready' | 'failed';
  version: number;
  sourceHash: string | null;
  generatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlideRecord {
  id: string;
  presentationId: string;
  position: number;
  layout: string;
  title: string;
  subtitle: string | null;
  bullets: string[];
  body: SlideBody;
  evidenceIds: string[];
  speakerNotes: string;
  claimIds: string[];
  editedByUser: boolean;
  createdAt: string;
  updatedAt: string;
}

const SLIDE_SPEC = {
  json: { bullets: [] as string[], body: {} as SlideBody, evidenceIds: [] as string[], claimIds: [] as string[] },
  bool: ['edited_by_user'],
};

export function createPresentation(
  db: Database,
  input: {
    projectId: string;
    templateKey: string;
    title: string;
    subtitle?: string | null;
    presenter?: string | null;
    audience?: string;
    tone?: string;
    voice?: string;
    slideTarget?: number;
    theme?: string;
  },
): PresentationRecord {
  const id = newId('presentation');
  const now = nowIso();
  db.run(
    `INSERT INTO presentations (id, project_id, template_key, title, subtitle, presenter, audience, tone,
       voice, slide_target, theme, status, version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    input.templateKey,
    input.title,
    input.subtitle ?? null,
    input.presenter ?? null,
    input.audience ?? 'technical-team',
    input.tone ?? 'technical',
    input.voice ?? 'first-person',
    input.slideTarget ?? 12,
    input.theme ?? 'slate',
    'draft',
    1,
    now,
    now,
  );
  return getPresentation(db, id)!;
}

export function getPresentation(db: Database, id: string): PresentationRecord | undefined {
  return mapRow<PresentationRecord>(db.get('SELECT * FROM presentations WHERE id = ? AND deleted_at IS NULL', id));
}

export function listPresentations(db: Database, projectId: string): PresentationRecord[] {
  return mapRows<PresentationRecord>(
    db.all(
      'SELECT * FROM presentations WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC',
      projectId,
    ),
  );
}

export function updatePresentation(db: Database, id: string, patch: Record<string, unknown>) {
  const { sql, params } = buildUpdate(patch, {
    title: 'title',
    subtitle: 'subtitle',
    presenter: 'presenter',
    audience: 'audience',
    tone: 'tone',
    voice: 'voice',
    slideTarget: 'slide_target',
    theme: 'theme',
    templateKey: 'template_key',
    status: 'status',
    version: 'version',
    sourceHash: 'source_hash',
    generatedAt: 'generated_at',
  });
  if (sql) db.run(`UPDATE presentations SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return getPresentation(db, id);
}

export function deletePresentation(db: Database, id: string): void {
  db.run('UPDATE presentations SET deleted_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
}

export function replaceSlides(
  db: Database,
  presentationId: string,
  slides: Omit<SlideRecord, 'id' | 'presentationId' | 'position' | 'editedByUser' | 'createdAt' | 'updatedAt'>[],
): SlideRecord[] {
  return db.tx(() => {
    db.run('DELETE FROM slides WHERE presentation_id = ? AND edited_by_user = 0', presentationId);

    // Hand-edited slides survive regeneration; the new deck is appended after
    // them rather than replacing them. Survivors are renumbered from zero
    // first, because their original positions were interleaved with the slides
    // just deleted and would otherwise collide with the incoming ones.
    const kept = db.all<{ id: string }>(
      'SELECT id FROM slides WHERE presentation_id = ? ORDER BY position',
      presentationId,
    );
    kept.forEach((slide, index) => {
      db.run('UPDATE slides SET position = ? WHERE id = ?', index, slide.id);
    });
    const offset = kept.length;
    const now = nowIso();
    const out: SlideRecord[] = [];
    slides.forEach((slide, index) => {
      const id = newId('slide');
      db.run(
        `INSERT INTO slides (id, presentation_id, position, layout, title, subtitle, bullets_json, body_json,
           evidence_ids_json, speaker_notes, claim_ids_json, edited_by_user, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
        id,
        presentationId,
        offset + index,
        slide.layout,
        slide.title,
        slide.subtitle ?? null,
        JSON.stringify(slide.bullets ?? []),
        JSON.stringify(slide.body ?? {}),
        JSON.stringify(slide.evidenceIds ?? []),
        slide.speakerNotes ?? '',
        JSON.stringify(slide.claimIds ?? []),
        now,
        now,
      );
      out.push(mapRow<SlideRecord>(db.get('SELECT * FROM slides WHERE id = ?', id), SLIDE_SPEC)!);
    });
    return out;
  });
}

export function listSlides(db: Database, presentationId: string): SlideRecord[] {
  return mapRows<SlideRecord>(
    db.all('SELECT * FROM slides WHERE presentation_id = ? ORDER BY position', presentationId),
    SLIDE_SPEC,
  );
}

export function getSlide(db: Database, id: string): SlideRecord | undefined {
  return mapRow<SlideRecord>(db.get('SELECT * FROM slides WHERE id = ?', id), SLIDE_SPEC);
}

export function updateSlide(db: Database, id: string, patch: Record<string, unknown>) {
  const { sql, params } = buildUpdate(patch, {
    layout: 'layout',
    title: 'title',
    subtitle: 'subtitle',
    bullets: 'bullets_json',
    body: 'body_json',
    evidenceIds: 'evidence_ids_json',
    speakerNotes: 'speaker_notes',
    position: 'position',
    editedByUser: 'edited_by_user',
  });
  if (sql) db.run(`UPDATE slides SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return getSlide(db, id);
}

export function deleteSlide(db: Database, id: string): void {
  db.run('DELETE FROM slides WHERE id = ?', id);
}

export function reorderSlides(db: Database, presentationId: string, orderedIds: string[]): void {
  db.tx(() => {
    orderedIds.forEach((id, index) => {
      db.run('UPDATE slides SET position = ?, updated_at = ? WHERE id = ? AND presentation_id = ?', index, nowIso(), id, presentationId);
    });
  });
}

// --- Q&A ------------------------------------------------------------------

export interface QuestionRecord {
  id: string;
  projectId: string;
  presentationId: string | null;
  category: string;
  level: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  text: string;
  difficulty: number;
  position: number;
  editedByUser: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerRecord {
  id: string;
  questionId: string;
  text: string;
  grounding: { type: string; id: string }[];
  generalKnowledge: string | null;
  confidence: Confidence;
  editedByUser: boolean;
  createdAt: string;
  updatedAt: string;
}

const ANSWER_SPEC = { json: { grounding: [] as { type: string; id: string }[] }, bool: ['edited_by_user'] };

export function replaceQuestions(
  db: Database,
  projectId: string,
  presentationId: string | null,
  items: {
    category: string;
    level: string;
    text: string;
    difficulty?: number;
    answer: { text: string; grounding?: { type: string; id: string }[]; generalKnowledge?: string | null; confidence?: Confidence };
  }[],
): { question: QuestionRecord; answer: AnswerRecord }[] {
  return db.tx(() => {
    db.run('DELETE FROM questions WHERE project_id = ? AND edited_by_user = 0', projectId);
    const now = nowIso();
    const startPos =
      (db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM questions WHERE project_id = ?', projectId)?.m ?? -1) + 1;
    const out: { question: QuestionRecord; answer: AnswerRecord }[] = [];
    items.forEach((item, index) => {
      const qid = newId('question');
      db.run(
        `INSERT INTO questions (id, project_id, presentation_id, category, level, text, difficulty, position, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        qid,
        projectId,
        presentationId,
        item.category,
        item.level,
        item.text,
        item.difficulty ?? 2,
        startPos + index,
        now,
        now,
      );
      const aid = newId('answer');
      db.run(
        `INSERT INTO answers (id, question_id, text, grounding_json, general_knowledge, confidence, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        aid,
        qid,
        item.answer.text,
        JSON.stringify(item.answer.grounding ?? []),
        item.answer.generalKnowledge ?? null,
        item.answer.confidence ?? 'medium',
        now,
        now,
      );
      out.push({
        question: mapRow<QuestionRecord>(db.get('SELECT * FROM questions WHERE id = ?', qid), { bool: ['edited_by_user'] })!,
        answer: mapRow<AnswerRecord>(db.get('SELECT * FROM answers WHERE id = ?', aid), ANSWER_SPEC)!,
      });
    });
    return out;
  });
}

export function listQuestions(db: Database, projectId: string): { question: QuestionRecord; answer: AnswerRecord | undefined }[] {
  const questions = mapRows<QuestionRecord>(
    db.all('SELECT * FROM questions WHERE project_id = ? ORDER BY position', projectId),
    { bool: ['edited_by_user'] },
  );
  return questions.map((question) => ({
    question,
    answer: mapRow<AnswerRecord>(
      db.get('SELECT * FROM answers WHERE question_id = ? ORDER BY created_at DESC LIMIT 1', question.id),
      ANSWER_SPEC,
    ),
  }));
}

export function updateQuestion(db: Database, id: string, patch: Record<string, unknown>) {
  const { sql, params } = buildUpdate(patch, {
    text: 'text',
    category: 'category',
    level: 'level',
    difficulty: 'difficulty',
    position: 'position',
    editedByUser: 'edited_by_user',
  });
  if (sql) db.run(`UPDATE questions SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return mapRow<QuestionRecord>(db.get('SELECT * FROM questions WHERE id = ?', id), { bool: ['edited_by_user'] });
}

export function updateAnswer(db: Database, id: string, patch: Record<string, unknown>) {
  const { sql, params } = buildUpdate(patch, {
    text: 'text',
    generalKnowledge: 'general_knowledge',
    confidence: 'confidence',
    editedByUser: 'edited_by_user',
  });
  if (sql) db.run(`UPDATE answers SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return mapRow<AnswerRecord>(db.get('SELECT * FROM answers WHERE id = ?', id), ANSWER_SPEC);
}

export function deleteQuestion(db: Database, id: string): void {
  db.run('DELETE FROM questions WHERE id = ?', id);
}

// --- exports --------------------------------------------------------------

export interface ExportRecord {
  id: string;
  projectId: string;
  subjectType: 'report' | 'presentation' | 'project';
  subjectId: string;
  format: string;
  storageKey: string | null;
  byteSize: number | null;
  status: 'pending' | 'running' | 'ready' | 'failed';
  validation: { level: string; message: string }[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const EXPORT_SPEC = { json: { validation: [] as { level: string; message: string }[] } };

export function createExport(
  db: Database,
  input: { projectId: string; subjectType: string; subjectId: string; format: string },
): ExportRecord {
  const id = newId('export');
  const now = nowIso();
  db.run(
    `INSERT INTO exports (id, project_id, subject_type, subject_id, format, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    input.subjectType,
    input.subjectId,
    input.format,
    'pending',
    now,
    now,
  );
  return getExport(db, id)!;
}

export function getExport(db: Database, id: string): ExportRecord | undefined {
  return mapRow<ExportRecord>(db.get('SELECT * FROM exports WHERE id = ?', id), EXPORT_SPEC);
}

export function updateExport(db: Database, id: string, patch: Record<string, unknown>) {
  const { sql, params } = buildUpdate(patch, {
    storageKey: 'storage_key',
    byteSize: 'byte_size',
    status: 'status',
    validation: 'validation_json',
    error: 'error',
  });
  if (sql) db.run(`UPDATE exports SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return getExport(db, id);
}

export function listExports(db: Database, subjectType: string, subjectId: string): ExportRecord[] {
  return mapRows<ExportRecord>(
    db.all(
      'SELECT * FROM exports WHERE subject_type = ? AND subject_id = ? ORDER BY created_at DESC LIMIT 50',
      subjectType,
      subjectId,
    ),
    EXPORT_SPEC,
  );
}
