import type { Database } from '../db/index.ts';
import { getProject } from '../db/repositories/projects.ts';
import { listCommandsForProject, listSteps } from '../db/repositories/steps.ts';
import {
  getLatestImageAnalysis,
  getLatestOcr,
  listEvidence,
  listEvidenceLinks,
} from '../db/repositories/evidence.ts';
import {
  listClaims,
  listInvestigations,
  listProblems,
  listRefs,
  listResolutions,
  listResults,
  listTests,
} from '../db/repositories/knowledge.ts';
import { searchProject } from '../db/repositories/system.ts';
import { truncate } from '../lib/core.ts';
import type { Claim, EvidenceLink } from '../domain/types.ts';

/**
 * Contextual retrieval.
 *
 * A mature project can hold hundreds of steps and thousands of OCR lines.
 * Sending all of it on every call is slow, expensive, and actively degrades
 * output quality. Each generation task pulls the slice it needs:
 *
 *  - step elaboration gets one step, its evidence, its neighbours;
 *  - report generation gets the full skeleton but truncated evidence text;
 *  - the assistant gets whatever full-text search matches the question.
 */

export interface EvidenceContext {
  id: string;
  title: string;
  kind: string;
  caption: string | null;
  description: string | null;
  reviewState: string;
  ocrText: string;
  aiDescription: string;
  entities: Record<string, string[]>;
  links: { targetType: string; targetId: string; role: string }[];
}

export interface StepContext {
  id: string;
  position: number;
  title: string;
  userDescription: string;
  category: string;
  status: string;
  occurredAt: string | null;
  configuration: string | null;
  expectedResult: string | null;
  actualResult: string | null;
  validation: string | null;
  commands: { id: string; language: string; content: string; output: string | null }[];
  evidenceIds: string[];
  claims?: { slot: string; provenance: string; text: string }[];
}

export interface ProblemContext {
  id: string;
  title: string;
  symptoms: string | null;
  impact: string | null;
  hypothesis: string | null;
  rootCause: string | null;
  rootCauseProvenance: string;
  status: string;
  stepId: string | null;
  investigations: { action: string; finding: string | null; tool: string | null }[];
  resolutions: { description: string; validation: string | null; validated: boolean }[];
  evidenceIds: string[];
}

export interface ProjectContext {
  project: {
    id: string;
    title: string;
    summary: string | null;
    objective: string | null;
    scope: string | null;
    requirements: string | null;
    environment: string | null;
    architecture: string | null;
    conclusion: string | null;
    domain: string | null;
    tone: string;
    audience: string;
    depth: number;
  };
  steps: StepContext[];
  problems: ProblemContext[];
  evidence: EvidenceContext[];
  tests: { id: string; name: string; method: string | null; expected: string | null; observed: string | null; outcome: string }[];
  results: { id: string; title: string; detail: string | null; metric: string | null; value: string | null; provenance: string }[];
  references: { label: string; url: string | null; detail: string | null }[];
  counts: { steps: number; problems: number; evidence: number; tests: number; results: number };
}

export interface BuildContextOptions {
  /** Cap OCR text per evidence item. */
  evidenceTextChars?: number;
  includeClaims?: boolean;
  /** Restrict to these step ids (plus their evidence). */
  stepIds?: string[];
  /** Full-text query used to pick the most relevant subset. */
  query?: string;
  maxSteps?: number;
  maxEvidence?: number;
}

