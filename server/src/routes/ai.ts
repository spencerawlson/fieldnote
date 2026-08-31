import type { FastifyInstance } from 'fastify';
import { commitStructure, structureProject } from '../ai/index.ts';
import { askAssistant } from '../ai/services/qa.ts';
import { classifyEvidence } from '../ai/services/evidence.ts';
import { explainCommands } from '../ai/services/elaborate.ts';
import { enqueueJob, audit, recordVersion } from '../db/repositories/system.ts';
import { getStep, listCommandsForStep, updateCommand } from '../db/repositories/steps.ts';
import { getClaim, getProblem, listClaims, updateClaim, deleteClaim, createClaim } from '../db/repositories/knowledge.ts';
import { getEvidence } from '../db/repositories/evidence.ts';
import { authorizeProject } from '../security/auth.ts';
import { parse, text, depthSchema, provenanceSchema, confidenceSchema, z } from '../lib/validate.ts';
import { notFound, badRequest } from '../lib/core.ts';
import { indexStep } from '../search/indexer.ts';

/**
 * AI routes.
 *
 * Long-running work is queued rather than awaited, so a slow model never holds
 * an HTTP connection open and a failure never loses what the user already
 * saved. Only the intake proposal and the assistant answer inline, because both
 * are interactive by nature.
 */

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  // --- intake -------------------------------------------------------------

  app.post(
    '/api/projects/:projectId/ai/structure',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request) => {
      const { projectId } = request.params as { projectId: string };
      const { db, user } = authorizeProject(request, projectId, 'editor');
      const body = parse(z.object({ notes: text(50_000, 1) }), request.body);

      const proposal = await structureProject(db, projectId, body.notes, { userId: user.id, db });
      audit(db, { projectId, userId: user.id, action: 'ai.structure', ip: request.ip, detail: { steps: proposal.steps.length } });
      return { proposal };
    },
  );

  app.post('/api/projects/:projectId/ai/structure/commit', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');

    const body = parse(
      z.object({
        proposal: z.object({
          steps: z
            .array(
              z.object({
                title: text(200, 1),
                userDescription: text(20_000),
                category: text(40),
                status: z.enum(['planned', 'in-progress', 'done', 'failed', 'skipped']).optional(),
                order: z.coerce.number().int(),
                occurredAt: z.string().nullable().optional(),
              }),
            )
            .min(1),
          problems: z
            .array(
              z.object({
                title: text(200, 1),
                symptoms: text(8000).nullable().optional(),
                relatedStepOrder: z.coerce.number().int().nullable().optional(),
                resolutionStepOrder: z.coerce.number().int().nullable().optional(),
                resolution: text(8000).nullable().optional(),
                status: z.string().optional(),
              }),
            )
            .default([]),
          suggestedTitle: z.string().nullable().optional(),
          suggestedObjective: z.string().nullable().optional(),
          domain: z.string().nullable().optional(),
        }),
        applyTitle: z.boolean().default(false),
        applyObjective: z.boolean().default(true),
        analyze: z.boolean().default(true),
      }),
      request.body,
    );

    const result = commitStructure(db, projectId, body.proposal as never, {
      applyTitle: body.applyTitle,
      applyObjective: body.applyObjective,
    });

    let jobId: string | null = null;
    if (body.analyze) {
      jobId = enqueueJob(db, { projectId, userId: user.id, type: 'project.analyze', payload: { projectId } }).id;
    }

    audit(db, { projectId, userId: user.id, action: 'ai.structure.commit', ip: request.ip, detail: { steps: result.stepIds.length } });
    return reply.code(201).send({ ...result, jobId });
  });

  // --- pipeline jobs ------------------------------------------------------

  app.post('/api/projects/:projectId/ai/analyze', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const body = parse(
      z.object({ depth: depthSchema.optional(), regenerate: z.boolean().default(false) }),
      request.body ?? {},
    );
    const job = enqueueJob(db, {
      projectId,
      userId: user.id,
      type: 'project.analyze',
      payload: { projectId, depth: body.depth, bypassCache: body.regenerate },
    });
    return reply.code(202).send({ job });
  });

  app.post('/api/projects/:projectId/ai/review', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const job = enqueueJob(db, { projectId, userId: user.id, type: 'project.review', payload: { projectId } });
    return reply.code(202).send({ job });
  });

  app.post('/api/projects/:projectId/steps/:stepId/ai/elaborate', async (request, reply) => {
    const { projectId, stepId } = request.params as { projectId: string; stepId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const step = getStep(db, stepId);
    if (!step || step.projectId !== projectId) throw notFound('Step');
    const body = parse(z.object({ depth: depthSchema.optional(), regenerate: z.boolean().default(true) }), request.body ?? {});

    const job = enqueueJob(db, {
      projectId,
      userId: user.id,
      type: 'step.elaborate',
      payload: { projectId, stepId, depth: body.depth, bypassCache: body.regenerate },
    });
    return reply.code(202).send({ job });
  });

  app.post('/api/projects/:projectId/problems/:problemId/ai/elaborate', async (request, reply) => {
    const { projectId, problemId } = request.params as { projectId: string; problemId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const problem = getProblem(db, problemId);
    if (!problem || problem.projectId !== projectId) throw notFound('Problem');
    const body = parse(z.object({ depth: depthSchema.optional(), regenerate: z.boolean().default(true) }), request.body ?? {});

    const job = enqueueJob(db, {
      projectId,
      userId: user.id,
      type: 'problem.elaborate',
      payload: { projectId, problemId, depth: body.depth, bypassCache: body.regenerate },
    });
    return reply.code(202).send({ job });
  });

  app.post('/api/projects/:projectId/evidence/:evidenceId/ai/analyze', async (request, reply) => {
    const { projectId, evidenceId } = request.params as { projectId: string; evidenceId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const evidence = getEvidence(db, evidenceId);
    if (!evidence || evidence.projectId !== projectId) throw notFound('Evidence');

    const job = enqueueJob(db, {
      projectId,
      userId: user.id,
      type: 'evidence.analyze',
      payload: { projectId, evidenceId, bypassCache: true },
    });
    return reply.code(202).send({ job });
  });

  app.post('/api/projects/:projectId/ai/link-evidence', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const body = parse(
      z.object({ evidenceIds: z.array(z.string()).optional(), apply: z.boolean().default(true) }),
      request.body ?? {},
    );
    const result = await classifyEvidence(db, projectId, body, { userId: user.id, db });
    return result;
  });

  app.post('/api/projects/:projectId/steps/:stepId/ai/explain-commands', async (request) => {
    const { projectId, stepId } = request.params as { projectId: string; stepId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const step = getStep(db, stepId);
    if (!step || step.projectId !== projectId) throw notFound('Step');

    const commands = listCommandsForStep(db, stepId);
    if (commands.length === 0) throw badRequest('This step has no commands to explain');

    const explanations = await explainCommands(
      db,
      projectId,
      commands.map((c) => ({ id: c.id, content: c.content, language: c.language })),
      { userId: user.id, db },
    );
    for (const item of explanations) updateCommand(db, item.id, { explanation: item.explanation });
    indexStep(db, projectId, stepId);
    return { commands: listCommandsForStep(db, stepId) };
  });

  // --- claims (human correction of AI output) -----------------------------

  app.get('/api/projects/:projectId/claims/:subjectType/:subjectId', async (request) => {
    const { projectId, subjectType, subjectId } = request.params as {
      projectId: string;
      subjectType: string;
      subjectId: string;
    };
    const { db } = authorizeProject(request, projectId);
    return { claims: listClaims(db, subjectType, subjectId) };
  });

  app.post('/api/projects/:projectId/claims', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const body = parse(
      z.object({
        subjectType: z.enum(['project', 'step', 'problem', 'evidence', 'test', 'result', 'command']),
        subjectId: z.string().min(3),
        slot: text(60, 1),
        text: text(20_000, 1),
        provenance: provenanceSchema.default('USER_FACT'),
        confidence: confidenceSchema.default('high'),
      }),
      request.body,
    );
    const claim = createClaim(db, { projectId, ...body, depth: 2 });
    updateClaim(db, claim.id, { editedByUser: true, accepted: 1 });
    return reply.code(201).send({ claim });
  });

  app.patch('/api/projects/:projectId/claims/:claimId', async (request) => {
    const { projectId, claimId } = request.params as { projectId: string; claimId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    // getClaim, not a scan of the project's own claims — the previous version
    // only ever found project-level claims, so edits to step and problem claims
    // were silently unversioned.
    const existing = getClaim(db, claimId);
    if (!existing || existing.projectId !== projectId) throw notFound('Claim');
    const body = parse(
      z.object({
        text: text(20_000, 1).optional(),
        provenance: provenanceSchema.optional(),
        confidence: confidenceSchema.optional(),
        accepted: z.boolean().optional(),
      }),
      request.body,
    );

    const patch: Record<string, unknown> = { ...body };
    if (body.accepted !== undefined) patch.accepted = body.accepted ? 1 : 0;
    // Any human edit pins the claim so regeneration will not discard it.
    if (body.text !== undefined) patch.editedByUser = true;

    recordVersion(db, {
      projectId,
      entityType: 'claim',
      entityId: claimId,
      actorType: 'user',
      actorId: user.id,
      reason: 'edit',
      snapshot: existing,
    });
    const claim = updateClaim(db, claimId, patch)!;
    if (claim.subjectType === 'step') indexStep(db, projectId, claim.subjectId);
    return { claim };
  });

  app.delete('/api/projects/:projectId/claims/:claimId', async (request) => {
    const { projectId, claimId } = request.params as { projectId: string; claimId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    deleteClaim(db, claimId);
    return { ok: true };
  });

  // --- assistant ----------------------------------------------------------

  app.post(
    '/api/projects/:projectId/ai/ask',
    { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } },
    async (request) => {
      const { projectId } = request.params as { projectId: string };
      const { db, user } = authorizeProject(request, projectId);
      const body = parse(z.object({ question: text(4000, 1) }), request.body);
      return askAssistant(db, projectId, body.question, { userId: user.id, db });
    },
  );
}
