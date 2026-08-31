import { registerHandler, type JobContext } from './worker.ts';
import {
  analyzeImage,
  analyzeProject,
  classifyEvidence,
  elaborateProblem,
  elaborateProject,
  elaborateStep,
  generatePresentation,
  generateQuestions,
  generateReport,
  generateSpeakerNotes,
  reviewPresentation,
  runOcr,
} from '../ai/index.ts';
import { listEvidence } from '../db/repositories/evidence.ts';
import { listSteps } from '../db/repositories/steps.ts';
import { listProblems } from '../db/repositories/knowledge.ts';
import { indexProject, indexStep } from '../search/indexer.ts';
import { renderExport } from '../export/render.ts';
import { logger } from '../lib/logger.ts';

/**
 * Job handlers.
 *
 * Long operations run here rather than in a request so the UI never blocks and
 * a failed AI call never loses the user's work: the underlying records are
 * already saved before any job is queued.
 */

interface Payload {
  projectId?: string;
  evidenceId?: string;
  stepId?: string;
  problemId?: string;
  reportId?: string;
  presentationId?: string;
  exportId?: string;
  depth?: number;
  bypassCache?: boolean;
  count?: number;
  runOcr?: boolean;
}

function payloadOf(ctx: JobContext): Payload {
  return ctx.job.payload as Payload;
}

// --- evidence -------------------------------------------------------------

registerHandler('evidence.analyze', async (ctx) => {
  const { evidenceId, projectId, bypassCache } = payloadOf(ctx);
  if (!evidenceId || !projectId) throw new Error('evidence.analyze requires evidenceId and projectId');
  const callCtx = { userId: ctx.job.userId, db: ctx.db };

  ctx.progress(0, 2, 'Analysing image');
  const analysis = await analyzeImage(ctx.db, projectId, evidenceId, callCtx, { bypassCache });

  ctx.progress(1, 2, 'Extracting text');
  // The vision pass usually returns a transcription already; only run a
  // separate OCR call when it did not.
  let ocrText = analysis.ocrText ?? '';
  if (!ocrText.trim()) {
    const ocr = await runOcr(ctx.db, projectId, evidenceId, callCtx).catch((error) => {
      logger.warn({ evidenceId, error: (error as Error).message }, 'OCR failed; keeping the vision analysis');
      return null;
    });
    ocrText = ocr?.text ?? '';
  }

  ctx.progress(2, 2, 'Done');
  return { evidenceId, description: analysis.description, ocrChars: ocrText.length, confidence: analysis.confidence };
});

registerHandler('evidence.classify', async (ctx) => {
  const { projectId } = payloadOf(ctx);
  if (!projectId) throw new Error('evidence.classify requires projectId');
  ctx.log('Matching evidence to steps and problems');
  const result = await classifyEvidence(ctx.db, projectId, { apply: true }, { userId: ctx.job.userId, db: ctx.db });
  return { linked: result.applied, unmatched: result.unmatched.length };
});

// --- elaboration ----------------------------------------------------------

registerHandler('step.elaborate', async (ctx) => {
  const { projectId, stepId, depth, bypassCache } = payloadOf(ctx);
  if (!projectId || !stepId) throw new Error('step.elaborate requires projectId and stepId');
  const result = await elaborateStep(
    ctx.db,
    projectId,
    stepId,
    { userId: ctx.job.userId, db: ctx.db },
    { depth, bypassCache },
  );
  indexStep(ctx.db, projectId, stepId);
  return result;
});

registerHandler('problem.elaborate', async (ctx) => {
  const { projectId, problemId, depth, bypassCache } = payloadOf(ctx);
  if (!projectId || !problemId) throw new Error('problem.elaborate requires projectId and problemId');
  return elaborateProblem(ctx.db, projectId, problemId, { userId: ctx.job.userId, db: ctx.db }, { depth, bypassCache });
});

/**
 * The full pipeline: analyse every piece of evidence, link it, elaborate every
 * step and problem, then review the project as a whole. This is what the
 * "Analyse project" button runs.
 */
