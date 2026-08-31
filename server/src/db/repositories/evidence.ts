import type { Database } from '../index.ts';
import { mapRow, mapRows, buildUpdate } from '../mapper.ts';
import { newId, nowIso } from '../../lib/core.ts';
import type { Confidence, EvidenceLink, EvidenceRecord } from '../../domain/types.ts';

const EVIDENCE_SPEC = { bool: ['sensitive'] };

export interface FileRecord {
  id: string;
  projectId: string;
  uploaderId: string;
  storageKey: string;
  thumbKey: string | null;
  originalName: string;
  mimeType: string;
  byteSize: number;
  checksum: string;
  width: number | null;
  height: number | null;
  scanState: string;
  createdAt: string;
}

export function createFile(
  db: Database,
  input: Omit<FileRecord, 'id' | 'createdAt' | 'scanState'> & { scanState?: string },
): FileRecord {
  const id = newId('file');
  db.run(
    `INSERT INTO files (id, project_id, uploader_id, storage_key, thumb_key, original_name,
       mime_type, byte_size, checksum, width, height, scan_state, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    input.uploaderId,
    input.storageKey,
    input.thumbKey ?? null,
    input.originalName,
    input.mimeType,
    input.byteSize,
    input.checksum,
    input.width ?? null,
    input.height ?? null,
    input.scanState ?? 'clean',
    nowIso(),
  );
  return getFile(db, id)!;
}

export function getFile(db: Database, id: string): FileRecord | undefined {
  return mapRow<FileRecord>(db.get('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', id));
}

export function findFileByChecksum(db: Database, projectId: string, checksum: string): FileRecord | undefined {
  return mapRow<FileRecord>(
    db.get(
      'SELECT * FROM files WHERE project_id = ? AND checksum = ? AND deleted_at IS NULL LIMIT 1',
      projectId,
      checksum,
    ),
  );
}

export function countFiles(db: Database, projectId: string): number {
  const row = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM files WHERE project_id = ? AND deleted_at IS NULL',
    projectId,
  );
  return row?.n ?? 0;
}

export function softDeleteFile(db: Database, id: string): void {
  db.run('UPDATE files SET deleted_at = ? WHERE id = ?', nowIso(), id);
}

// --- evidence -------------------------------------------------------------

export function nextEvidencePosition(db: Database, projectId: string): number {
  const row = db.get<{ maxPos: number | null }>(
    'SELECT MAX(position) AS maxPos FROM evidence WHERE project_id = ? AND deleted_at IS NULL',
    projectId,
  );
  return (row?.maxPos ?? 0) + 1;
}

export function createEvidence(
  db: Database,
  input: {
    projectId: string;
    fileId?: string | null;
    kind?: string;
    title?: string;
    description?: string | null;
    caption?: string | null;
    source?: string | null;
    capturedAt?: string | null;
    position?: number;
  },
): EvidenceRecord {
  const id = newId('evidence');
  const now = nowIso();
  db.run(
    `INSERT INTO evidence (id, project_id, file_id, kind, title, description, caption, source,
       captured_at, review_state, position, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    input.fileId ?? null,
    input.kind ?? 'screenshot',
    input.title ?? '',
    input.description ?? null,
    input.caption ?? null,
    input.source ?? null,
    input.capturedAt ?? null,
    'unreviewed',
    input.position ?? nextEvidencePosition(db, input.projectId),
    now,
    now,
  );
  return getEvidence(db, id)!;
}

export function getEvidence(db: Database, id: string): EvidenceRecord | undefined {
  return mapRow<EvidenceRecord>(
    db.get('SELECT * FROM evidence WHERE id = ? AND deleted_at IS NULL', id),
    EVIDENCE_SPEC,
  );
}

export function listEvidence(db: Database, projectId: string): EvidenceRecord[] {
  return mapRows<EvidenceRecord>(
    db.all(
      'SELECT * FROM evidence WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, created_at',
      projectId,
    ),
    EVIDENCE_SPEC,
  );
}

export function updateEvidence(db: Database, id: string, patch: Record<string, unknown>): EvidenceRecord | undefined {
  const { sql, params } = buildUpdate(patch, {
    fileId: 'file_id',
    kind: 'kind',
    title: 'title',
    description: 'description',
    caption: 'caption',
    source: 'source',
    capturedAt: 'captured_at',
    reviewState: 'review_state',
    confidence: 'confidence',
    sensitive: 'sensitive',
    position: 'position',
  });
  if (sql) db.run(`UPDATE evidence SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return getEvidence(db, id);
}

export function deleteEvidence(db: Database, id: string): void {
  db.run('UPDATE evidence SET deleted_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
}

// --- evidence chain -------------------------------------------------------

export function linkEvidence(
  db: Database,
  input: {
    projectId: string;
    evidenceId: string;
    targetType: string;
    targetId: string;
    role?: string;
    origin?: 'user' | 'ai';
    confidence?: Confidence | null;
    note?: string | null;
  },
): EvidenceLink | undefined {
  const id = newId('evidenceLink');
  db.run(
    `INSERT INTO evidence_links (id, project_id, evidence_id, target_type, target_id, role, origin, confidence, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(evidence_id, target_type, target_id, role) DO UPDATE SET
       origin = excluded.origin, confidence = excluded.confidence, note = excluded.note`,
    id,
    input.projectId,
    input.evidenceId,
    input.targetType,
    input.targetId,
    input.role ?? 'supports',
    input.origin ?? 'user',
    input.confidence ?? null,
    input.note ?? null,
    nowIso(),
  );
  return mapRow<EvidenceLink>(
    db.get(
      'SELECT * FROM evidence_links WHERE evidence_id = ? AND target_type = ? AND target_id = ? AND role = ?',
      input.evidenceId,
      input.targetType,
      input.targetId,
      input.role ?? 'supports',
    ),
  );
}

export function unlinkEvidence(db: Database, linkId: string): void {
  db.run('DELETE FROM evidence_links WHERE id = ?', linkId);
}

export function listEvidenceLinks(db: Database, projectId: string): EvidenceLink[] {
  return mapRows<EvidenceLink>(
    db.all('SELECT * FROM evidence_links WHERE project_id = ? ORDER BY created_at', projectId),
  );
}

export function listLinksForTarget(db: Database, targetType: string, targetId: string): EvidenceLink[] {
  return mapRows<EvidenceLink>(
    db.all(
      'SELECT * FROM evidence_links WHERE target_type = ? AND target_id = ? ORDER BY created_at',
      targetType,
      targetId,
    ),
  );
}

export function listLinksForEvidence(db: Database, evidenceId: string): EvidenceLink[] {
  return mapRows<EvidenceLink>(
    db.all('SELECT * FROM evidence_links WHERE evidence_id = ? ORDER BY created_at', evidenceId),
  );
}

// --- analyses -------------------------------------------------------------

export interface ImageAnalysisRecord {
  id: string;
  evidenceId: string;
  provider: string;
  model: string;
  description: string;
  detectedApp: string | null;
  detectedOs: string | null;
  observations: { text: string; confidence: Confidence }[];
  entities: Record<string, string[]>;
  suggested: Record<string, unknown>;
  confidence: Confidence;
  superseded: boolean;
  createdAt: string;
}

const ANALYSIS_SPEC = {
  json: { observations: [], entities: {}, suggested: {} },
  bool: ['superseded'],
};

export function saveImageAnalysis(
  db: Database,
  input: Omit<ImageAnalysisRecord, 'id' | 'createdAt' | 'superseded'>,
): ImageAnalysisRecord {
  const id = newId('imageAnalysis');
  db.tx(() => {
    db.run('UPDATE image_analyses SET superseded = 1 WHERE evidence_id = ?', input.evidenceId);
    db.run(
      `INSERT INTO image_analyses (id, evidence_id, provider, model, description, detected_app, detected_os,
         observations_json, entities_json, suggested_json, confidence, superseded, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      id,
      input.evidenceId,
      input.provider,
      input.model,
      input.description,
      input.detectedApp ?? null,
      input.detectedOs ?? null,
      JSON.stringify(input.observations ?? []),
      JSON.stringify(input.entities ?? {}),
      JSON.stringify(input.suggested ?? {}),
      input.confidence,
      nowIso(),
    );
  });
  return mapRow<ImageAnalysisRecord>(db.get('SELECT * FROM image_analyses WHERE id = ?', id), ANALYSIS_SPEC)!;
}

export function getLatestImageAnalysis(db: Database, evidenceId: string): ImageAnalysisRecord | undefined {
  return mapRow<ImageAnalysisRecord>(
    db.get(
      'SELECT * FROM image_analyses WHERE evidence_id = ? AND superseded = 0 ORDER BY created_at DESC LIMIT 1',
      evidenceId,
    ),
    ANALYSIS_SPEC,
  );
}

export interface OcrRecord {
  id: string;
  evidenceId: string;
  engine: string;
  text: string;
  redactedText: string | null;
  confidence: number | null;
  superseded: boolean;
  createdAt: string;
}

export function saveOcr(
  db: Database,
  input: { evidenceId: string; engine: string; text: string; redactedText?: string | null; confidence?: number | null },
): OcrRecord {
  const id = newId('ocr');
  db.tx(() => {
    db.run('UPDATE ocr_results SET superseded = 1 WHERE evidence_id = ?', input.evidenceId);
    db.run(
      `INSERT INTO ocr_results (id, evidence_id, engine, text, redacted_text, confidence, superseded, created_at)
       VALUES (?,?,?,?,?,?,0,?)`,
      id,
      input.evidenceId,
      input.engine,
      input.text,
      input.redactedText ?? null,
      input.confidence ?? null,
      nowIso(),
    );
  });
  return mapRow<OcrRecord>(db.get('SELECT * FROM ocr_results WHERE id = ?', id), { bool: ['superseded'] })!;
}

export function getLatestOcr(db: Database, evidenceId: string): OcrRecord | undefined {
  return mapRow<OcrRecord>(
    db.get(
      'SELECT * FROM ocr_results WHERE evidence_id = ? AND superseded = 0 ORDER BY created_at DESC LIMIT 1',
      evidenceId,
    ),
    { bool: ['superseded'] },
  );
}

// --- secret findings ------------------------------------------------------

export function recordSecretFinding(
  db: Database,
  input: {
    projectId: string;
    subjectType: string;
    subjectId: string;
    detector: string;
    severity: 'high' | 'medium' | 'low';
    preview: string;
  },
): void {
  const existing = db.get<{ id: string }>(
    'SELECT id FROM secret_findings WHERE subject_type = ? AND subject_id = ? AND detector = ? AND preview = ?',
    input.subjectType,
    input.subjectId,
    input.detector,
    input.preview,
  );
  if (existing) return;
  db.run(
    `INSERT INTO secret_findings (id, project_id, subject_type, subject_id, detector, severity, preview, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    newId('secret'),
    input.projectId,
    input.subjectType,
    input.subjectId,
    input.detector,
    input.severity,
    input.preview,
    nowIso(),
  );
}

export function listSecretFindings(db: Database, projectId: string) {
  return mapRows(
    db.all('SELECT * FROM secret_findings WHERE project_id = ? ORDER BY created_at DESC', projectId),
    { bool: ['acknowledged'] },
  );
}

export function acknowledgeSecretFinding(db: Database, id: string): void {
  db.run('UPDATE secret_findings SET acknowledged = 1 WHERE id = ?', id);
}
