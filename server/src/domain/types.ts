/**
 * The project knowledge model.
 *
 * Everything the product generates is a projection of these types. Reports,
 * slides, speaker notes and Q&A never store facts of their own — they cite
 * claim ids, so a sentence in a PowerPoint can be traced back to the user
 * sentence or screenshot it came from.
 */

// --- provenance and confidence -------------------------------------------

export const PROVENANCE = [
  'USER_FACT', // the user told us this happened
  'EVIDENCE', // read out of an uploaded artifact
  'AI_EXPLANATION', // general technical knowledge, not project-specific
  'AI_INFERENCE', // a conclusion the model drew; may be wrong
  'AI_RECOMMENDATION', // advice; never historical fact
] as const;
export type Provenance = (typeof PROVENANCE)[number];

/** Provenance values that may be stated as things that actually happened. */
export const FACTUAL_PROVENANCE: readonly Provenance[] = ['USER_FACT', 'EVIDENCE'];

export const CONFIDENCE = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const DEPTH_LABELS: Record<number, string> = {
  1: 'concise',
  2: 'standard',
  3: 'detailed',
  4: 'expert',
};

// --- elaboration slots ----------------------------------------------------

/**
 * The fields the elaboration engine may fill for a step. The engine is told to
 * skip any slot that would only produce filler, so a short preparation step
 * legitimately comes back with three slots while a security change comes back
 * with ten.
 */
export const STEP_SLOTS = [
  'what_was_done',
  'how_it_was_done',
  'why_it_was_done',
  'what_the_technology_is',
  'how_the_technology_works',
  'why_it_matters',
  'dependencies',
  'expected_result',
  'actual_result',
  'technical_significance',
  'security_considerations',
  'performance_considerations',
  'operational_considerations',
  'alternatives',
  'lessons_learned',
  'recommendations',
] as const;
export type StepSlot = (typeof STEP_SLOTS)[number];

export const SLOT_LABELS: Record<string, string> = {
  what_was_done: 'What was done',
  how_it_was_done: 'How it was done',
  why_it_was_done: 'Why it was done',
  what_the_technology_is: 'What the technology is',
  how_the_technology_works: 'How the technology works',
  why_it_matters: 'Why this matters',
  dependencies: 'Dependencies',
  expected_result: 'Expected result',
  actual_result: 'Actual result',
  technical_significance: 'Technical significance',
  security_considerations: 'Security considerations',
  performance_considerations: 'Performance considerations',
  operational_considerations: 'Operational considerations',
  alternatives: 'Alternatives',
  lessons_learned: 'Lessons learned',
  recommendations: 'Recommendations',
  // problem slots
  symptom_explanation: 'What the symptoms mean',
  investigation_reasoning: 'Investigation reasoning',
  root_cause_explanation: 'Root cause explanation',
  resolution_explanation: 'Why the fix worked',
  prevention: 'Prevention',
  // project slots
  overview: 'Overview',
  environment_explanation: 'Environment',
  architecture_explanation: 'Architecture',
  methodology: 'Methodology',
  significance: 'Significance',
};

export const PROBLEM_SLOTS = [
  'symptom_explanation',
  'investigation_reasoning',
  'root_cause_explanation',
  'resolution_explanation',
  'lessons_learned',
  'prevention',
] as const;

export const PROJECT_SLOTS = [
  'overview',
  'environment_explanation',
  'architecture_explanation',
  'methodology',
  'significance',
  'lessons_learned',
  'recommendations',
] as const;

// --- categories, tone, audience ------------------------------------------

export const STEP_CATEGORIES = [
  'preparation',
  'installation',
  'configuration',
  'development',
  'deployment',
  'testing',
  'troubleshooting',
  'security',
  'networking',
  'cloud',
  'database',
  'documentation',
  'validation',
  'other',
] as const;
export type StepCategory = (typeof STEP_CATEGORIES)[number] | (string & {});

export const TONES = [
  'academic',
  'technical',
  'professional',
  'executive',
  'client',
  'beginner',
  'expert',
] as const;
export type Tone = (typeof TONES)[number];

/**
 * Narrative voice — how the document refers to the person who did the work.
 *
 * This exists because the alternative is worse: without an explicit choice the
 * model reaches for "the author", and a report about your own work then reads
 * as though a stranger wrote it about you.
 */
export const VOICES = ['first-person', 'first-person-plural', 'impersonal'] as const;
export type Voice = (typeof VOICES)[number];

