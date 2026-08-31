import type { Database } from '../index.ts';
import { mapRow, mapRows, buildUpdate } from '../mapper.ts';
import { newId, nowIso } from '../../lib/core.ts';
import type { ProjectRecord } from '../../domain/types.ts';

const SPEC = { json: { settings: {} } };

const COLUMNS: Record<string, string> = {
  title: 'title',
  summary: 'summary',
  objective: 'objective',
  scope: 'scope',
  requirements: 'requirements',
  environment: 'environment',
  architecture: 'architecture',
  conclusion: 'conclusion',
  status: 'status',
  domain: 'domain',
  elaborationDepth: 'elaboration_depth',
  tone: 'tone',
  audience: 'audience',
  voice: 'voice',
  settings: 'settings_json',
  startedAt: 'started_at',
  endedAt: 'ended_at',
};

export interface CreateProjectInput {
  ownerId: string;
  title: string;
  summary?: string | null;
  objective?: string | null;
  domain?: string | null;
  tone?: string;
  audience?: string;
  voice?: string;
  elaborationDepth?: number;
}

export function createProject(db: Database, input: CreateProjectInput): ProjectRecord {
  const id = newId('project');
  const now = nowIso();
  db.tx(() => {
    db.run(
      `INSERT INTO projects (id, owner_id, title, summary, objective, domain, tone, audience,
        voice, elaboration_depth, status, settings_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.ownerId,
      input.title,
      input.summary ?? null,
      input.objective ?? null,
      input.domain ?? null,
      input.tone ?? 'technical',
      input.audience ?? 'technical-team',
      input.voice ?? 'first-person',
      input.elaborationDepth ?? 2,
      'draft',
      '{}',
      now,
      now,
    );
    db.run(
      'INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?,?,?,?)',
      id,
      input.ownerId,
      'owner',
      now,
    );
  });
  return getProject(db, id)!;
}

export function getProject(db: Database, id: string): ProjectRecord | undefined {
  return mapRow<ProjectRecord>(
    db.get('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL', id),
    SPEC,
  );
}

export function listProjectsForUser(db: Database, userId: string, limit = 100): ProjectRecord[] {
  return mapRows<ProjectRecord>(
    db.all(
      `SELECT p.* FROM projects p
       JOIN project_members m ON m.project_id = p.id
       WHERE m.user_id = ? AND p.deleted_at IS NULL
       ORDER BY p.updated_at DESC LIMIT ?`,
      userId,
      limit,
    ),
    SPEC,
  );
}

export function updateProject(
  db: Database,
  id: string,
  patch: Partial<Record<keyof typeof COLUMNS, unknown>>,
): ProjectRecord | undefined {
  const { sql, params } = buildUpdate(patch as Record<string, unknown>, COLUMNS);
  if (sql) {
    db.run(`UPDATE projects SET ${sql}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  }
  return getProject(db, id);
}

export function touchProject(db: Database, id: string): void {
  db.run('UPDATE projects SET updated_at = ? WHERE id = ?', nowIso(), id);
}

export function softDeleteProject(db: Database, id: string): void {
  db.run('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
}

// --- membership / authorization ------------------------------------------

export type MemberRole = 'owner' | 'editor' | 'viewer';

export function getMemberRole(db: Database, projectId: string, userId: string): MemberRole | null {
  const row = db.get<{ role: MemberRole }>(
    'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    userId,
  );
  return row?.role ?? null;
}

export function addMember(db: Database, projectId: string, userId: string, role: MemberRole): void {
  db.run(
    `INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?,?,?,?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
    projectId,
    userId,
    role,
    nowIso(),
  );
}

export function listMembers(db: Database, projectId: string) {
  return db.all(
    `SELECT m.user_id AS userId, m.role, u.name, u.email
     FROM project_members m JOIN users u ON u.id = m.user_id
     WHERE m.project_id = ? ORDER BY m.created_at`,
    projectId,
  );
}
