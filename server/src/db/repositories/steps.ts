import type { Database } from '../index.ts';
import { mapRow, mapRows, buildUpdate } from '../mapper.ts';
import { newId, nowIso, stableHash } from '../../lib/core.ts';
import type { StepRecord } from '../../domain/types.ts';

const COLUMNS: Record<string, string> = {
  title: 'title',
  userDescription: 'user_description',
  category: 'category',
  status: 'status',
  occurredAt: 'occurred_at',
  configuration: 'configuration',
  expectedResult: 'expected_result',
  actualResult: 'actual_result',
  validation: 'validation',
  position: 'position',
  aiState: 'ai_state',
  aiConfidence: 'ai_confidence',
  elaborationDepth: 'elaboration_depth',
  contentHash: 'content_hash',
};

export interface CreateStepInput {
  projectId: string;
  title: string;
  userDescription?: string;
  category?: string;
  status?: string;
  occurredAt?: string | null;
  configuration?: string | null;
  expectedResult?: string | null;
  actualResult?: string | null;
  validation?: string | null;
  position?: number;
  source?: 'user' | 'ai-structured' | 'import';
}

export function nextStepPosition(db: Database, projectId: string): number {
  const row = db.get<{ maxPos: number | null }>(
    'SELECT MAX(position) AS maxPos FROM steps WHERE project_id = ? AND deleted_at IS NULL',
    projectId,
  );
  return (row?.maxPos ?? 0) + 1;
}

export function createStep(db: Database, input: CreateStepInput): StepRecord {
  const id = newId('step');
  const now = nowIso();
  const position = input.position ?? nextStepPosition(db, input.projectId);
  db.run(
    `INSERT INTO steps (id, project_id, position, title, user_description, category, status,
       occurred_at, configuration, expected_result, actual_result, validation, source,
       ai_state, content_hash, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    position,
    input.title,
    input.userDescription ?? '',
    input.category ?? 'other',
    input.status ?? 'done',
    input.occurredAt ?? null,
    input.configuration ?? null,
    input.expectedResult ?? null,
    input.actualResult ?? null,
    input.validation ?? null,
    input.source ?? 'user',
    'pending',
    null,
    now,
    now,
  );
  const step = getStep(db, id)!;
  db.run('UPDATE steps SET content_hash = ? WHERE id = ?', stepContentHash(step), id);
  return getStep(db, id)!;
}

export function getStep(db: Database, id: string): StepRecord | undefined {
  return mapRow<StepRecord>(db.get('SELECT * FROM steps WHERE id = ? AND deleted_at IS NULL', id));
}

export function listSteps(db: Database, projectId: string): StepRecord[] {
  return mapRows<StepRecord>(
    db.all(
      'SELECT * FROM steps WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, created_at',
      projectId,
    ),
  );
}

export function updateStep(db: Database, id: string, patch: Record<string, unknown>): StepRecord | undefined {
  const { sql, params } = buildUpdate(patch, COLUMNS);
  if (sql) db.run(`UPDATE steps SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  const step = getStep(db, id);
  if (!step) return undefined;
  // Any change to the user-authored substance invalidates the elaboration.
  const hash = stepContentHash(step);
  if (hash !== step.contentHash) {
    db.run(
      `UPDATE steps SET content_hash = ?, ai_state = CASE WHEN ai_state = 'elaborated' THEN 'stale' ELSE ai_state END
       WHERE id = ?`,
      hash,
      id,
    );
  }
  return getStep(db, id);
}

export function deleteStep(db: Database, id: string): void {
  db.run('UPDATE steps SET deleted_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
}

export function reorderSteps(db: Database, projectId: string, orderedIds: string[]): void {
  db.tx(() => {
    orderedIds.forEach((id, index) => {
      db.run('UPDATE steps SET position = ?, updated_at = ? WHERE id = ? AND project_id = ?', index + 1, nowIso(), id, projectId);
    });
  });
}

/** Hash of only the user-authored substance — AI output never feeds this. */
export function stepContentHash(step: StepRecord): string {
  return stableHash({
    title: step.title,
    description: step.userDescription,
    category: step.category,
    status: step.status,
    configuration: step.configuration,
    expected: step.expectedResult,
    actual: step.actualResult,
    validation: step.validation,
  });
}

export function markStepsStale(db: Database, projectId: string): void {
  db.run(
    "UPDATE steps SET ai_state = 'stale' WHERE project_id = ? AND ai_state = 'elaborated'",
    projectId,
  );
}

// --- commands -------------------------------------------------------------

export interface CommandRecord {
  id: string;
  projectId: string;
  stepId: string | null;
  problemId: string | null;
  language: string;
  content: string;
  output: string | null;
  explanation: string | null;
  position: number;
  origin: 'user' | 'evidence' | 'ai-suggested';
  createdAt: string;
  updatedAt: string;
}

export function createCommand(
  db: Database,
  input: {
    projectId: string;
    stepId?: string | null;
    problemId?: string | null;
    language?: string;
    content: string;
    output?: string | null;
    origin?: string;
    position?: number;
  },
): CommandRecord {
  const id = newId('command');
  const now = nowIso();
  db.run(
    `INSERT INTO commands (id, project_id, step_id, problem_id, language, content, output, position, origin, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    input.stepId ?? null,
    input.problemId ?? null,
    input.language ?? 'bash',
    input.content,
    input.output ?? null,
    input.position ?? 0,
    input.origin ?? 'user',
    now,
    now,
  );
  return getCommand(db, id)!;
}

export function getCommand(db: Database, id: string): CommandRecord | undefined {
  return mapRow<CommandRecord>(db.get('SELECT * FROM commands WHERE id = ?', id));
}

export function listCommandsForStep(db: Database, stepId: string): CommandRecord[] {
  return mapRows<CommandRecord>(
    db.all('SELECT * FROM commands WHERE step_id = ? ORDER BY position, created_at', stepId),
  );
}

export function listCommandsForProject(db: Database, projectId: string): CommandRecord[] {
  return mapRows<CommandRecord>(
    db.all('SELECT * FROM commands WHERE project_id = ? ORDER BY created_at', projectId),
  );
}

export function updateCommand(db: Database, id: string, patch: Record<string, unknown>): CommandRecord | undefined {
  const { sql, params } = buildUpdate(patch, {
    language: 'language',
    content: 'content',
    output: 'output',
    explanation: 'explanation',
    position: 'position',
    stepId: 'step_id',
  });
  if (sql) db.run(`UPDATE commands SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return getCommand(db, id);
}

export function deleteCommand(db: Database, id: string): void {
  db.run('DELETE FROM commands WHERE id = ?', id);
}

// --- step links -----------------------------------------------------------

export function linkSteps(
  db: Database,
  fromStepId: string,
  toStepId: string,
  relation: string,
  origin: 'user' | 'ai' = 'user',
): void {
  if (fromStepId === toStepId) return;
  db.run(
    `INSERT INTO step_links (from_step_id, to_step_id, relation, origin) VALUES (?,?,?,?)
     ON CONFLICT DO NOTHING`,
    fromStepId,
    toStepId,
    relation,
    origin,
  );
}

export function listStepLinks(db: Database, projectId: string) {
  return db.all(
    `SELECT l.* FROM step_links l JOIN steps s ON s.id = l.from_step_id WHERE s.project_id = ?`,
    projectId,
  );
}
