import type { FastifyInstance } from 'fastify';
import {
  createCommand,
  createStep,
  deleteCommand,
  deleteStep,
  getStep,
  linkSteps,
  listCommandsForStep,
  listStepLinks,
  listSteps,
  reorderSteps,
  updateCommand,
  updateStep,
} from '../db/repositories/steps.ts';
import {
  createInvestigation,
  createProblem,
  createResolution,
  createRef,
  createResult,
  createTest,
  deleteInvestigation,
  deleteProblem,
  deleteRef,
  deleteResolution,
  deleteResult,
  deleteTest,
  getProblem,
  listClaims,
  listInvestigations,
  listProblems,
  listRefs,
  listResolutions,
  listResults,
  listTests,
  updateProblem,
  updateResolution,
  updateResult,
  updateTest,
} from '../db/repositories/knowledge.ts';
import { listLinksForTarget } from '../db/repositories/evidence.ts';
import { audit, recordVersion } from '../db/repositories/system.ts';
import { indexProblem, indexStep } from '../search/indexer.ts';
import { authorizeProject } from '../security/auth.ts';
import { parse, text, optionalText, z } from '../lib/validate.ts';
import { notFound } from '../lib/core.ts';
import { STEP_CATEGORIES } from '../domain/types.ts';

const categorySchema = z.union([z.enum(STEP_CATEGORIES), text(40, 1)]);

const stepSchema = z.object({
  title: text(200, 1),
  userDescription: text(20000).default(''),
  category: categorySchema.default('other'),
  status: z.enum(['planned', 'in-progress', 'done', 'failed', 'skipped']).default('done'),
  occurredAt: z.string().datetime().nullable().optional(),
  configuration: optionalText(20000),
  expectedResult: optionalText(4000),
  actualResult: optionalText(4000),
  validation: optionalText(4000),
});

const stepPatchSchema = stepSchema.partial();

const commandSchema = z.object({
  language: text(30).default('bash'),
  content: text(20000, 1),
  output: optionalText(20000),
  position: z.coerce.number().int().min(0).optional(),
});

