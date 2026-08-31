/**
 * Templates control STRUCTURE ONLY.
 *
 * A template says which sections exist, in what order, and what each is for.
 * It never supplies content — if the project has nothing for a section, the
 * section says so rather than being filled with plausible prose.
 */

export interface SectionSpec {
  key: string;
  heading: string;
  /** What belongs here — passed to the generator as guidance. */
  intent: string;
  /** Sections that are dropped when the project holds nothing for them. */
  omitWhenEmpty?: boolean;
  /** Assembled from project data rather than written by the model. */
  derived?: 'steps' | 'problems' | 'tests' | 'results' | 'references' | 'appendix' | 'commands';
}

export interface ReportTemplate {
  key: string;
  name: string;
  description: string;
  defaultTone: string;
  defaultAudience: string;
  sections: SectionSpec[];
}

const CORE_SECTIONS: SectionSpec[] = [
  {
    key: 'executive-summary',
    heading: 'Executive Summary',
    intent: 'What was done, why, what happened, and what it means. Readable on its own in under a minute.',
  },
  { key: 'objectives', heading: 'Objectives', intent: 'The stated goal of the work and its success criteria.' },
  { key: 'scope', heading: 'Scope', intent: 'What was in scope and, where stated, what was deliberately excluded.', omitWhenEmpty: true },
  { key: 'requirements', heading: 'Requirements', intent: 'Prerequisites and constraints the work had to satisfy.', omitWhenEmpty: true },
  { key: 'environment', heading: 'Environment', intent: 'Hosts, versions, addressing and platform the work ran on.', omitWhenEmpty: true },
  { key: 'architecture', heading: 'Architecture', intent: 'How the components relate. Include a diagram only if it clarifies something.', omitWhenEmpty: true },
  { key: 'methodology', heading: 'Methodology', intent: 'The approach taken and how the work was sequenced and verified.' },
  { key: 'implementation', heading: 'Implementation', intent: 'A narrative of the work as a whole, before the step detail.' },
  { key: 'steps', heading: 'Step-by-Step Process', intent: 'Each documented step with its elaboration and evidence.', derived: 'steps' },
  { key: 'configuration', heading: 'Configuration', intent: 'Configuration values and commands applied.', derived: 'commands', omitWhenEmpty: true },
  { key: 'problems', heading: 'Problems Encountered', intent: 'Each problem with symptoms, investigation, root cause and resolution.', derived: 'problems', omitWhenEmpty: true },
  { key: 'testing', heading: 'Testing and Validation', intent: 'What was tested, how, and what was observed.', derived: 'tests', omitWhenEmpty: true },
  { key: 'results', heading: 'Results', intent: 'Outcomes of the work, tied to evidence.', derived: 'results', omitWhenEmpty: true },
  { key: 'lessons-learned', heading: 'Lessons Learned', intent: 'What the work taught, drawn from the recorded steps and problems.' },
  { key: 'recommendations', heading: 'Recommendations', intent: 'Forward-looking advice, clearly marked as recommendation rather than history.' },
  { key: 'conclusion', heading: 'Conclusion', intent: 'What the work demonstrates and its current state.' },
  { key: 'references', heading: 'References', intent: 'Sources cited by the project.', derived: 'references', omitWhenEmpty: true },
  { key: 'appendix', heading: 'Appendix', intent: 'Full evidence catalogue and raw extracts.', derived: 'appendix' },
];

