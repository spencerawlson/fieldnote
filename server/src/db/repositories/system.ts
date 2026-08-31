import type { Database } from '../index.ts';
import { mapRow, mapRows } from '../mapper.ts';
import { newId, nowIso, parseJson } from '../../lib/core.ts';

// --- users and sessions ---------------------------------------------------

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: 'user' | 'admin';
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export function createUser(
  db: Database,
  input: { email: string; name: string; passwordHash: string; role?: 'user' | 'admin' },
): UserRecord {
  const id = newId('user');
  const now = nowIso();
  db.run(
    'INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    id,
    input.email.toLowerCase(),
    input.name,
    input.passwordHash,
    input.role ?? 'user',
    now,
    now,
  );
  return getUser(db, id)!;
}

export function getUser(db: Database, id: string): UserRecord | undefined {
  return mapRow<UserRecord>(db.get('SELECT * FROM users WHERE id = ?', id));
}

export function getUserByEmail(db: Database, email: string): UserRecord | undefined {
  return mapRow<UserRecord>(db.get('SELECT * FROM users WHERE email = ?', email.toLowerCase()));
}

export function countUsers(db: Database): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
}

export function touchLogin(db: Database, id: string): void {
  db.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), id);
}

export interface SessionRecord {
  id: string;
  userId: string;
  csrfToken: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
}

export function createSession(
  db: Database,
  input: { userId: string; csrfToken: string; userAgent?: string | null; ip?: string | null; ttlSeconds: number },
): SessionRecord {
  const id = newId('session');
  const now = new Date();
  db.run(
    'INSERT INTO sessions (id, user_id, csrf_token, user_agent, ip, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
    id,
    input.userId,
    input.csrfToken,
    input.userAgent ?? null,
    input.ip ?? null,
    now.toISOString(),
    new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
  );
  return mapRow<SessionRecord>(db.get('SELECT * FROM sessions WHERE id = ?', id))!;
}

export function getSession(db: Database, id: string): SessionRecord | undefined {
  return mapRow<SessionRecord>(
    db.get("SELECT * FROM sessions WHERE id = ? AND expires_at > ?", id, nowIso()),
  );
}

export function deleteSession(db: Database, id: string): void {
  db.run('DELETE FROM sessions WHERE id = ?', id);
}

export function purgeExpiredSessions(db: Database): number {
  return db.run('DELETE FROM sessions WHERE expires_at <= ?', nowIso()).changes;
}

// --- versioning -----------------------------------------------------------

export interface VersionRecord {
  id: string;
  projectId: string;
  entityType: string;
  entityId: string;
  revision: number;
  actorType: 'user' | 'ai' | 'system';
  actorId: string | null;
  reason: string;
  snapshot: unknown;
  createdAt: string;
}

const VERSION_SPEC = { json: { snapshot: null } };

