import type { Database } from '../index.ts';
import { mapRow, mapRows, buildUpdate } from '../mapper.ts';
import { newId, nowIso, stableHash } from '../../lib/core.ts';
import type { Claim, ClaimSupport, Confidence, ProblemRecord, Provenance } from '../../domain/types.ts';

// --- claims ---------------------------------------------------------------

// `bool` keys are database column names, not the camel-cased field names the
// mapper produces.
const CLAIM_SPEC = { json: { supports: [] as ClaimSupport[] }, bool: ['edited_by_user', 'accepted'] };

export interface UpsertClaimInput {
  projectId: string;
  subjectType: Claim['subjectType'];
  subjectId: string;
  slot: string;
  provenance: Provenance;
  confidence?: Confidence;
  text: string;
  depth?: number;
  supports?: ClaimSupport[];
  position?: number;
  generationId?: string | null;
}

export function createClaim(db: Database, input: UpsertClaimInput): Claim {
  const id = newId('claim');
  const now = nowIso();
  db.run(
    `INSERT INTO claims (id, project_id, subject_type, subject_id, slot, provenance, confidence, text,
       depth, supports_json, position, generation_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    input.subjectType,
    input.subjectId,
    input.slot,
    input.provenance,
    input.confidence ?? 'medium',
    input.text,
    input.depth ?? 2,
    JSON.stringify(input.supports ?? []),
    input.position ?? 0,
    input.generationId ?? null,
    now,
    now,
  );
  return getClaim(db, id)!;
}

export function getClaim(db: Database, id: string): Claim | undefined {
  return mapRow<Claim>(db.get('SELECT * FROM claims WHERE id = ?', id), CLAIM_SPEC);
}

export function listClaims(db: Database, subjectType: string, subjectId: string): Claim[] {
  return mapRows<Claim>(
    db.all(
      'SELECT * FROM claims WHERE subject_type = ? AND subject_id = ? ORDER BY position, created_at',
      subjectType,
      subjectId,
    ),
    CLAIM_SPEC,
  );
}

export function listProjectClaims(db: Database, projectId: string): Claim[] {
  return mapRows<Claim>(
    db.all('SELECT * FROM claims WHERE project_id = ? ORDER BY subject_type, subject_id, position', projectId),
    CLAIM_SPEC,
  );
}

export function updateClaim(db: Database, id: string, patch: Record<string, unknown>): Claim | undefined {
  const { sql, params } = buildUpdate(patch, {
    text: 'text',
    provenance: 'provenance',
    confidence: 'confidence',
    slot: 'slot',
    depth: 'depth',
    supports: 'supports_json',
    position: 'position',
    accepted: 'accepted',
    editedByUser: 'edited_by_user',
  });
  if (sql) db.run(`UPDATE claims SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return getClaim(db, id);
}

export function deleteClaim(db: Database, id: string): void {
  db.run('DELETE FROM claims WHERE id = ?', id);
}

/**
 * Replaces a subject's generated claims while preserving anything the user has
 * touched — regeneration must never silently discard human corrections.
 */
export function replaceGeneratedClaims(
  db: Database,
  subjectType: string,
  subjectId: string,
  claims: UpsertClaimInput[],
  generationId: string,
): Claim[] {
  return db.tx(() => {
    const kept = db.all<{ slot: string }>(
      'SELECT slot FROM claims WHERE subject_type = ? AND subject_id = ? AND (edited_by_user = 1 OR accepted = 1)',
      subjectType,
      subjectId,
    );
    const protectedSlots = new Set(kept.map((r) => r.slot));
    db.run(
      'DELETE FROM claims WHERE subject_type = ? AND subject_id = ? AND edited_by_user = 0 AND (accepted IS NULL OR accepted = 0)',
      subjectType,
      subjectId,
    );
    const created: Claim[] = [];
    claims.forEach((claim, index) => {
      if (protectedSlots.has(claim.slot)) return;
      created.push(createClaim(db, { ...claim, position: claim.position ?? index, generationId }));
    });
    return created;
  });
}

export function claimsBySlot(claims: Claim[]): Map<string, Claim[]> {
  const map = new Map<string, Claim[]>();
  for (const claim of claims) {
    const list = map.get(claim.slot) ?? [];
    list.push(claim);
    map.set(claim.slot, list);
  }
  return map;
}

// --- problems -------------------------------------------------------------

export function createProblem(
  db: Database,
  input: {
    projectId: string;
    stepId?: string | null;
    title: string;
    symptoms?: string | null;
    impact?: string | null;
    hypothesis?: string | null;
    status?: string;
    detectedAt?: string | null;
    position?: number;
  },
): ProblemRecord {
  const id = newId('problem');
  const now = nowIso();
  const position =
    input.position ??
    ((db.get<{ m: number | null }>(
      'SELECT MAX(position) AS m FROM problems WHERE project_id = ? AND deleted_at IS NULL',
      input.projectId,
    )?.m ?? 0) + 1);
  db.run(
    `INSERT INTO problems (id, project_id, step_id, title, symptoms, impact, hypothesis, status,
       detected_at, position, ai_state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    input.stepId ?? null,
    input.title,
    input.symptoms ?? null,
    input.impact ?? null,
    input.hypothesis ?? null,
    input.status ?? 'open',
    input.detectedAt ?? null,
    position,
    'pending',
    now,
    now,
  );
  const problem = getProblem(db, id)!;
  db.run('UPDATE problems SET content_hash = ? WHERE id = ?', problemContentHash(problem), id);
  return getProblem(db, id)!;
}

export function getProblem(db: Database, id: string): ProblemRecord | undefined {
  return mapRow<ProblemRecord>(db.get('SELECT * FROM problems WHERE id = ? AND deleted_at IS NULL', id));
}

export function listProblems(db: Database, projectId: string): ProblemRecord[] {
  return mapRows<ProblemRecord>(
    db.all(
      'SELECT * FROM problems WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, created_at',
      projectId,
    ),
  );
}

export function updateProblem(db: Database, id: string, patch: Record<string, unknown>): ProblemRecord | undefined {
  const { sql, params } = buildUpdate(patch, {
    title: 'title',
    symptoms: 'symptoms',
    impact: 'impact',
    hypothesis: 'hypothesis',
    rootCause: 'root_cause',
    rootCauseProvenance: 'root_cause_provenance',
    rootCauseConfidence: 'root_cause_confidence',
    status: 'status',
    stepId: 'step_id',
    detectedAt: 'detected_at',
    resolvedAt: 'resolved_at',
    position: 'position',
    aiState: 'ai_state',
  });
  if (sql) db.run(`UPDATE problems SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  const problem = getProblem(db, id);
  if (!problem) return undefined;
  const hash = problemContentHash(problem);
  if (hash !== problem.contentHash) {
    db.run(
      `UPDATE problems SET content_hash = ?, ai_state = CASE WHEN ai_state = 'elaborated' THEN 'stale' ELSE ai_state END WHERE id = ?`,
      hash,
      id,
    );
  }
  return getProblem(db, id);
}

export function deleteProblem(db: Database, id: string): void {
  db.run('UPDATE problems SET deleted_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
}

export function problemContentHash(problem: ProblemRecord): string {
  return stableHash({
    title: problem.title,
    symptoms: problem.symptoms,
    impact: problem.impact,
    hypothesis: problem.hypothesis,
    rootCause: problem.rootCause,
    status: problem.status,
  });
}

export interface InvestigationRecord {
  id: string;
  problemId: string;
  position: number;
  action: string;
  finding: string | null;
  tool: string | null;
  origin: string;
  createdAt: string;
  updatedAt: string;
}

export function createInvestigation(
  db: Database,
  input: { problemId: string; action: string; finding?: string | null; tool?: string | null; origin?: string; position?: number },
): InvestigationRecord {
  const id = newId('investigation');
  const now = nowIso();
  const position =
    input.position ??
    ((db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM investigations WHERE problem_id = ?', input.problemId)?.m ?? 0) + 1);
  db.run(
    `INSERT INTO investigations (id, problem_id, position, action, finding, tool, origin, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    input.problemId,
    position,
    input.action,
    input.finding ?? null,
    input.tool ?? null,
    input.origin ?? 'user',
    now,
    now,
  );
  return mapRow<InvestigationRecord>(db.get('SELECT * FROM investigations WHERE id = ?', id))!;
}

export function listInvestigations(db: Database, problemId: string): InvestigationRecord[] {
  return mapRows<InvestigationRecord>(
    db.all('SELECT * FROM investigations WHERE problem_id = ? ORDER BY position, created_at', problemId),
  );
}

export function deleteInvestigation(db: Database, id: string): void {
  db.run('DELETE FROM investigations WHERE id = ?', id);
}

export interface ResolutionRecord {
  id: string;
  problemId: string;
  description: string;
  validation: string | null;
  validated: boolean;
  origin: string;
  createdAt: string;
  updatedAt: string;
}

export function createResolution(
  db: Database,
  input: { problemId: string; description: string; validation?: string | null; validated?: boolean; origin?: string },
): ResolutionRecord {
  const id = newId('resolution');
  const now = nowIso();
  db.run(
    `INSERT INTO resolutions (id, problem_id, description, validation, validated, origin, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    input.problemId,
    input.description,
    input.validation ?? null,
    input.validated ? 1 : 0,
    input.origin ?? 'user',
    now,
    now,
  );
  return mapRow<ResolutionRecord>(db.get('SELECT * FROM resolutions WHERE id = ?', id), { bool: ['validated'] })!;
}

export function listResolutions(db: Database, problemId: string): ResolutionRecord[] {
  return mapRows<ResolutionRecord>(
    db.all('SELECT * FROM resolutions WHERE problem_id = ? ORDER BY created_at', problemId),
    { bool: ['validated'] },
  );
}

export function updateResolution(db: Database, id: string, patch: Record<string, unknown>) {
  const { sql, params } = buildUpdate(patch, {
    description: 'description',
    validation: 'validation',
    validated: 'validated',
  });
  if (sql) db.run(`UPDATE resolutions SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return mapRow<ResolutionRecord>(db.get('SELECT * FROM resolutions WHERE id = ?', id), { bool: ['validated'] });
}

export function deleteResolution(db: Database, id: string): void {
  db.run('DELETE FROM resolutions WHERE id = ?', id);
}

// --- tests / results / references ----------------------------------------

export interface TestRecord {
  id: string;
  projectId: string;
  stepId: string | null;
  name: string;
  method: string | null;
  expected: string | null;
  observed: string | null;
  outcome: 'pass' | 'fail' | 'partial' | 'untested';
  performedAt: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export function createTest(db: Database, input: Partial<TestRecord> & { projectId: string; name: string }): TestRecord {
  const id = newId('test');
  const now = nowIso();
  const position =
    input.position ??
    ((db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM tests WHERE project_id = ?', input.projectId)?.m ?? 0) + 1);
  db.run(
    `INSERT INTO tests (id, project_id, step_id, name, method, expected, observed, outcome, performed_at, position, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    input.stepId ?? null,
    input.name,
    input.method ?? null,
    input.expected ?? null,
    input.observed ?? null,
    input.outcome ?? 'untested',
    input.performedAt ?? null,
    position,
    now,
    now,
  );
  return mapRow<TestRecord>(db.get('SELECT * FROM tests WHERE id = ?', id))!;
}

export function listTests(db: Database, projectId: string): TestRecord[] {
  return mapRows<TestRecord>(
    db.all('SELECT * FROM tests WHERE project_id = ? ORDER BY position, created_at', projectId),
  );
}

export function updateTest(db: Database, id: string, patch: Record<string, unknown>) {
  const { sql, params } = buildUpdate(patch, {
    name: 'name',
    method: 'method',
    expected: 'expected',
    observed: 'observed',
    outcome: 'outcome',
    performedAt: 'performed_at',
    stepId: 'step_id',
    position: 'position',
  });
  if (sql) db.run(`UPDATE tests SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return mapRow<TestRecord>(db.get('SELECT * FROM tests WHERE id = ?', id));
}

export function deleteTest(db: Database, id: string): void {
  db.run('DELETE FROM tests WHERE id = ?', id);
}

export interface ResultRecord {
  id: string;
  projectId: string;
  title: string;
  detail: string | null;
  metric: string | null;
  value: string | null;
  provenance: Provenance;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export function createResult(db: Database, input: Partial<ResultRecord> & { projectId: string; title: string }): ResultRecord {
  const id = newId('result');
  const now = nowIso();
  const position =
    input.position ??
    ((db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM results WHERE project_id = ?', input.projectId)?.m ?? 0) + 1);
  db.run(
    `INSERT INTO results (id, project_id, title, detail, metric, value, provenance, position, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    input.title,
    input.detail ?? null,
    input.metric ?? null,
    input.value ?? null,
    input.provenance ?? 'USER_FACT',
    position,
    now,
    now,
  );
  return mapRow<ResultRecord>(db.get('SELECT * FROM results WHERE id = ?', id))!;
}

export function listResults(db: Database, projectId: string): ResultRecord[] {
  return mapRows<ResultRecord>(
    db.all('SELECT * FROM results WHERE project_id = ? ORDER BY position, created_at', projectId),
  );
}

export function updateResult(db: Database, id: string, patch: Record<string, unknown>) {
  const { sql, params } = buildUpdate(patch, {
    title: 'title',
    detail: 'detail',
    metric: 'metric',
    value: 'value',
    provenance: 'provenance',
    position: 'position',
  });
  if (sql) db.run(`UPDATE results SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  return mapRow<ResultRecord>(db.get('SELECT * FROM results WHERE id = ?', id));
}

export function deleteResult(db: Database, id: string): void {
  db.run('DELETE FROM results WHERE id = ?', id);
}

export interface RefRecord {
  id: string;
  projectId: string;
  label: string;
  url: string | null;
  detail: string | null;
  origin: string;
  position: number;
  createdAt: string;
}

export function createRef(db: Database, input: { projectId: string; label: string; url?: string | null; detail?: string | null; origin?: string }): RefRecord {
  const id = newId('ref');
  const position =
    (db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM refs WHERE project_id = ?', input.projectId)?.m ?? 0) + 1;
  db.run(
    'INSERT INTO refs (id, project_id, label, url, detail, origin, position, created_at) VALUES (?,?,?,?,?,?,?,?)',
    id,
    input.projectId,
    input.label,
    input.url ?? null,
    input.detail ?? null,
    input.origin ?? 'user',
    position,
    nowIso(),
  );
  return mapRow<RefRecord>(db.get('SELECT * FROM refs WHERE id = ?', id))!;
}

export function listRefs(db: Database, projectId: string): RefRecord[] {
  return mapRows<RefRecord>(db.all('SELECT * FROM refs WHERE project_id = ? ORDER BY position', projectId));
}

export function deleteRef(db: Database, id: string): void {
  db.run('DELETE FROM refs WHERE id = ?', id);
}

// --- insights -------------------------------------------------------------

export interface InsightRecord {
  id: string;
  projectId: string;
  runId: string | null;
  kind: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  suggestion: string | null;
  targets: { type: string; id: string }[];
  confidence: Confidence;
  state: 'open' | 'accepted' | 'dismissed' | 'resolved';
  scope: 'project' | 'presentation' | 'report';
  scopeId: string | null;
  createdAt: string;
  updatedAt: string;
}

const INSIGHT_SPEC = { json: { targets: [] as { type: string; id: string }[] } };

export function replaceInsights(
  db: Database,
  projectId: string,
  scope: 'project' | 'presentation' | 'report',
  scopeId: string | null,
  insights: Omit<InsightRecord, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'state' | 'scope' | 'scopeId'>[],
): InsightRecord[] {
  return db.tx(() => {
    // Dismissed insights stay dismissed across regenerations.
    const dismissed = new Set(
      db
        .all<{ title: string }>(
          "SELECT title FROM ai_insights WHERE project_id = ? AND scope = ? AND state = 'dismissed'",
          projectId,
          scope,
        )
        .map((r) => r.title),
    );
    if (scopeId) {
      db.run(
        "DELETE FROM ai_insights WHERE project_id = ? AND scope = ? AND scope_id = ? AND state != 'dismissed'",
        projectId,
        scope,
        scopeId,
      );
    } else {
      db.run(
        "DELETE FROM ai_insights WHERE project_id = ? AND scope = ? AND state != 'dismissed'",
        projectId,
        scope,
      );
    }
    const now = nowIso();
    const created: InsightRecord[] = [];
    for (const insight of insights) {
      if (dismissed.has(insight.title)) continue;
      const id = newId('insight');
      db.run(
        `INSERT INTO ai_insights (id, project_id, run_id, kind, severity, title, detail, suggestion,
           targets_json, confidence, state, scope, scope_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        projectId,
        insight.runId ?? null,
        insight.kind,
        insight.severity,
        insight.title,
        insight.detail,
        insight.suggestion ?? null,
        JSON.stringify(insight.targets ?? []),
        insight.confidence,
        'open',
        scope,
        scopeId,
        now,
        now,
      );
      created.push(mapRow<InsightRecord>(db.get('SELECT * FROM ai_insights WHERE id = ?', id), INSIGHT_SPEC)!);
    }
    return created;
  });
}

export function listInsights(
  db: Database,
  projectId: string,
  filter: { scope?: string; scopeId?: string | null; state?: string } = {},
): InsightRecord[] {
  const clauses = ['project_id = ?'];
  const params: unknown[] = [projectId];
  if (filter.scope) {
    clauses.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.scopeId) {
    clauses.push('scope_id = ?');
    params.push(filter.scopeId);
  }
  if (filter.state) {
    clauses.push('state = ?');
    params.push(filter.state);
  }
  return mapRows<InsightRecord>(
    db.all(
      `SELECT * FROM ai_insights WHERE ${clauses.join(' AND ')}
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC`,
      ...params,
    ),
    INSIGHT_SPEC,
  );
}

export function setInsightState(db: Database, id: string, state: string): InsightRecord | undefined {
  db.run('UPDATE ai_insights SET state = ?, updated_at = ? WHERE id = ?', state, nowIso(), id);
  return mapRow<InsightRecord>(db.get('SELECT * FROM ai_insights WHERE id = ?', id), INSIGHT_SPEC);
}