export const VOICE_GUIDANCE: Record<string, string> = {
  'first-person':
    'Write in the first person singular, as the person who did the work: "I installed", "I configured", ' +
    '"my objective was". This is their own account of their own work.',
  'first-person-plural':
    'Write in the first person plural, as the team who did the work: "we installed", "we configured", ' +
    '"our objective was".',
  impersonal:
    'Write impersonally, with the work as the subject: "the server was installed", "the client was ' +
    'reconfigured". Do not use "I" or "we".',
};

export const VOICE_LABELS: Record<string, string> = {
  'first-person': 'First person — "I configured…"',
  'first-person-plural': 'Team — "We configured…"',
  impersonal: 'Impersonal — "The client was configured…"',
};

/**
 * The rule that applies whatever the voice. Referring to the person in the
 * third person ("the author", "the user") is always wrong: it is their
 * document, describing their own work, and the distance reads as a machine
 * talking about them rather than for them.
 */
export const NEVER_THIRD_PERSON =
  'NEVER refer to the person who did this work as "the author", "the user", "the operator", ' +
  '"the engineer" or any other third-party label, and never attribute their statements to them as ' +
  'though quoting a stranger ("the author states…", "as identified by the author"). It is their own ' +
  'document about their own work. Where you would have written "the author", either use the voice ' +
  'given above or recast the sentence around the work itself.';

export const AUDIENCES = [
  'professor',
  'technical-team',
  'management',
  'client',
  'interviewer',
  'general',
  'security-team',
  'developer-team',
] as const;
export type Audience = (typeof AUDIENCES)[number] | (string & {});

export const TONE_GUIDANCE: Record<string, string> = {
  academic:
    'Formal academic register. Define terms on first use, favour precise passive constructions, no marketing language.',
  technical:
    'Peer-to-peer engineering register. Use correct product and protocol names, assume working knowledge of IT fundamentals.',
  professional:
    'Business-professional register. Technical but readable by a mixed audience. Full sentences, no ' +
    'bullet fragments in prose sections, no internal shorthand without expansion on first use.',
  executive:
    'Executive register. Lead every passage with the outcome, then its consequence for risk, cost, ' +
    'capability or timeline. State what was decided and what it enables. Mechanism detail appears only ' +
    'where it drives a decision, and then in one sentence. No command names, no file paths, no vendor ' +
    'jargon without expansion. Prefer concrete figures the project records over adjectives; where no ' +
    'figure exists, describe the change qualitatively rather than reaching for "significant" or ' +
    '"robust". Never open with background — open with what happened and what it means.',
  client:
    'Plain, reassuring, jargon-light. Explain the benefit of each action; avoid internal shorthand.',
  beginner:
    'Teaching register. Expand every acronym, explain prerequisite concepts before using them.',
  expert:
    'Dense and specific. Name mechanisms, RFCs, service names and failure modes. Skip introductory framing.',
};

export const AUDIENCE_GUIDANCE: Record<string, string> = {
  professor:
    'Assessed academic work. Show reasoning and method, justify choices, acknowledge limitations explicitly.',
  'technical-team': 'Colleagues who will operate this. Emphasise configuration, failure modes and validation.',
  management:
    'A reader who allocates budget and people. Emphasise objective, risk, effort, outcome and what ' +
    'happens next. Every paragraph should survive the question "so what?". Omit command-level detail ' +
    'entirely; it belongs in the appendix.',
  client: 'Emphasise what was delivered and what it means for them. Avoid internal hostnames where possible.',
  interviewer:
    'The presenter will be questioned on this. Emphasise decisions, trade-offs and what they would change.',
  general: 'Assume no domain background. Use analogies before mechanisms.',
  'security-team': 'Emphasise exposure, controls, blast radius, detection and residual risk.',
  'developer-team': 'Emphasise interfaces, data flow, dependencies and reproducibility.',
};

// --- core records ---------------------------------------------------------