export function recordVersion(
  db: Database,
  input: {
    projectId: string;
    entityType: string;
    entityId: string;
    actorType: 'user' | 'ai' | 'system';
    actorId?: string | null;
    reason?: string;
    snapshot: unknown;
  },
): VersionRecord {
  const next =
    (db.get<{ m: number | null }>(
      'SELECT MAX(revision) AS m FROM versions WHERE entity_type = ? AND entity_id = ?',
      input.entityType,
      input.entityId,
    )?.m ?? 0) + 1;
  const id = newId('version');
  db.run(
    `INSERT INTO versions (id, project_id, entity_type, entity_id, revision, actor_type, actor_id, reason, snapshot_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId,
    input.entityType,
    input.entityId,
    next,
    input.actorType,
    input.actorId ?? null,
    input.reason ?? '',
    JSON.stringify(input.snapshot),
    nowIso(),
  );
  return mapRow<VersionRecord>(db.get('SELECT * FROM versions WHERE id = ?', id), VERSION_SPEC)!;
}

export function listVersions(db: Database, entityType: string, entityId: string, limit = 50): VersionRecord[] {
  return mapRows<VersionRecord>(
    db.all(
      'SELECT * FROM versions WHERE entity_type = ? AND entity_id = ? ORDER BY revision DESC LIMIT ?',
      entityType,
      entityId,
      limit,
    ),
    VERSION_SPEC,
  );
}

export function listProjectVersions(db: Database, projectId: string, limit = 100): VersionRecord[] {
  return mapRows<VersionRecord>(
    db.all('SELECT * FROM versions WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', projectId, limit),
    VERSION_SPEC,
  );
}

export function getVersion(db: Database, id: string): VersionRecord | undefined {
  return mapRow<VersionRecord>(db.get('SELECT * FROM versions WHERE id = ?', id), VERSION_SPEC);
}

// --- audit ----------------------------------------------------------------

export function audit(
  db: Database,
  input: {
    projectId?: string | null;
    userId?: string | null;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    ip?: string | null;
    detail?: Record<string, unknown>;
  },
): void {
  db.run(
    `INSERT INTO audit_log (id, project_id, user_id, action, entity_type, entity_id, ip, detail_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    newId('audit'),
    input.projectId ?? null,
    input.userId ?? null,
    input.action,
    input.entityType ?? null,
    input.entityId ?? null,
    input.ip ?? null,
    JSON.stringify(input.detail ?? {}),
    nowIso(),
  );
}

export function listAudit(db: Database, projectId: string, limit = 100) {
  return mapRows(db.all('SELECT * FROM audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', projectId, limit), {
    json: { detail: {} },
  });
}

// --- AI usage and cache ---------------------------------------------------

export function recordAiRun(
  db: Database,
  input: {
    projectId?: string | null;
    userId?: string | null;
    service: string;
    provider: string;
    model: string;
    status: 'ok' | 'error' | 'cached';
    inputTokens?: number;
    outputTokens?: number;
    costCents?: number;
    durationMs?: number;
    cacheKey?: string | null;
    error?: string | null;
  },
): string {
  const id = newId('aiRun');
  db.run(
    `INSERT INTO ai_runs (id, project_id, user_id, service, provider, model, status, input_tokens, output_tokens,
       cost_cents, duration_ms, cache_key, error, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId ?? null,
    input.userId ?? null,
    input.service,
    input.provider,
    input.model,
    input.status,
    input.inputTokens ?? 0,
    input.outputTokens ?? 0,
    input.costCents ?? 0,
    input.durationMs ?? 0,
    input.cacheKey ?? null,
    input.error ? input.error.slice(0, 500) : null,
    nowIso(),
  );
  return id;
}

export function monthlySpendCents(db: Database, scope: 'user' | 'project', id: string): number {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const column = scope === 'user' ? 'user_id' : 'project_id';
  return (
    db.get<{ total: number | null }>(
      `SELECT SUM(cost_cents) AS total FROM ai_runs WHERE ${column} = ? AND created_at >= ?`,
      id,
      since.toISOString(),
    )?.total ?? 0
  );
}

export function usageSummary(db: Database, projectId: string) {
  const totals = db.get<{ runs: number; input: number; output: number; cost: number }>(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS input,
            COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cost_cents),0) AS cost
     FROM ai_runs WHERE project_id = ?`,
    projectId,
  );
  const byService = db.all(
    `SELECT service, COUNT(*) AS runs, COALESCE(SUM(cost_cents),0) AS cost
     FROM ai_runs WHERE project_id = ? GROUP BY service ORDER BY cost DESC`,
    projectId,
  );
  return { totals, byService };
}

export function readCache<T>(db: Database, cacheKey: string): T | undefined {
  const row = db.get<{ payload: string }>('SELECT payload FROM ai_cache WHERE cache_key = ?', cacheKey);
  if (!row) return undefined;
  db.run('UPDATE ai_cache SET hits = hits + 1 WHERE cache_key = ?', cacheKey);
  return parseJson<T | undefined>(row.payload, undefined);
}

export function writeCache(db: Database, cacheKey: string, service: string, model: string, payload: unknown): void {
  db.run(
    `INSERT INTO ai_cache (cache_key, service, model, payload, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
    cacheKey,
    service,
    model,
    JSON.stringify(payload),
    nowIso(),
  );
}

// --- jobs -----------------------------------------------------------------

export interface JobRecord {
  id: string;
  projectId: string | null;
  userId: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  progressTotal: number;
  message: string;
  result: unknown;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lockedAt: string | null;
  lockedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const JOB_SPEC = { json: { payload: {}, result: null } };

export function enqueueJob(
  db: Database,
  input: { projectId?: string | null; userId?: string | null; type: string; payload?: Record<string, unknown>; maxAttempts?: number },
): JobRecord {
  const id = newId('job');
  const now = nowIso();
  db.run(
    `INSERT INTO jobs (id, project_id, user_id, type, payload_json, status, run_after, max_attempts, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.projectId ?? null,
    input.userId ?? null,
    input.type,
    JSON.stringify(input.payload ?? {}),
    'queued',
    now,
    input.maxAttempts ?? 3,
    now,
    now,
  );
  return getJob(db, id)!;
}

export function getJob(db: Database, id: string): JobRecord | undefined {
  return mapRow<JobRecord>(db.get('SELECT * FROM jobs WHERE id = ?', id), JOB_SPEC);
}

export function claimNextJob(db: Database, workerId: string): JobRecord | undefined {
  return db.tx(() => {
    const row = db.get<{ id: string }>(
      `SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY created_at LIMIT 1`,
      nowIso(),
    );
    if (!row) return undefined;
    const now = nowIso();
    const updated = db.run(
      `UPDATE jobs SET status = 'running', locked_at = ?, locked_by = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status = 'queued'`,
      now,
      workerId,
      now,
      row.id,
    );
    if (updated.changes === 0) return undefined;
    return getJob(db, row.id);
  });
}

export function updateJobProgress(
  db: Database,
  id: string,
  patch: { progress?: number; progressTotal?: number; message?: string },
): void {
  db.run(
    `UPDATE jobs SET progress = COALESCE(?, progress), progress_total = COALESCE(?, progress_total),
       message = COALESCE(?, message), updated_at = ? WHERE id = ?`,
    patch.progress ?? null,
    patch.progressTotal ?? null,
    patch.message ?? null,
    nowIso(),
    id,
  );
}

export function completeJob(db: Database, id: string, result: unknown): void {
  db.run(
    `UPDATE jobs SET status = 'succeeded', result_json = ?, message = '', updated_at = ?, locked_by = NULL WHERE id = ?`,
    JSON.stringify(result ?? null),
    nowIso(),
    id,
  );
}

export function failJob(db: Database, id: string, error: string, retryDelayMs: number): void {
  const job = getJob(db, id);
  if (!job) return;
  if (job.attempts < job.maxAttempts) {
    db.run(
      `UPDATE jobs SET status = 'queued', error = ?, run_after = ?, updated_at = ?, locked_by = NULL WHERE id = ?`,
      error.slice(0, 1000),
      new Date(Date.now() + retryDelayMs).toISOString(),
      nowIso(),
      id,
    );
  } else {
    db.run(
      `UPDATE jobs SET status = 'failed', error = ?, updated_at = ?, locked_by = NULL WHERE id = ?`,
      error.slice(0, 1000),
      nowIso(),
      id,
    );
  }
}

export function listJobs(db: Database, projectId: string, limit = 25): JobRecord[] {
  return mapRows<JobRecord>(
    db.all('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', projectId, limit),
    JOB_SPEC,
  );
}

export function listActiveJobs(db: Database, projectId: string): JobRecord[] {
  return mapRows<JobRecord>(
    db.all(
      `SELECT * FROM jobs WHERE project_id = ? AND status IN ('queued','running') ORDER BY created_at`,
      projectId,
    ),
    JOB_SPEC,
  );
}

/** Jobs stuck in `running` after a crash are returned to the queue at boot. */
export function requeueStaleJobs(db: Database, olderThanMs = 10 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return db.run(
    `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = ?
     WHERE status = 'running' AND locked_at < ?`,
    nowIso(),
    cutoff,
  ).changes;
}

// --- search index ---------------------------------------------------------

export function indexDocument(
  db: Database,
  input: { projectId: string; entityType: string; entityId: string; title: string; body: string },
): void {
  db.run('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?', input.entityType, input.entityId);
  db.run(
    'INSERT INTO search_index (title, body, entity_type, entity_id, project_id) VALUES (?,?,?,?,?)',
    input.title,
    input.body,
    input.entityType,
    input.entityId,
    input.projectId,
  );
}

export function removeFromIndex(db: Database, entityType: string, entityId: string): void {
  db.run('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?', entityType, entityId);
}

export interface SearchHit {
  entityType: string;
  entityId: string;
  title: string;
  snippet: string;
  score: number;
}

export function searchProject(db: Database, projectId: string, query: string, limit = 30): SearchHit[] {
  const sanitized = toFtsQuery(query);
  if (!sanitized) return [];
  try {
    return db
      .all<{ entity_type: string; entity_id: string; title: string; snippet: string; score: number }>(
        `SELECT entity_type, entity_id, title,
                snippet(search_index, 1, '[', ']', '…', 18) AS snippet,
                bm25(search_index) AS score
         FROM search_index
         WHERE search_index MATCH ? AND project_id = ?
         ORDER BY score LIMIT ?`,
        sanitized,
        projectId,
        limit,
      )
      .map((r) => ({
        entityType: r.entity_type,
        entityId: r.entity_id,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
      }));
  } catch {
    return [];
  }
}

/** FTS5 treats many characters as operators; quote each term to keep it literal. */
export function toFtsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, '').trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t}"*`).join(' AND ');
}
