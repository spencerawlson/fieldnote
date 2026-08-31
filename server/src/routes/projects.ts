import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.ts';
import {
  createProject,
  listProjectsForUser,
  softDeleteProject,
  updateProject,
  listMembers,
  addMember,
} from '../db/repositories/projects.ts';
import {
  audit,
  getUserByEmail,
  listAudit,
  listProjectVersions,
  listVersions,
  getVersion,
  recordVersion,
  searchProject,
  usageSummary,
} from '../db/repositories/system.ts';
import { listSteps } from '../db/repositories/steps.ts';
import { listEvidence, listSecretFindings, acknowledgeSecretFinding } from '../db/repositories/evidence.ts';
import { listInsights, listProblems, setInsightState, listResults, listTests } from '../db/repositories/knowledge.ts';
import { listPresentations, listReports } from '../db/repositories/outputs.ts';
import { computeCompleteness } from '../ai/services/consistency.ts';
import { indexProject } from '../search/indexer.ts';
import { authorizeProject, requireUser } from '../security/auth.ts';
import { parse, text, optionalText, depthSchema, z } from '../lib/validate.ts';
import { notFound, badRequest } from '../lib/core.ts';
import { TONES } from '../domain/types.ts';

const createSchema = z.object({
  title: text(200, 1),
  summary: optionalText(500),
  objective: optionalText(2000),
  domain: optionalText(80),
  tone: z.enum(TONES).optional(),
  audience: text(60).optional(),
  elaborationDepth: depthSchema.optional(),
});