registerHandler('project.analyze', async (ctx) => {
  const { projectId, depth, bypassCache } = payloadOf(ctx);
  if (!projectId) throw new Error('project.analyze requires projectId');
  const callCtx = { userId: ctx.job.userId, db: ctx.db };

  const evidence = listEvidence(ctx.db, projectId).filter(
    (e) => e.reviewState === 'unreviewed' || bypassCache,
  );
  const steps = listSteps(ctx.db, projectId).filter((s) => s.aiState !== 'elaborated' || bypassCache);
  const problems = listProblems(ctx.db, projectId).filter((p) => p.aiState !== 'elaborated' || bypassCache);
  const total = evidence.length + steps.length + problems.length + 2;
  let done = 0;

  const failures: string[] = [];

  for (const item of evidence) {
    ctx.progress(done, total, `Analysing evidence ${done + 1} of ${evidence.length}`);
    try {
      await analyzeImage(ctx.db, projectId, item.id, callCtx, { bypassCache });
    } catch (error) {
      // One bad screenshot must not abort the run.
      failures.push(`evidence ${item.id}: ${(error as Error).message}`);
      logger.warn({ evidenceId: item.id, error: (error as Error).message }, 'Evidence analysis failed');
    }
    done += 1;
  }

  ctx.progress(done, total, 'Linking evidence to steps and problems');
  try {
    await classifyEvidence(ctx.db, projectId, { apply: true }, callCtx);
  } catch (error) {
    failures.push(`evidence linking: ${(error as Error).message}`);
  }
  done += 1;

  for (const step of steps) {
    ctx.progress(done, total, `Elaborating step: ${step.title}`);
    try {
      await elaborateStep(ctx.db, projectId, step.id, callCtx, { depth, bypassCache });
      indexStep(ctx.db, projectId, step.id);
    } catch (error) {
      failures.push(`step ${step.id}: ${(error as Error).message}`);
    }
    done += 1;
  }

  for (const problem of problems) {
    ctx.progress(done, total, `Analysing problem: ${problem.title}`);
    try {
      await elaborateProblem(ctx.db, projectId, problem.id, callCtx, { depth, bypassCache });
    } catch (error) {
      failures.push(`problem ${problem.id}: ${(error as Error).message}`);
    }
    done += 1;
  }

  ctx.progress(done, total, 'Reviewing the project for gaps');
  try {
    await elaborateProject(ctx.db, projectId, callCtx, { depth });
    await analyzeProject(ctx.db, projectId, callCtx);
  } catch (error) {
    failures.push(`project review: ${(error as Error).message}`);
  }
  done += 1;

  indexProject(ctx.db, projectId);
  ctx.progress(total, total, 'Analysis complete');

  return {
    evidenceAnalyzed: evidence.length,
    stepsElaborated: steps.length,
    problemsAnalyzed: problems.length,
    failures,
  };
});

registerHandler('project.review', async (ctx) => {
  const { projectId } = payloadOf(ctx);
  if (!projectId) throw new Error('project.review requires projectId');
  const insights = await analyzeProject(ctx.db, projectId, { userId: ctx.job.userId, db: ctx.db });
  return { insights: insights.length };
});

// --- outputs --------------------------------------------------------------

registerHandler('report.generate', async (ctx) => {
  const { projectId, reportId } = payloadOf(ctx);
  if (!projectId || !reportId) throw new Error('report.generate requires projectId and reportId');
  ctx.progress(0, 1, 'Writing the report');
  const result = await generateReport(ctx.db, projectId, reportId, { userId: ctx.job.userId, db: ctx.db });
  ctx.progress(1, 1, 'Report ready');
  return result;
});

registerHandler('presentation.generate', async (ctx) => {
  const { projectId, presentationId } = payloadOf(ctx);
  if (!projectId || !presentationId) throw new Error('presentation.generate requires projectId and presentationId');
  const callCtx = { userId: ctx.job.userId, db: ctx.db };

  ctx.progress(0, 3, 'Building the slide narrative');
  const deck = await generatePresentation(ctx.db, projectId, presentationId, callCtx);

  ctx.progress(1, 3, 'Reviewing the deck');
  const insights = await reviewPresentation(ctx.db, projectId, presentationId, callCtx).catch(() => []);

  ctx.progress(3, 3, 'Presentation ready');
  return { ...deck, insights: insights.length };
});

registerHandler('presentation.notes', async (ctx) => {
  const { projectId, presentationId } = payloadOf(ctx);
  if (!projectId || !presentationId) throw new Error('presentation.notes requires projectId and presentationId');
  const updated = await generateSpeakerNotes(ctx.db, projectId, presentationId, { userId: ctx.job.userId, db: ctx.db });
  return { updated };
});

registerHandler('presentation.review', async (ctx) => {
  const { projectId, presentationId } = payloadOf(ctx);
  if (!projectId || !presentationId) throw new Error('presentation.review requires projectId and presentationId');
  const insights = await reviewPresentation(ctx.db, projectId, presentationId, { userId: ctx.job.userId, db: ctx.db });
  return { insights: insights.length };
});

registerHandler('qa.generate', async (ctx) => {
  const { projectId, presentationId, count } = payloadOf(ctx);
  if (!projectId) throw new Error('qa.generate requires projectId');
  const generated = await generateQuestions(
    ctx.db,
    projectId,
    { presentationId: presentationId ?? null, count },
    { userId: ctx.job.userId, db: ctx.db },
  );
  return { questions: generated };
});

registerHandler('export.render', async (ctx) => {
  const { exportId } = payloadOf(ctx);
  if (!exportId) throw new Error('export.render requires exportId');
  ctx.progress(0, 1, 'Rendering document');
  const result = await renderExport(ctx.db, exportId, (message) => ctx.log(message));
  ctx.progress(1, 1, 'Export ready');
  return result;
});