function pick(keys: string[], overrides: Partial<Record<string, Partial<SectionSpec>>> = {}): SectionSpec[] {
  return keys.map((key) => {
    const base = CORE_SECTIONS.find((s) => s.key === key);
    if (!base) throw new Error(`Unknown section ${key}`);
    return { ...base, ...(overrides[key] ?? {}) };
  });
}

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    key: 'technical',
    name: 'Technical Report',
    description: 'Full engineering write-up: environment, implementation, troubleshooting, validation.',
    defaultTone: 'technical',
    defaultAudience: 'technical-team',
    sections: CORE_SECTIONS,
  },
  {
    key: 'technical-lab',
    name: 'Technical Lab',
    description: 'Lab exercise write-up focused on procedure, evidence and what was demonstrated.',
    defaultTone: 'technical',
    defaultAudience: 'professor',
    sections: pick([
      'objectives',
      'environment',
      'methodology',
      'steps',
      'problems',
      'testing',
      'results',
      'lessons-learned',
      'conclusion',
      'appendix',
    ]),
  },
  {
    key: 'academic',
    name: 'Academic Project',
    description: 'Assessed coursework structure with explicit method and limitations.',
    defaultTone: 'academic',
    defaultAudience: 'professor',
    sections: pick([
      'executive-summary',
      'objectives',
      'scope',
      'requirements',
      'methodology',
      'implementation',
      'steps',
      'problems',
      'testing',
      'results',
      'lessons-learned',
      'conclusion',
      'references',
      'appendix',
    ], {
      'executive-summary': { heading: 'Abstract', intent: 'A single-paragraph abstract: aim, method, outcome.' },
      'lessons-learned': { heading: 'Discussion and Limitations', intent: 'What the results show, and the limits of what can be concluded.' },
    }),
  },
  {
    key: 'it-implementation',
    name: 'IT Implementation',
    description: 'Deployment record for an internal change: environment, procedure, validation, rollback notes.',
    defaultTone: 'professional',
    defaultAudience: 'technical-team',
    sections: pick([
      'executive-summary',
      'objectives',
      'scope',
      'environment',
      'architecture',
      'implementation',
      'steps',
      'configuration',
      'problems',
      'testing',
      'results',
      'recommendations',
      'conclusion',
      'appendix',
    ]),
  },
  {
    key: 'cloud-deployment',
    name: 'Cloud Deployment',
    description: 'Cloud build record: architecture, provisioning, cost and operational considerations.',
    defaultTone: 'technical',
    defaultAudience: 'technical-team',
    sections: pick([
      'executive-summary',
      'objectives',
      'architecture',
      'environment',
      'implementation',
      'steps',
      'configuration',
      'problems',
      'testing',
      'results',
      'recommendations',
      'conclusion',
      'references',
      'appendix',
    ]),
  },
  {
    key: 'security-assessment',
    name: 'Cybersecurity Assessment',
    description: 'Assessment structure: scope, method, findings, evidence, remediation.',
    defaultTone: 'technical',
    defaultAudience: 'security-team',
    sections: pick([
      'executive-summary',
      'scope',
      'methodology',
      'environment',
      'steps',
      'problems',
      'testing',
      'results',
      'recommendations',
      'conclusion',
      'references',
      'appendix',
    ], {
      problems: { heading: 'Findings', intent: 'Each finding with evidence, impact and remediation.' },
      recommendations: { heading: 'Remediation', intent: 'Prioritised remediation, marked as recommendation.' },
    }),
  },
  {
    key: 'incident',
    name: 'Incident / Postmortem',
    description: 'Blameless postmortem: timeline, impact, root cause, resolution, prevention.',
    defaultTone: 'professional',
    defaultAudience: 'technical-team',
    sections: pick([
      'executive-summary',
      'steps',
      'problems',
      'testing',
      'results',
      'lessons-learned',
      'recommendations',
      'conclusion',
      'appendix',
    ], {
      'executive-summary': { heading: 'Incident Summary', intent: 'What happened, when, what was affected, and the current state.' },
      steps: { heading: 'Timeline', intent: 'Chronological account of what was done and observed.' },
      problems: { heading: 'Root Cause Analysis', intent: 'Symptoms, investigation, root cause, contributing factors.' },
      recommendations: { heading: 'Prevention', intent: 'Follow-up actions to stop recurrence, marked as recommendation.' },
    }),
  },
  {
    key: 'software-project',
    name: 'Software Project',
    description: 'Development write-up: requirements, design, implementation, testing.',
    defaultTone: 'technical',
    defaultAudience: 'developer-team',
    sections: pick([
      'executive-summary',
      'objectives',
      'requirements',
      'architecture',
      'implementation',
      'steps',
      'configuration',
      'problems',
      'testing',
      'results',
      'lessons-learned',
      'conclusion',
      'references',
      'appendix',
    ]),
  },
  {
    key: 'executive',
    name: 'Executive Report',
    description: 'Short, outcome-first summary for a non-technical reader.',
    defaultTone: 'executive',
    defaultAudience: 'management',
    sections: pick(['executive-summary', 'objectives', 'results', 'problems', 'recommendations', 'conclusion'], {
      problems: { heading: 'Issues and Resolution', intent: 'Business-level account of what went wrong and how it was handled.' },
    }),
  },
];

export function getReportTemplate(key: string): ReportTemplate {
  return REPORT_TEMPLATES.find((t) => t.key === key) ?? REPORT_TEMPLATES[0]!;
}

// ---------------------------------------------------------------------------
// Presentation templates
// ---------------------------------------------------------------------------

export interface SlideSpec {
  key: string;
  title: string;
  intent: string;
  /** Slots dropped first when the requested slide count is lower. */
  priority: 1 | 2 | 3;
  preferredLayout?: string;
}

export interface PresentationTemplate {
  key: string;
  name: string;
  description: string;
  defaultAudience: string;
  defaultTone: string;
  slides: SlideSpec[];
}