export async function workRoutes(app: FastifyInstance): Promise<void> {
  // --- steps --------------------------------------------------------------

  app.get('/api/projects/:projectId/steps', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    const steps = listSteps(db, projectId);
    return {
      steps: steps.map((step) => ({
        ...step,
        commands: listCommandsForStep(db, step.id),
        claims: listClaims(db, 'step', step.id),
        evidenceLinks: listLinksForTarget(db, 'step', step.id),
      })),
      links: listStepLinks(db, projectId),
    };
  });

  app.post('/api/projects/:projectId/steps', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const body = parse(stepSchema, request.body);
    const step = createStep(db, { projectId, ...body });
    indexStep(db, projectId, step.id);
    audit(db, { projectId, userId: user.id, action: 'step.create', entityType: 'step', entityId: step.id, ip: request.ip });
    return reply.code(201).send({ step });
  });

  app.get('/api/projects/:projectId/steps/:stepId', async (request) => {
    const { projectId, stepId } = request.params as { projectId: string; stepId: string };
    const { db } = authorizeProject(request, projectId);
    const step = getStep(db, stepId);
    if (!step || step.projectId !== projectId) throw notFound('Step');
    return {
      step,
      commands: listCommandsForStep(db, stepId),
      claims: listClaims(db, 'step', stepId),
      evidenceLinks: listLinksForTarget(db, 'step', stepId),
    };
  });

  app.patch('/api/projects/:projectId/steps/:stepId', async (request) => {
    const { projectId, stepId } = request.params as { projectId: string; stepId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const existing = getStep(db, stepId);
    if (!existing || existing.projectId !== projectId) throw notFound('Step');
    const body = parse(stepPatchSchema, request.body);

    recordVersion(db, { projectId, entityType: 'step', entityId: stepId, actorType: 'user', actorId: user.id, reason: 'edit', snapshot: existing });
    const step = updateStep(db, stepId, body);
    indexStep(db, projectId, stepId);
    audit(db, { projectId, userId: user.id, action: 'step.update', entityType: 'step', entityId: stepId, ip: request.ip });
    return { step };
  });

  app.delete('/api/projects/:projectId/steps/:stepId', async (request) => {
    const { projectId, stepId } = request.params as { projectId: string; stepId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const existing = getStep(db, stepId);
    if (!existing || existing.projectId !== projectId) throw notFound('Step');
    recordVersion(db, { projectId, entityType: 'step', entityId: stepId, actorType: 'user', actorId: user.id, reason: 'delete', snapshot: existing });
    deleteStep(db, stepId);
    indexStep(db, projectId, stepId);
    return { ok: true };
  });

  app.post('/api/projects/:projectId/steps/reorder', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const body = parse(z.object({ orderedIds: z.array(z.string()).min(1) }), request.body);
    reorderSteps(db, projectId, body.orderedIds);
    return { steps: listSteps(db, projectId) };
  });

  app.post('/api/projects/:projectId/steps/:stepId/links', async (request) => {
    const { projectId, stepId } = request.params as { projectId: string; stepId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const body = parse(
      z.object({ toStepId: z.string(), relation: z.enum(['depends-on', 'follows', 'relates-to', 'supersedes']) }),
      request.body,
    );
    const target = getStep(db, body.toStepId);
    if (!target || target.projectId !== projectId) throw notFound('Target step');
    linkSteps(db, stepId, body.toStepId, body.relation, 'user');
    return { links: listStepLinks(db, projectId) };
  });

  // --- commands -----------------------------------------------------------

  app.post('/api/projects/:projectId/steps/:stepId/commands', async (request, reply) => {
    const { projectId, stepId } = request.params as { projectId: string; stepId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const step = getStep(db, stepId);
    if (!step || step.projectId !== projectId) throw notFound('Step');
    const body = parse(commandSchema, request.body);
    const command = createCommand(db, { projectId, stepId, ...body });
    indexStep(db, projectId, stepId);
    return reply.code(201).send({ command });
  });

  app.patch('/api/projects/:projectId/commands/:commandId', async (request) => {
    const { projectId, commandId } = request.params as { projectId: string; commandId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const body = parse(commandSchema.partial().extend({ explanation: optionalText(4000) }), request.body);
    const command = updateCommand(db, commandId, body);
    if (!command || command.projectId !== projectId) throw notFound('Command');
    if (command.stepId) indexStep(db, projectId, command.stepId);
    return { command };
  });

  app.delete('/api/projects/:projectId/commands/:commandId', async (request) => {
    const { projectId, commandId } = request.params as { projectId: string; commandId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    deleteCommand(db, commandId);
    return { ok: true };
  });

  // --- problems -----------------------------------------------------------

  const problemSchema = z.object({
    title: text(200, 1),
    stepId: z.string().nullable().optional(),
    symptoms: optionalText(8000),
    impact: optionalText(4000),
    hypothesis: optionalText(4000),
    rootCause: optionalText(4000),
    status: z.enum(['open', 'investigating', 'resolved', 'unresolved', 'wont-fix']).optional(),
    detectedAt: z.string().datetime().nullable().optional(),
    resolvedAt: z.string().datetime().nullable().optional(),
  });

  app.get('/api/projects/:projectId/problems', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    return {
      problems: listProblems(db, projectId).map((problem) => ({
        ...problem,
        investigations: listInvestigations(db, problem.id),
        resolutions: listResolutions(db, problem.id),
        claims: listClaims(db, 'problem', problem.id),
        evidenceLinks: listLinksForTarget(db, 'problem', problem.id),
      })),
    };
  });

  app.post('/api/projects/:projectId/problems', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const body = parse(problemSchema, request.body);
    const problem = createProblem(db, { projectId, ...body });
    indexProblem(db, projectId, problem.id);
    audit(db, { projectId, userId: user.id, action: 'problem.create', entityType: 'problem', entityId: problem.id, ip: request.ip });
    return reply.code(201).send({ problem });
  });

  app.patch('/api/projects/:projectId/problems/:problemId', async (request) => {
    const { projectId, problemId } = request.params as { projectId: string; problemId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const existing = getProblem(db, problemId);
    if (!existing || existing.projectId !== projectId) throw notFound('Problem');
    const body = parse(problemSchema.partial(), request.body);

    recordVersion(db, { projectId, entityType: 'problem', entityId: problemId, actorType: 'user', actorId: user.id, reason: 'edit', snapshot: existing });
    // A root cause the user writes themselves is a fact, not an inference.
    const patch: Record<string, unknown> = { ...body };
    if (body.rootCause !== undefined && body.rootCause !== existing.rootCause) {
      patch.rootCauseProvenance = 'USER_FACT';
      patch.rootCauseConfidence = 'high';
    }
    const problem = updateProblem(db, problemId, patch);
    indexProblem(db, projectId, problemId);
    return { problem };
  });

  app.delete('/api/projects/:projectId/problems/:problemId', async (request) => {
    const { projectId, problemId } = request.params as { projectId: string; problemId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    deleteProblem(db, problemId);
    return { ok: true };
  });

  app.post('/api/projects/:projectId/problems/:problemId/investigations', async (request, reply) => {
    const { projectId, problemId } = request.params as { projectId: string; problemId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const problem = getProblem(db, problemId);
    if (!problem || problem.projectId !== projectId) throw notFound('Problem');
    const body = parse(
      z.object({ action: text(4000, 1), finding: optionalText(4000), tool: optionalText(120) }),
      request.body,
    );
    const investigation = createInvestigation(db, { problemId, ...body });
    indexProblem(db, projectId, problemId);
    return reply.code(201).send({ investigation });
  });

  app.delete('/api/projects/:projectId/investigations/:investigationId', async (request) => {
    const { projectId, investigationId } = request.params as { projectId: string; investigationId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    deleteInvestigation(db, investigationId);
    return { ok: true };
  });

  app.post('/api/projects/:projectId/problems/:problemId/resolutions', async (request, reply) => {
    const { projectId, problemId } = request.params as { projectId: string; problemId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const problem = getProblem(db, problemId);
    if (!problem || problem.projectId !== projectId) throw notFound('Problem');
    const body = parse(
      z.object({ description: text(8000, 1), validation: optionalText(4000), validated: z.boolean().optional() }),
      request.body,
    );
    const resolution = createResolution(db, { problemId, ...body });
    indexProblem(db, projectId, problemId);
    return reply.code(201).send({ resolution });
  });

  app.patch('/api/projects/:projectId/resolutions/:resolutionId', async (request) => {
    const { projectId, resolutionId } = request.params as { projectId: string; resolutionId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const body = parse(
      z.object({ description: text(8000, 1).optional(), validation: optionalText(4000), validated: z.boolean().optional() }),
      request.body,
    );
    return { resolution: updateResolution(db, resolutionId, body) };
  });

  app.delete('/api/projects/:projectId/resolutions/:resolutionId', async (request) => {
    const { projectId, resolutionId } = request.params as { projectId: string; resolutionId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    deleteResolution(db, resolutionId);
    return { ok: true };
  });

  // --- tests, results, references -----------------------------------------

  const testSchema = z.object({
    name: text(200, 1),
    stepId: z.string().nullable().optional(),
    method: optionalText(4000),
    expected: optionalText(4000),
    observed: optionalText(4000),
    outcome: z.enum(['pass', 'fail', 'partial', 'untested']).optional(),
    performedAt: z.string().datetime().nullable().optional(),
  });

  app.get('/api/projects/:projectId/tests', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    return {
      tests: listTests(db, projectId).map((test) => ({ ...test, evidenceLinks: listLinksForTarget(db, 'test', test.id) })),
    };
  });

  app.post('/api/projects/:projectId/tests', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const body = parse(testSchema, request.body);
    return reply.code(201).send({ test: createTest(db, { projectId, ...body }) });
  });

  app.patch('/api/projects/:projectId/tests/:testId', async (request) => {
    const { projectId, testId } = request.params as { projectId: string; testId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    return { test: updateTest(db, testId, parse(testSchema.partial(), request.body)) };
  });

  app.delete('/api/projects/:projectId/tests/:testId', async (request) => {
    const { projectId, testId } = request.params as { projectId: string; testId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    deleteTest(db, testId);
    return { ok: true };
  });

  const resultSchema = z.object({
    title: text(200, 1),
    detail: optionalText(8000),
    metric: optionalText(120),
    value: optionalText(200),
  });

  app.get('/api/projects/:projectId/results', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    return { results: listResults(db, projectId), references: listRefs(db, projectId) };
  });

  app.post('/api/projects/:projectId/results', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const body = parse(resultSchema, request.body);
    return reply.code(201).send({ result: createResult(db, { projectId, ...body, provenance: 'USER_FACT' }) });
  });

  app.patch('/api/projects/:projectId/results/:resultId', async (request) => {
    const { projectId, resultId } = request.params as { projectId: string; resultId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    return { result: updateResult(db, resultId, parse(resultSchema.partial(), request.body)) };
  });

  app.delete('/api/projects/:projectId/results/:resultId', async (request) => {
    const { projectId, resultId } = request.params as { projectId: string; resultId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    deleteResult(db, resultId);
    return { ok: true };
  });

  app.post('/api/projects/:projectId/references', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const body = parse(
      z.object({ label: text(300, 1), url: z.string().url().max(2000).nullable().optional(), detail: optionalText(1000) }),
      request.body,
    );
    return reply.code(201).send({ reference: createRef(db, { projectId, ...body }) });
  });

  app.delete('/api/projects/:projectId/references/:refId', async (request) => {
    const { projectId, refId } = request.params as { projectId: string; refId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    deleteRef(db, refId);
    return { ok: true };
  });
}