export function buildProjectContext(
  db: Database,
  projectId: string,
  options: BuildContextOptions = {},
): ProjectContext {
  const project = getProject(db, projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const evidenceTextChars = options.evidenceTextChars ?? 1200;
  const allSteps = listSteps(db, projectId);
  const allProblems = listProblems(db, projectId);
  const allEvidence = listEvidence(db, projectId);
  const links = listEvidenceLinks(db, projectId);
  const commands = listCommandsForProject(db, projectId);

  const linksByTarget = new Map<string, EvidenceLink[]>();
  const linksByEvidence = new Map<string, EvidenceLink[]>();
  for (const link of links) {
    const targetKey = `${link.targetType}:${link.targetId}`;
    linksByTarget.set(targetKey, [...(linksByTarget.get(targetKey) ?? []), link]);
    linksByEvidence.set(link.evidenceId, [...(linksByEvidence.get(link.evidenceId) ?? []), link]);
  }

  let steps = allSteps;
  if (options.stepIds?.length) {
    const wanted = new Set(options.stepIds);
    steps = allSteps.filter((s) => wanted.has(s.id));
  } else if (options.query) {
    const hits = searchProject(db, projectId, options.query, 40);
    const hitIds = new Set(hits.filter((h) => h.entityType === 'step').map((h) => h.entityId));
    if (hitIds.size > 0) steps = allSteps.filter((s) => hitIds.has(s.id));
  }
  if (options.maxSteps && steps.length > options.maxSteps) steps = steps.slice(0, options.maxSteps);

  const stepIdSet = new Set(steps.map((s) => s.id));
  const relevantEvidenceIds = new Set<string>();
  for (const link of links) {
    if (link.targetType === 'step' && stepIdSet.has(link.targetId)) relevantEvidenceIds.add(link.evidenceId);
    if (link.targetType === 'problem') relevantEvidenceIds.add(link.evidenceId);
  }

  let evidence = allEvidence;
  if (options.stepIds?.length || options.query) {
    evidence = allEvidence.filter((e) => relevantEvidenceIds.has(e.id));
  }
  if (options.maxEvidence && evidence.length > options.maxEvidence) {
    evidence = evidence.slice(0, options.maxEvidence);
  }

  const evidenceContexts: EvidenceContext[] = evidence
    .filter((e) => e.reviewState !== 'rejected')
    .map((item) => {
      const ocr = getLatestOcr(db, item.id);
      const analysis = getLatestImageAnalysis(db, item.id);
      return {
        id: item.id,
        title: item.title || 'Untitled evidence',
        kind: item.kind,
        caption: item.caption,
        description: item.description,
        reviewState: item.reviewState,
        // Redacted text is what leaves the machine when secrets were found.
        ocrText: truncate(ocr?.redactedText ?? ocr?.text ?? '', evidenceTextChars),
        aiDescription: analysis?.description ?? '',
        entities: analysis?.entities ?? {},
        links: (linksByEvidence.get(item.id) ?? []).map((l) => ({
          targetType: l.targetType,
          targetId: l.targetId,
          role: l.role,
        })),
      };
    });

  const stepContexts: StepContext[] = steps.map((step) => ({
    id: step.id,
    position: step.position,
    title: step.title,
    userDescription: step.userDescription,
    category: step.category,
    status: step.status,
    occurredAt: step.occurredAt,
    configuration: step.configuration,
    expectedResult: step.expectedResult,
    actualResult: step.actualResult,
    validation: step.validation,
    commands: commands
      .filter((c) => c.stepId === step.id)
      .map((c) => ({ id: c.id, language: c.language, content: c.content, output: truncate(c.output ?? '', 600) || null })),
    evidenceIds: (linksByTarget.get(`step:${step.id}`) ?? []).map((l) => l.evidenceId),
    ...(options.includeClaims
      ? {
          claims: listClaims(db, 'step', step.id).map((c) => ({
            slot: c.slot,
            provenance: c.provenance,
            text: c.text,
          })),
        }
      : {}),
  }));

  const problemContexts: ProblemContext[] = allProblems.map((problem) => ({
    id: problem.id,
    title: problem.title,
    symptoms: problem.symptoms,
    impact: problem.impact,
    hypothesis: problem.hypothesis,
    rootCause: problem.rootCause,
    rootCauseProvenance: problem.rootCauseProvenance,
    status: problem.status,
    stepId: problem.stepId,
    investigations: listInvestigations(db, problem.id).map((i) => ({
      action: i.action,
      finding: i.finding,
      tool: i.tool,
    })),
    resolutions: listResolutions(db, problem.id).map((r) => ({
      description: r.description,
      validation: r.validation,
      validated: r.validated,
    })),
    evidenceIds: (linksByTarget.get(`problem:${problem.id}`) ?? []).map((l) => l.evidenceId),
  }));

  return {
    project: {
      id: project.id,
      title: project.title,
      summary: project.summary,
      objective: project.objective,
      scope: project.scope,
      requirements: project.requirements,
      environment: project.environment,
      architecture: project.architecture,
      conclusion: project.conclusion,
      domain: project.domain,
      tone: project.tone,
      audience: project.audience,
      depth: project.elaborationDepth,
    },
    steps: stepContexts,
    problems: problemContexts,
    evidence: evidenceContexts,
    tests: listTests(db, projectId).map((t) => ({
      id: t.id,
      name: t.name,
      method: t.method,
      expected: t.expected,
      observed: t.observed,
      outcome: t.outcome,
    })),
    results: listResults(db, projectId).map((r) => ({
      id: r.id,
      title: r.title,
      detail: r.detail,
      metric: r.metric,
      value: r.value,
      provenance: r.provenance,
    })),
    references: listRefs(db, projectId).map((r) => ({ label: r.label, url: r.url, detail: r.detail })),
    counts: {
      steps: allSteps.length,
      problems: allProblems.length,
      evidence: allEvidence.length,
      tests: listTests(db, projectId).length,
      results: listResults(db, projectId).length,
    },
  };
}

/** Narrow context for elaborating a single step: the step, its evidence, its neighbours. */
export function buildStepContext(db: Database, projectId: string, stepId: string) {
  const full = buildProjectContext(db, projectId, { stepIds: [stepId], evidenceTextChars: 2000 });
  const allSteps = listSteps(db, projectId);
  const index = allSteps.findIndex((s) => s.id === stepId);
  const neighbours = [allSteps[index - 1], allSteps[index + 1]]
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .map((s) => ({ id: s.id, title: s.title, category: s.category, position: s.position }));
  const relatedProblems = full.problems.filter((p) => p.stepId === stepId);
  return {
    project: full.project,
    step: full.steps[0],
    evidence: full.evidence,
    neighbours,
    problems: relatedProblems,
  };
}

export function claimsToLines(claims: Claim[]): string[] {
  return claims.map((c) => `[${c.provenance}] ${c.text}`);
}