const DEMO_FLOW: SlideSpec[] = [
  { key: 'title', title: 'Title', intent: 'Project title, presenter, date.', priority: 1, preferredLayout: 'title' },
  { key: 'objective', title: 'Objective', intent: 'What this work set out to achieve.', priority: 1 },
  { key: 'context', title: 'Context', intent: 'Why this work was needed.', priority: 2 },
  { key: 'environment', title: 'Environment', intent: 'The systems involved.', priority: 2 },
  { key: 'architecture', title: 'Architecture', intent: 'How the pieces fit together.', priority: 3, preferredLayout: 'diagram' },
  { key: 'approach', title: 'Approach', intent: 'The plan and its sequence.', priority: 2 },
  { key: 'implementation', title: 'Implementation', intent: 'The main steps carried out.', priority: 1 },
  { key: 'configuration', title: 'Key Configuration', intent: 'The settings that mattered most.', priority: 3, preferredLayout: 'code' },
  { key: 'problem', title: 'Problem Encountered', intent: 'The failure that occurred, with its evidence.', priority: 1, preferredLayout: 'bullets-image' },
  { key: 'troubleshooting', title: 'Troubleshooting', intent: 'How the fault was isolated.', priority: 2 },
  { key: 'resolution', title: 'Resolution', intent: 'The change that fixed it and why it worked.', priority: 1, preferredLayout: 'before-after' },
  { key: 'validation', title: 'Validation', intent: 'The evidence that it works now.', priority: 1, preferredLayout: 'bullets-image' },
  { key: 'results', title: 'Results', intent: 'What was achieved.', priority: 1 },
  { key: 'lessons', title: 'Lessons Learned', intent: 'What the work taught.', priority: 2 },
  { key: 'conclusion', title: 'Conclusion', intent: 'Closing statement and current state.', priority: 1, preferredLayout: 'closing' },
];

export const PRESENTATION_TEMPLATES: PresentationTemplate[] = [
  {
    key: 'technical-demo',
    name: 'Technical Demo',
    description: 'Show the build, the failure, the fix and the proof.',
    defaultAudience: 'technical-team',
    defaultTone: 'technical',
    slides: DEMO_FLOW,
  },
  {
    key: 'academic',
    name: 'Academic Presentation',
    description: 'Aim, method, results, discussion — for assessed work.',
    defaultAudience: 'professor',
    defaultTone: 'academic',
    slides: DEMO_FLOW.filter((s) => s.key !== 'configuration'),
  },
  {
    key: 'project-review',
    name: 'Project Review',
    description: 'Progress, obstacles and outcomes for a review meeting.',
    defaultAudience: 'management',
    defaultTone: 'professional',
    slides: DEMO_FLOW.filter((s) => !['configuration', 'architecture', 'troubleshooting'].includes(s.key)),
  },
  {
    key: 'client',
    name: 'Client Presentation',
    description: 'Outcome-focused, low on internal detail.',
    defaultAudience: 'client',
    defaultTone: 'client',
    slides: DEMO_FLOW.filter((s) => ['title', 'objective', 'context', 'approach', 'implementation', 'results', 'conclusion'].includes(s.key)),
  },
  {
    key: 'incident-review',
    name: 'Incident Review',
    description: 'Timeline, impact, cause, fix, prevention.',
    defaultAudience: 'technical-team',
    defaultTone: 'professional',
    slides: [
      DEMO_FLOW[0]!,
      { key: 'context', title: 'What Happened', intent: 'The incident in one slide.', priority: 1 },
      { key: 'implementation', title: 'Timeline', intent: 'Chronology of events and actions.', priority: 1, preferredLayout: 'table' },
      { key: 'problem', title: 'Impact', intent: 'What was affected and for how long.', priority: 1 },
      { key: 'troubleshooting', title: 'Investigation', intent: 'How the cause was found.', priority: 1 },
      { key: 'resolution', title: 'Root Cause and Fix', intent: 'The cause and the change made.', priority: 1 },
      { key: 'validation', title: 'Verification', intent: 'How recovery was confirmed.', priority: 2 },
      { key: 'lessons', title: 'Prevention', intent: 'Follow-up actions.', priority: 1 },
      DEMO_FLOW[DEMO_FLOW.length - 1]!,
    ],
  },
  {
    key: 'portfolio',
    name: 'Portfolio Presentation',
    description: 'Show competence: what you built, what broke, how you fixed it.',
    defaultAudience: 'interviewer',
    defaultTone: 'professional',
    slides: DEMO_FLOW.filter((s) => s.key !== 'requirements'),
  },
  {
    key: 'training',
    name: 'Training Presentation',
    description: 'Teach the procedure and the reasoning behind it.',
    defaultAudience: 'general',
    defaultTone: 'beginner',
    slides: DEMO_FLOW.filter((s) => !['context', 'results'].includes(s.key)),
  },
];

export function getPresentationTemplate(key: string): PresentationTemplate {
  return PRESENTATION_TEMPLATES.find((t) => t.key === key) ?? PRESENTATION_TEMPLATES[0]!;
}

/**
 * Trims a template's slide list to the requested deck length, dropping the
 * lowest-priority slots first and always keeping the title and closing slides.
 */
export function planSlides(template: PresentationTemplate, target: number): SlideSpec[] {
  const slides = [...template.slides];
  if (target >= slides.length) return slides;
  const kept = slides.filter((s) => s.key === 'title' || s.key === 'conclusion');
  const candidates = slides.filter((s) => s.key !== 'title' && s.key !== 'conclusion');
  candidates.sort((a, b) => a.priority - b.priority || slides.indexOf(a) - slides.indexOf(b));
  const room = Math.max(0, target - kept.length);
  const selected = new Set(candidates.slice(0, room).map((s) => s.key));
  return slides.filter((s) => s.key === 'title' || s.key === 'conclusion' || selected.has(s.key));
}
