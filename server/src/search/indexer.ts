import type { Database } from '../db/index.ts';
import { indexDocument, removeFromIndex } from '../db/repositories/system.ts';
import { listCommandsForStep, listSteps, getStep } from '../db/repositories/steps.ts';
import { listEvidence } from '../db/repositories/evidence.ts';
import { listProblems, listClaims, listInvestigations, listResolutions } from '../db/repositories/knowledge.ts';
import { getProject } from '../db/repositories/projects.ts';
import { reindexEvidence } from '../ai/services/vision.ts';

/**
 * Search indexing.
 *
 * FTS5 over the things a user actually looks for: their own words, OCR text
 * pulled out of screenshots, AI explanations, problem symptoms and commands.
 * Indexing is synchronous and cheap; it runs on write rather than on a timer so
 * search is never stale.
 */

export function indexStep(db: Database, projectId: string, stepId: string): void {
  const step = getStep(db, stepId);
  if (!step) {
    removeFromIndex(db, 'step', stepId);
    return;
  }
  const claims = listClaims(db, 'step', stepId);
  const commands = listCommandsForStep(db, stepId);
  indexDocument(db, {
    projectId,
    entityType: 'step',
    entityId: stepId,
    title: step.title,
    body: [
      step.userDescription,
      step.configuration ?? '',
      step.expectedResult ?? '',
      step.actualResult ?? '',
      step.validation ?? '',
      step.category,
      ...claims.map((c) => c.text),
      ...commands.map((c) => `${c.content} ${c.explanation ?? ''}`),
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

export function indexProblem(db: Database, projectId: string, problemId: string): void {
  const problem = listProblems(db, projectId).find((p) => p.id === problemId);
  if (!problem) {
    removeFromIndex(db, 'problem', problemId);
    return;
  }
  const claims = listClaims(db, 'problem', problemId);
  indexDocument(db, {
    projectId,
    entityType: 'problem',
    entityId: problemId,
    title: problem.title,
    body: [
      problem.symptoms ?? '',
      problem.impact ?? '',
      problem.hypothesis ?? '',
      problem.rootCause ?? '',
      ...listInvestigations(db, problemId).map((i) => `${i.action} ${i.finding ?? ''}`),
      ...listResolutions(db, problemId).map((r) => `${r.description} ${r.validation ?? ''}`),
      ...claims.map((c) => c.text),
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

/** Full reindex of a project — cheap enough to run after a bulk operation. */
export function indexProject(db: Database, projectId: string): void {
  const project = getProject(db, projectId);
  if (!project) return;

  indexDocument(db, {
    projectId,
    entityType: 'project',
    entityId: projectId,
    title: project.title,
    body: [
      project.summary ?? '',
      project.objective ?? '',
      project.scope ?? '',
      project.requirements ?? '',
      project.environment ?? '',
      project.architecture ?? '',
      project.conclusion ?? '',
      ...listClaims(db, 'project', projectId).map((c) => c.text),
    ]
      .filter(Boolean)
      .join('\n'),
  });

  for (const step of listSteps(db, projectId)) indexStep(db, projectId, step.id);
  for (const problem of listProblems(db, projectId)) indexProblem(db, projectId, problem.id);
  for (const evidence of listEvidence(db, projectId)) reindexEvidence(db, projectId, evidence.id);
}