export interface Claim {
  id: string;
  projectId: string;
  subjectType: 'project' | 'step' | 'problem' | 'evidence' | 'test' | 'result' | 'command';
  subjectId: string;
  slot: string;
  provenance: Provenance;
  confidence: Confidence;
  text: string;
  depth: number;
  supports: ClaimSupport[];
  position: number;
  editedByUser: boolean;
  accepted: boolean | null;
  generationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimSupport {
  type: 'evidence' | 'step' | 'command' | 'problem' | 'test' | 'result';
  id: string;
  note?: string;
}

export interface StepRecord {
  id: string;
  projectId: string;
  position: number;
  title: string;
  userDescription: string;
  category: StepCategory;
  status: 'planned' | 'in-progress' | 'done' | 'failed' | 'skipped';
  occurredAt: string | null;
  configuration: string | null;
  expectedResult: string | null;
  actualResult: string | null;
  validation: string | null;
  source: 'user' | 'ai-structured' | 'import';
  aiState: 'pending' | 'elaborated' | 'stale' | 'failed';
  aiConfidence: Confidence | null;
  elaborationDepth: number | null;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceRecord {
  id: string;
  projectId: string;
  fileId: string | null;
  kind: 'screenshot' | 'photo' | 'diagram' | 'document' | 'log' | 'config' | 'code' | 'link' | 'other';
  title: string;
  description: string | null;
  caption: string | null;
  source: string | null;
  capturedAt: string | null;
  reviewState: 'unreviewed' | 'ai-analyzed' | 'user-confirmed' | 'user-corrected' | 'rejected';
  confidence: Confidence | null;
  sensitive: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceLink {
  id: string;
  projectId: string;
  evidenceId: string;
  targetType: 'step' | 'problem' | 'resolution' | 'result' | 'test' | 'project';
  targetId: string;
  role: 'supports' | 'before' | 'after' | 'symptom' | 'investigation' | 'resolution' | 'validation';
  origin: 'user' | 'ai';
  confidence: Confidence | null;
  note: string | null;
  createdAt: string;
}

export interface ProblemRecord {
  id: string;
  projectId: string;
  stepId: string | null;
  title: string;
  symptoms: string | null;
  impact: string | null;
  hypothesis: string | null;
  rootCause: string | null;
  rootCauseProvenance: Provenance;
  rootCauseConfidence: Confidence | null;
  status: 'open' | 'investigating' | 'resolved' | 'unresolved' | 'wont-fix';
  detectedAt: string | null;
  resolvedAt: string | null;
  position: number;
  aiState: 'pending' | 'elaborated' | 'stale' | 'failed';
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  ownerId: string;
  title: string;
  summary: string | null;
  objective: string | null;
  scope: string | null;
  requirements: string | null;
  environment: string | null;
  architecture: string | null;
  conclusion: string | null;
  status: 'draft' | 'active' | 'complete' | 'archived';
  domain: string | null;
  elaborationDepth: number;
  tone: Tone;
  audience: Audience;
  voice: Voice;
  settings: Record<string, unknown>;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- report / presentation content blocks --------------------------------

export type ReportBlock =
  | { type: 'paragraph'; text: string; provenance?: Provenance; claimId?: string }
  | { type: 'heading'; level: 2 | 3 | 4; text: string }
  | { type: 'bullets'; items: string[]; ordered?: boolean }
  | { type: 'procedure'; items: { text: string; detail?: string }[] }
  | { type: 'code'; language: string; content: string; caption?: string }
  | { type: 'table'; caption?: string; headers: string[]; rows: string[][] }
  | { type: 'figure'; evidenceId: string; caption: string; number?: number }
  | { type: 'callout'; variant: 'note' | 'warning' | 'inference' | 'recommendation'; text: string }
  | { type: 'diagram'; title?: string; ascii: string; caption?: string }
  | { type: 'reference-list'; items: { label: string; url?: string; detail?: string }[] };

export interface SlideBody {
  columns?: { heading: string; bullets: string[] }[];
  before?: { heading: string; bullets: string[]; evidenceId?: string };
  after?: { heading: string; bullets: string[]; evidenceId?: string };
  table?: { headers: string[]; rows: string[][] };
  code?: { language: string; content: string };
  diagram?: { ascii: string };
  quote?: { text: string; attribution?: string };
}

// --- helpers --------------------------------------------------------------

export function isFactual(provenance: Provenance): boolean {
  return FACTUAL_PROVENANCE.includes(provenance);
}

export function provenanceLabel(p: Provenance): string {
  switch (p) {
    case 'USER_FACT':
      return 'Documented by author';
    case 'EVIDENCE':
      return 'From evidence';
    case 'AI_EXPLANATION':
      return 'Technical background';
    case 'AI_INFERENCE':
      return 'Inferred';
    case 'AI_RECOMMENDATION':
      return 'Recommendation';
    default:
      return p;
  }
}