const updateSchema = z.object({
  title: text(200, 1).optional(),
  summary: optionalText(500),
  objective: optionalText(4000),
  scope: optionalText(4000),
  requirements: optionalText(8000),
  environment: optionalText(8000),
  architecture: optionalText(8000),
  conclusion: optionalText(8000),
  domain: optionalText(80),
  status: z.enum(['draft', 'active', 'complete', 'archived']).optional(),
  tone: z.enum(TONES).optional(),
  audience: text(60).optional(),
  elaborationDepth: depthSchema.optional(),
  startedAt: z.string().datetime().optional().nullable(),
  endedAt: z.string().datetime().optional().nullable(),
});

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', async (request) => {
    const user = requireUser(request);
    const db = getDb();
    const projects = listProjectsForUser(db, user.id);
    return {
      projects: projects.map((project) => {
        const steps = listSteps(db, project.id);
        const evidence = listEvidence(db, project.id);
        const problems = listProblems(db, project.id);
        return {
          ...project,
          counts: {
            steps: steps.length,
            evidence: evidence.length,
            problems: problems.length,
            openProblems: problems.filter((p) => p.status !== 'resolved' && p.status !== 'wont-fix').length,
            reports: listReports(db, project.id).length,
            presentations: listPresentations(db, project.id).length,
          },
          completeness: computeCompleteness(db, project.id).percent,
        };
      }),
    };
  });

  app.post('/api/projects', async (request, reply) => {
    const user = requireUser(request);
    const body = parse(createSchema, request.body);
    const db = getDb();
    const project = createProject(db, { ownerId: user.id, ...body });
    indexProject(db, project.id);
    audit(db, { projectId: project.id, userId: user.id, action: 'project.create', entityType: 'project', entityId: project.id, ip: request.ip });
    return reply.code(201).send({ project });
  });

  app.get('/api/projects/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { project, role, db } = authorizeProject(request, projectId);
    return {
      project,
      role,
      completeness: computeCompleteness(db, projectId),
      counts: {
        steps: listSteps(db, projectId).length,
        evidence: listEvidence(db, projectId).length,
        problems: listProblems(db, projectId).length,
        tests: listTests(db, projectId).length,
        results: listResults(db, projectId).length,
      },
      openInsights: listInsights(db, projectId, { state: 'open' }).length,
      sensitiveFindings: listSecretFindings(db, projectId).filter((f) => !(f as { acknowledged: boolean }).acknowledged).length,
    };
  });

  app.patch('/api/projects/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { project, user, db } = authorizeProject(request, projectId, 'editor');
    const body = parse(updateSchema, request.body);

    recordVersion(db, {
      projectId,
      entityType: 'project',
      entityId: projectId,
      actorType: 'user',
      actorId: user.id,
      reason: 'edit',
      snapshot: project,
    });

    const updated = updateProject(db, projectId, body);
    indexProject(db, projectId);
    audit(db, { projectId, userId: user.id, action: 'project.update', entityType: 'project', entityId: projectId, ip: request.ip, detail: { fields: Object.keys(body) } });
    return { project: updated };
  });

  app.delete('/api/projects/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { user, db } = authorizeProject(request, projectId, 'owner');
    softDeleteProject(db, projectId);
    audit(db, { projectId, userId: user.id, action: 'project.delete', entityType: 'project', entityId: projectId, ip: request.ip });
    return { ok: true };
  });

  // --- members ------------------------------------------------------------

  app.get('/api/projects/:projectId/members', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    return { members: listMembers(db, projectId) };
  });

  app.post('/api/projects/:projectId/members', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db, user } = authorizeProject(request, projectId, 'owner');
    const body = parse(z.object({ email: z.string().email(), role: z.enum(['editor', 'viewer']) }), request.body);
    const target = getUserByEmail(db, body.email);
    if (!target) throw notFound('User');
    addMember(db, projectId, target.id, body.role);
    audit(db, { projectId, userId: user.id, action: 'project.member.add', entityId: target.id, ip: request.ip, detail: { role: body.role } });
    return { members: listMembers(db, projectId) };
  });

  // --- timeline -----------------------------------------------------------

  app.get('/api/projects/:projectId/timeline', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);

    const events = [
      ...listSteps(db, projectId).map((step) => ({
        type: 'step' as const,
        id: step.id,
        at: step.occurredAt ?? step.createdAt,
        hasExplicitTime: Boolean(step.occurredAt),
        title: step.title,
        detail: step.userDescription,
        category: step.category,
        status: step.status,
        position: step.position,
      })),
      ...listProblems(db, projectId).map((problem) => ({
        type: 'problem' as const,
        id: problem.id,
        at: problem.detectedAt ?? problem.createdAt,
        hasExplicitTime: Boolean(problem.detectedAt),
        title: problem.title,
        detail: problem.symptoms ?? '',
        category: 'troubleshooting',
        status: problem.status,
        position: problem.position,
      })),
    ];

    // Steps carry an explicit order; timestamps are advisory and often absent,
    // so ordering falls back to the author's sequence rather than to createdAt.
    events.sort((a, b) => {
      if (a.hasExplicitTime && b.hasExplicitTime) return a.at.localeCompare(b.at);
      return a.position - b.position || a.at.localeCompare(b.at);
    });

    return { events };
  });

  // --- search -------------------------------------------------------------

  app.get('/api/projects/:projectId/search', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    const query = parse(z.object({ q: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(100).default(30) }), request.query);
    return { query: query.q, hits: searchProject(db, projectId, query.q, query.limit) };
  });

  app.post('/api/projects/:projectId/reindex', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    indexProject(db, projectId);
    return { ok: true };
  });

  // --- insights, completeness, privacy ------------------------------------

  app.get('/api/projects/:projectId/insights', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    const query = parse(
      z.object({ scope: z.enum(['project', 'presentation', 'report']).optional(), scopeId: z.string().optional(), state: z.string().optional() }),
      request.query,
    );
    return { insights: listInsights(db, projectId, query) };
  });

  app.patch('/api/projects/:projectId/insights/:insightId', async (request) => {
    const { projectId, insightId } = request.params as { projectId: string; insightId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const body = parse(z.object({ state: z.enum(['open', 'accepted', 'dismissed', 'resolved']) }), request.body);
    const insight = setInsightState(db, insightId, body.state);
    if (!insight || insight.projectId !== projectId) throw notFound('Insight');
    return { insight };
  });

  app.get('/api/projects/:projectId/completeness', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    return computeCompleteness(db, projectId);
  });

  app.get('/api/projects/:projectId/privacy', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    return { findings: listSecretFindings(db, projectId) };
  });

  app.post('/api/projects/:projectId/privacy/:findingId/acknowledge', async (request) => {
    const { projectId, findingId } = request.params as { projectId: string; findingId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    acknowledgeSecretFinding(db, findingId);
    return { findings: listSecretFindings(db, projectId) };
  });

  // --- versions and audit -------------------------------------------------

  app.get('/api/projects/:projectId/versions', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    const query = parse(z.object({ entityType: z.string().optional(), entityId: z.string().optional() }), request.query);
    const versions =
      query.entityType && query.entityId
        ? listVersions(db, query.entityType, query.entityId)
        : listProjectVersions(db, projectId);
    return { versions };
  });

  app.post('/api/projects/:projectId/versions/:versionId/restore', async (request) => {
    const { projectId, versionId } = request.params as { projectId: string; versionId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const version = getVersion(db, versionId);
    if (!version || version.projectId !== projectId) throw notFound('Version');
    if (version.entityType !== 'project') {
      throw badRequest('Restore for this entity type is handled by its own endpoint');
    }

    const snapshot = version.snapshot as Record<string, unknown>;
    // Snapshot the current state first, so restoring is itself undoable.
    recordVersion(db, {
      projectId,
      entityType: 'project',
      entityId: projectId,
      actorType: 'user',
      actorId: user.id,
      reason: `restore to revision ${version.revision}`,
      snapshot: authorizeProject(request, projectId).project,
    });
    const restored = updateProject(db, projectId, {
      title: snapshot.title,
      summary: snapshot.summary,
      objective: snapshot.objective,
      scope: snapshot.scope,
      requirements: snapshot.requirements,
      environment: snapshot.environment,
      architecture: snapshot.architecture,
      conclusion: snapshot.conclusion,
      status: snapshot.status,
      tone: snapshot.tone,
      audience: snapshot.audience,
      elaborationDepth: snapshot.elaborationDepth,
    });
    indexProject(db, projectId);
    return { project: restored };
  });

  app.get('/api/projects/:projectId/activity', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    return { activity: listAudit(db, projectId, 100) };
  });

  app.get('/api/projects/:projectId/usage', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    return usageSummary(db, projectId);
  });
}
