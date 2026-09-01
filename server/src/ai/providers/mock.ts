import type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  JsonCompletionRequest,
  WorkloadClass,
} from '../provider.ts';
import { sha256 } from '../../lib/core.ts';

/**
 * Deterministic offline provider.
 *
 * This is not a stub that returns lorem ipsum. It is a rule-based
 * implementation of every AI service contract, driven by `mockContext`, so
 * that:
 *
 *  - the full pipeline (intake → analysis → elaboration → report → deck → Q&A
 *    → export) runs with no API key and no network,
 *  - the test-suite asserts on real structure rather than on mocks of itself,
 *  - a developer can work on export formatting without spending tokens.
 *
 * Its prose is deliberately generic where it would otherwise have to invent
 * domain facts: it labels such text AI_EXPLANATION at low confidence, exactly
 * as the product requires of a real model.
 */
export class MockProvider implements AIProvider {
  readonly name = 'mock';
  readonly supportsVision = true;

  modelFor(_workload: WorkloadClass): string {
    return 'mock';
  }

  async complete(request: CompletionRequest): Promise<CompletionResult<string>> {
    const text = this.text(request);
    return { value: text, usage: this.usage(request, text), raw: text };
  }

  async completeJson<T>(request: JsonCompletionRequest<T>): Promise<CompletionResult<T>> {
    const value = this.json(request) as T;
    const raw = JSON.stringify(value);
    const validated = request.validate ? request.validate(value) : value;
    return { value: validated, usage: this.usage(request, raw), raw };
  }

  private usage(request: CompletionRequest, output: string) {
    return {
      inputTokens: Math.ceil(request.prompt.length / 4),
      outputTokens: Math.ceil(output.length / 4),
      costCents: 0,
      model: 'mock',
      provider: this.name,
      durationMs: 1,
    };
  }

  // --- text services ------------------------------------------------------

  private text(request: CompletionRequest): string {
    const ctx = request.mockContext ?? {};
    switch (request.service) {
      case 'ocr.vision':
        return String(ctx.simulatedText ?? '');
      case 'assistant.chat':
        return mockAssistantReply(ctx);
      default:
        return `[mock:${request.service}] ${String(ctx.subject ?? 'no context supplied')}`;
    }
  }

  // --- structured services ------------------------------------------------

  private json(request: JsonCompletionRequest<unknown>): unknown {
    const ctx = request.mockContext ?? {};
    switch (request.service) {
      case 'intake.structure':
        return mockIntake(ctx);
      case 'vision.analyze':
        return mockVision(ctx);
      case 'evidence.classify':
        return mockEvidenceClassification(ctx);
      case 'elaborate.step':
        return mockStepElaboration(ctx);
      case 'elaborate.problem':
        return mockProblemElaboration(ctx);
      case 'elaborate.project':
        return mockProjectElaboration(ctx);
      case 'command.explain':
        return mockCommandExplanations(ctx);
      case 'consistency.check':
        return mockConsistency(ctx);
      case 'report.generate':
        return mockReport(ctx);
      case 'presentation.generate':
        return mockPresentation(ctx);
      case 'coach.review':
        return mockCoach(ctx);
      case 'qa.generate':
        return mockQuestions(ctx);
      default:
        return {};
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface MockStep {
  id?: string;
  title: string;
  userDescription?: string;
  category?: string;
  position?: number;
  status?: string;
  configuration?: string | null;
  actualResult?: string | null;
  validation?: string | null;
}

interface MockProblem {
  id?: string;
  title: string;
  symptoms?: string | null;
  rootCause?: string | null;
  status?: string;
}

interface MockEvidence {
  id: string;
  title?: string;
  caption?: string | null;
  ocrText?: string;
  description?: string | null;
}

const TOPIC_RULES: { match: RegExp; topic: string; blurb: string; matters: string }[] = [
  {
    match: /\bdns\b|resolver|name resolution/i,
    topic: 'DNS',
    blurb:
      'DNS resolves names to addresses and, in directory environments, publishes the service records that clients use to discover servers.',
    matters:
      'If a client queries a resolver that does not hold the internal zone, internal names cannot be resolved and dependent operations fail.',
  },
  {
    match: /active directory|\bad ds\b|domain controller|\bdomain join\b/i,
    topic: 'Active Directory',
    blurb:
      'Active Directory Domain Services provides centralised identity, authentication and policy for joined machines.',
    matters:
      'Domain membership is the basis for centralised authentication and policy, so join failures block the rest of the deployment.',
  },
  {
    match: /apache|httpd|nginx|web server/i,
    topic: 'web server',
    blurb: 'A web server terminates HTTP requests and serves content or proxies to an application.',
    matters: 'The service must be able to bind its listening socket before it can accept any traffic.',
  },
  {
    match: /port\s*\d+|address already in use|bind|listen/i,
    topic: 'socket binding',
    blurb:
      'A listening service binds to a TCP port; only one socket may hold a given address and port combination at a time.',
    matters: 'A bind conflict prevents the service from starting regardless of whether its configuration is correct.',
  },
  {
    match: /static ip|ip address|subnet|gateway|vlan|routing/i,
    topic: 'IP addressing',
    blurb:
      'IP configuration determines which hosts a machine can reach directly and which traffic is sent to a gateway.',
    matters: 'Stable addressing is a prerequisite for any service that other machines must locate.',
  },
  {
    match: /firewall|iptables|security group|acl|hardening/i,
    topic: 'network filtering',
    blurb: 'Packet filtering decides which traffic is permitted to reach a listening service.',
    matters: 'A correct service with a blocking filter in front of it is indistinguishable from an outage.',
  },
  {
    match: /docker|container|kubernetes|k8s|pod/i,
    topic: 'containers',
    blurb:
      'Containers package an application with its dependencies and run it in an isolated namespace on a shared kernel.',
    matters: 'Container networking and image versioning determine whether the deployment is reproducible.',
  },
  {
    match: /aws|azure|gcp|cloud|terraform|droplet/i,
    topic: 'cloud infrastructure',
    blurb: 'Cloud resources are provisioned through an API and described declaratively where possible.',
    matters: 'Provisioning choices drive cost, availability and blast radius.',
  },
  {
    match: /user|group|permission|rbac|least privilege/i,
    topic: 'access control',
    blurb: 'Accounts and groups carry the privileges that authorise actions on a system.',
    matters: 'Over-broad privilege is one of the most common findings in a security review.',
  },
  {
    match: /install|deploy|provision|setup/i,
    topic: 'installation',
    blurb: 'Installing a role or package places its binaries, services and default configuration on the host.',
    matters: 'Installation establishes the baseline that every later configuration step depends on.',
  },
];

function topicFor(text: string) {
  return TOPIC_RULES.find((rule) => rule.match.test(text));
}

function categoryFor(text: string): string {
  const t = text.toLowerCase();
  if (/fail|error|could ?n.t|couldn't|unable|problem|issue|troubleshoot/.test(t)) return 'troubleshooting';
  if (/test|verif|validat|confirm|check/.test(t)) return 'testing';
  if (/install|provision/.test(t)) return 'installation';
  if (/configur|set up|setup|enable|change/.test(t)) return 'configuration';
  if (/deploy|publish|release/.test(t)) return 'deployment';
  if (/firewall|harden|permission|credential|password/.test(t)) return 'security';
  if (/ip|dns|network|subnet|route|vlan/.test(t)) return 'networking';
  if (/database|sql|schema/.test(t)) return 'database';
  if (/document|write.?up|report/.test(t)) return 'documentation';
  return 'other';
}

function titleFor(line: string): string {
  const cleaned = line.replace(/^[\s\-*\d.)]+/, '').trim();
  const firstClause = cleaned.split(/[.;]/)[0]!.trim();
  const title = firstClause.length > 0 ? firstClause : cleaned;
  return title.charAt(0).toUpperCase() + title.slice(1, 90);
}

const FAILURE_RE = /\bfail(ed|s|ure)?\b|\berror\b|could ?n.?t|couldn't|\bunable\b|\bdenied\b|\brefused\b|\bnot work/i;
const SUCCESS_RE = /\bsucce(ss|eded|ssful)\b|\bworked\b|\bjoined\b|\bresolved\b|\bfixed\b|\bpass(ed)?\b|\bup and running\b/i;

// ---------------------------------------------------------------------------
// Service implementations
// ---------------------------------------------------------------------------

function mockIntake(ctx: Record<string, unknown>) {
  const raw = String(ctx.notes ?? '');
  const lines = raw
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)
    .map((l) => l.trim())
    .filter((l) => l.length > 2);

  const steps: Record<string, unknown>[] = [];
  const problems: Record<string, unknown>[] = [];
  let pendingProblemIndex: number | null = null;

  lines.forEach((line, index) => {
    const category = categoryFor(line);
    const isFailure = FAILURE_RE.test(line);
    const isSuccess = SUCCESS_RE.test(line);

    steps.push({
      title: titleFor(line),
      userDescription: line,
      category,
      status: isFailure ? 'failed' : 'done',
      order: index + 1,
      confidence: line.length > 12 ? 'high' : 'medium',
    });

    if (isFailure) {
      problems.push({
        title: titleFor(line),
        symptoms: line,
        relatedStepOrder: index + 1,
        status: 'open',
      });
      pendingProblemIndex = problems.length - 1;
    } else if (isSuccess && pendingProblemIndex !== null) {
      const problem = problems[pendingProblemIndex]!;
      problem.status = 'resolved';
      problem.resolutionStepOrder = index + 1;
      problem.resolution = line;
      pendingProblemIndex = null;
    }
  });

  const objectiveTopic = topicFor(raw);
  return {
    steps,
    problems,
    suggestedTitle: steps[0] ? `${steps[0].title as string} project` : 'Untitled project',
    suggestedObjective: objectiveTopic
      ? `Document the ${objectiveTopic.topic} work described in the author's notes.`
      : 'Document the work described in the author\'s notes.',
    domain: objectiveTopic?.topic ?? null,
    clarifications: raw.length < 40 ? ['The notes are very short — add what the goal of this work was.'] : [],
  };
}

function mockVision(ctx: Record<string, unknown>) {
  const hint = `${String(ctx.fileName ?? '')} ${String(ctx.title ?? '')} ${String(ctx.simulatedText ?? '')}`;
  const text = String(ctx.simulatedText ?? '');
  const topic = topicFor(hint);
  const errors = text.match(/^.*(error|failed|denied|refused|cannot|unable).*$/gim)?.slice(0, 4) ?? [];
  const ips = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)?.slice(0, 6) ?? [];
  const domains = text.match(/\b[a-z0-9-]+\.(?:local|lan|internal|com|net|org)\b/gi)?.slice(0, 6) ?? [];
  const hostnames = text.match(/\b(?:[A-Z]{2,}-?[A-Z0-9-]{2,}|WIN-[A-Z0-9]+)\b/g)?.slice(0, 6) ?? [];
  const commands = text.match(/^(?:PS |>|\$|#)\s?.*$/gm)?.slice(0, 4) ?? [];

  const failure = FAILURE_RE.test(hint);
  return {
    description: topic
      ? `A screen capture that appears to relate to ${topic.topic}.`
      : 'A screen capture supplied as project evidence.',
    detectedApp: /powershell|terminal|bash|cmd/i.test(hint)
      ? 'Terminal session'
      : /server manager/i.test(hint)
        ? 'Windows Server Manager'
        : null,
    detectedOs: /windows|powershell|server manager/i.test(hint)
      ? 'Windows'
      : /ubuntu|linux|systemctl|apache2/i.test(hint)
        ? 'Linux'
        : null,
    observations: [
      ...(errors.length > 0
        ? [{ text: `The capture contains failure text: ${errors[0]!.trim().slice(0, 120)}`, confidence: 'medium' }]
        : []),
      ...(ips.length > 0 ? [{ text: `IP addresses are visible: ${ips.join(', ')}`, confidence: 'high' }] : []),
      {
        text: 'This description was produced without a vision model; treat it as a placeholder until re-analysed.',
        confidence: 'low',
      },
    ],
    entities: { ips, hostnames, domains, errors: errors.map((e) => e.trim()), commands, services: [] },
    suggested: {
      stepTitle: topic ? `Work involving ${topic.topic}` : null,
      category: categoryFor(hint),
      problem: failure ? `Possible failure shown in ${String(ctx.title ?? 'the capture')}` : null,
      role: failure ? 'symptom' : SUCCESS_RE.test(hint) ? 'validation' : 'supports',
    },
    confidence: 'low',
  };
}

function mockEvidenceClassification(ctx: Record<string, unknown>) {
  const evidence = (ctx.evidence ?? []) as MockEvidence[];
  const steps = (ctx.steps ?? []) as MockStep[];
  const problems = (ctx.problems ?? []) as MockProblem[];

  const links: Record<string, unknown>[] = [];
  for (const item of evidence) {
    const haystack = `${item.title ?? ''} ${item.caption ?? ''} ${item.description ?? ''} ${item.ocrText ?? ''}`.toLowerCase();
    const words = new Set(haystack.split(/[^a-z0-9]+/).filter((w) => w.length > 3));

    let best: { id: string; type: 'step' | 'problem'; score: number } | null = null;
    const score = (text: string) => {
      const other = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
      let hits = 0;
      for (const word of words) if (other.has(word)) hits += 1;
      return hits;
    };
    for (const step of steps) {
      const s = score(`${step.title} ${step.userDescription ?? ''}`);
      if (s > 0 && (!best || s > best.score)) best = { id: step.id!, type: 'step', score: s };
    }
    for (const problem of problems) {
      const s = score(`${problem.title} ${problem.symptoms ?? ''}`) + 1; // problems are more specific
      if (s > 1 && (!best || s > best.score)) best = { id: problem.id!, type: 'problem', score: s };
    }
    if (!best) continue;

    const failure = FAILURE_RE.test(haystack);
    const success = SUCCESS_RE.test(haystack);
    links.push({
      evidenceId: item.id,
      targetType: best.type,
      targetId: best.id,
      role: best.type === 'problem' ? (failure ? 'symptom' : success ? 'validation' : 'supports') : success ? 'validation' : 'supports',
      confidence: best.score >= 3 ? 'medium' : 'low',
      reason: `Shares ${best.score} distinctive terms with the target.`,
    });
  }
  return { links };
}

function slotText(slot: string, step: MockStep, topicBlurb: string | null, matters: string | null): string | null {
  const desc = step.userDescription?.trim() || step.title;
  switch (slot) {
    case 'what_was_done':
      return desc;
    case 'why_it_was_done':
      return matters;
    case 'what_the_technology_is':
      return topicBlurb;
    case 'why_it_matters':
      return matters;
    case 'expected_result':
      return `The ${step.category ?? 'configuration'} change was expected to complete without error.`;
    case 'actual_result':
      return step.actualResult ?? null;
    default:
      return null;
  }
}

function mockStepElaboration(ctx: Record<string, unknown>) {
  const step = (ctx.step ?? {}) as MockStep;
  const depth = Number(ctx.depth ?? 2);
  const text = `${step.title} ${step.userDescription ?? ''} ${step.configuration ?? ''}`;
  const rule = topicFor(text);

  const claims: Record<string, unknown>[] = [];
  const push = (slot: string, provenance: string, confidence: string, value: string | null) => {
    if (!value) return;
    claims.push({ slot, provenance, confidence, text: value });
  };

  push('what_was_done', 'USER_FACT', 'high', slotText('what_was_done', step, null, null));
  if (rule) {
    push('what_the_technology_is', 'AI_EXPLANATION', 'medium', rule.blurb);
    push('why_it_matters', 'AI_EXPLANATION', 'medium', rule.matters);
  }
  if (depth >= 2) {
    push(
      'why_it_was_done',
      'AI_INFERENCE',
      'low',
      `This step appears to have been carried out so that later ${step.category ?? 'work'} steps had the prerequisites they needed.`,
    );
  }
  if (depth >= 3) {
    push('expected_result', 'AI_INFERENCE', 'low', slotText('expected_result', step, null, null));
    push(
      'operational_considerations',
      'AI_RECOMMENDATION',
      'medium',
      'Record the exact configuration values applied here so the step can be repeated on a rebuild.',
    );
  }
  if (depth >= 4) {
    push(
      'security_considerations',
      'AI_RECOMMENDATION',
      'low',
      'Review whether this change widened network or privilege exposure, and document the justification if it did.',
    );
    push(
      'alternatives',
      'AI_EXPLANATION',
      'low',
      'Alternative approaches exist for most configuration tasks; documenting why this one was chosen strengthens the write-up.',
    );
  }
  if (step.actualResult) push('actual_result', 'USER_FACT', 'high', step.actualResult);
  if (step.validation) push('validation', 'USER_FACT', 'high', step.validation);

  return {
    claims,
    confidence: rule ? 'medium' : 'low',
    suggestedTitle: null,
    questions: rule ? [] : ['What technology was used in this step? The notes do not name it.'],
  };
}

function mockProblemElaboration(ctx: Record<string, unknown>) {
  const problem = (ctx.problem ?? {}) as MockProblem;
  const resolutionText = String(ctx.resolutionText ?? '');
  const hasEvidence = Boolean(ctx.hasResolutionEvidence);
  const rule = topicFor(`${problem.title} ${problem.symptoms ?? ''} ${resolutionText}`);

  const claims: Record<string, unknown>[] = [];
  if (problem.symptoms) {
    claims.push({ slot: 'symptom_explanation', provenance: 'USER_FACT', confidence: 'high', text: problem.symptoms });
  }
  if (rule) {
    claims.push({ slot: 'root_cause_explanation', provenance: 'AI_EXPLANATION', confidence: 'medium', text: rule.blurb });
  }
  claims.push({
    slot: 'investigation_reasoning',
    provenance: 'AI_INFERENCE',
    confidence: 'low',
    text: 'The recorded sequence suggests the fault was isolated by changing one variable at a time and retrying the failing operation.',
  });
  if (resolutionText) {
    claims.push({ slot: 'resolution_explanation', provenance: 'USER_FACT', confidence: 'high', text: resolutionText });
  }
  claims.push({
    slot: 'prevention',
    provenance: 'AI_RECOMMENDATION',
    confidence: 'medium',
    text: 'Capture this failure mode and its fix in a runbook so the same diagnosis does not have to be repeated.',
  });

  return {
    claims,
    rootCause: rule
      ? `The failure is consistent with a ${rule.topic} problem, based on the symptoms recorded.`
      : null,
    rootCauseConfidence: rule ? 'low' : 'low',
    // Validation may only be asserted when the project actually holds evidence.
    validationSupported: hasEvidence,
  };
}

function mockProjectElaboration(ctx: Record<string, unknown>) {
  const steps = (ctx.steps ?? []) as MockStep[];
  const categories = [...new Set(steps.map((s) => s.category ?? 'other'))];
  const rule = topicFor(steps.map((s) => `${s.title} ${s.userDescription ?? ''}`).join(' '));
  return {
    claims: [
      {
        slot: 'overview',
        provenance: 'AI_INFERENCE',
        confidence: 'medium',
        text: `The project comprises ${steps.length} recorded step${steps.length === 1 ? '' : 's'} spanning ${categories.join(', ')}.`,
      },
      ...(rule
        ? [
            {
              slot: 'significance',
              provenance: 'AI_EXPLANATION',
              confidence: 'medium',
              text: rule.matters,
            },
          ]
        : []),
      {
        slot: 'methodology',
        provenance: 'AI_INFERENCE',
        confidence: 'low',
        text: 'Work proceeded sequentially, with each step validated before the next was attempted.',
      },
    ],
    suggestedObjective: null,
    suggestedEnvironment: null,
  };
}

function mockCommandExplanations(ctx: Record<string, unknown>) {
  const commands = (ctx.commands ?? []) as { id: string; content: string; language: string }[];
  return {
    explanations: commands.map((command) => {
      const head = command.content.trim().split(/\s+/).slice(0, 3).join(' ');
      return {
        id: command.id,
        explanation: `Runs \`${head}\`. Written in ${command.language}; see the project notes for the exact effect in this environment.`,
      };
    }),
  };
}

function mockConsistency(ctx: Record<string, unknown>) {
  const steps = (ctx.steps ?? []) as MockStep[];
  const problems = (ctx.problems ?? []) as MockProblem[];
  const evidenceByStep = (ctx.evidenceByStep ?? {}) as Record<string, number>;
  const insights: Record<string, unknown>[] = [];

  for (const step of steps) {
    if (!evidenceByStep[step.id ?? ''] && step.category !== 'preparation') {
      insights.push({
        kind: 'missing-evidence',
        severity: 'info',
        title: `No evidence attached to "${step.title}"`,
        detail: 'This step has no screenshot, log or file supporting what it describes.',
        suggestion: 'Attach a capture from this step, or mark the step as not requiring evidence.',
        targets: [{ type: 'step', id: step.id }],
        confidence: 'high',
      });
    }
    if ((step.userDescription ?? '').trim().length < 12) {
      insights.push({
        kind: 'unexplained-action',
        severity: 'warning',
        title: `"${step.title}" has almost no description`,
        detail: 'There is not enough detail here to explain what was actually done.',
        suggestion: 'Add one or two sentences describing what you changed and why.',
        targets: [{ type: 'step', id: step.id }],
        confidence: 'high',
      });
    }
  }

  for (const problem of problems) {
    if (problem.status === 'resolved' && !problem.rootCause) {
      insights.push({
        kind: 'incomplete-troubleshooting',
        severity: 'warning',
        title: `"${problem.title}" is marked resolved with no recorded root cause`,
        detail: 'A resolved problem without a root cause reads as a coincidence rather than a diagnosis.',
        suggestion: 'Record what was actually wrong, even if the conclusion is uncertain.',
        targets: [{ type: 'problem', id: problem.id }],
        confidence: 'high',
      });
    }
  }

  const titles = new Map<string, string[]>();
  for (const step of steps) {
    const key = step.title.toLowerCase().trim();
    titles.set(key, [...(titles.get(key) ?? []), step.id ?? '']);
  }
  for (const [title, ids] of titles) {
    if (ids.length > 1) {
      insights.push({
        kind: 'duplicate-step',
        severity: 'info',
        title: `${ids.length} steps share the title "${title}"`,
        detail: 'Duplicate titles make the timeline hard to follow.',
        suggestion: 'Merge them, or make each title specific to what it did.',
        targets: ids.map((id) => ({ type: 'step', id })),
        confidence: 'high',
      });
    }
  }

  return { insights };
}

function mockReport(ctx: Record<string, unknown>) {
  const sections = (ctx.sections ?? []) as { key: string; heading: string }[];
  const steps = (ctx.steps ?? []) as MockStep[];
  const problems = (ctx.problems ?? []) as MockProblem[];
  const title = String(ctx.title ?? 'Project');

  return {
    sections: sections.map((section) => ({
      key: section.key,
      heading: section.heading,
      paragraphs: reportParagraphs(section.key, title, steps, problems),
    })),
  };
}

function reportParagraphs(key: string, title: string, steps: MockStep[], problems: MockProblem[]): string[] {
  switch (key) {
    case 'executive-summary':
      return [
        `${title} comprises ${steps.length} documented step${steps.length === 1 ? '' : 's'} and ${problems.length} recorded problem${problems.length === 1 ? '' : 's'}.`,
        problems.length > 0
          ? 'The narrative below follows the work in order and separates what was observed from what has been inferred.'
          : 'No problems were recorded during this work.',
      ];
    case 'objectives':
      return ['The objective is taken from the project record; where none was stated, this section says so rather than inventing it.'];
    case 'methodology':
      return ['Work was documented step by step as it was carried out, with evidence attached to the steps it supports.'];
    case 'lessons-learned':
      return ['Lessons recorded against individual steps are collected here.'];
    case 'conclusion':
      return [`The documented work in ${title} is presented above with its supporting evidence.`];
    default:
      return [];
  }
}

function mockPresentation(ctx: Record<string, unknown>) {
  const outline = (ctx.outline ?? []) as { key: string; title: string; hint?: string }[];
  const steps = (ctx.steps ?? []) as MockStep[];
  const problems = (ctx.problems ?? []) as MockProblem[];

  return {
    slides: outline.map((slot) => {
      const bullets = presentationBullets(slot.key, steps, problems);
      return {
        key: slot.key,
        title: slot.title,
        layout: slot.key === 'title' ? 'title' : slot.key === 'conclusion' ? 'closing' : 'bullets',
        bullets,
        speakerNotes: `Cover ${slot.title.toLowerCase()}. ${slot.hint ?? ''} Expand on each bullet in your own words; the deck stays short on purpose.`.trim(),
      };
    }),
  };
}

function presentationBullets(key: string, steps: MockStep[], problems: MockProblem[]): string[] {
  switch (key) {
    case 'implementation':
      return steps.slice(0, 5).map((s) => s.title);
    case 'problem':
      return problems.slice(0, 3).map((p) => p.title);
    case 'resolution':
      return problems.filter((p) => p.status === 'resolved').slice(0, 3).map((p) => `${p.title} — resolved`);
    case 'results':
      return ['Outcomes are drawn from the recorded results section'];
    default:
      return [];
  }
}

function mockCoach(ctx: Record<string, unknown>) {
  const slides = (ctx.slides ?? []) as { id: string; title: string; bullets: string[]; speakerNotes: string; evidenceIds: string[] }[];
  const insights: Record<string, unknown>[] = [];
  slides.forEach((slide) => {
    const words = slide.bullets.join(' ').split(/\s+/).filter(Boolean).length;
    if (words > 60) {
      insights.push({
        kind: 'slide-text-heavy',
        severity: 'warning',
        title: `"${slide.title}" carries ${words} words`,
        detail: 'Dense slides compete with the presenter for the audience\'s attention.',
        suggestion: 'Move the detail into the speaker notes and keep four short bullets on the slide.',
        targets: [{ type: 'slide', id: slide.id }],
        confidence: 'high',
      });
    }
    if (!slide.speakerNotes || slide.speakerNotes.length < 40) {
      insights.push({
        kind: 'slide-missing-visual',
        severity: 'info',
        title: `"${slide.title}" has thin speaker notes`,
        detail: 'There is little here to say out loud beyond reading the slide.',
        suggestion: 'Add the explanation you would give verbally.',
        targets: [{ type: 'slide', id: slide.id }],
        confidence: 'medium',
      });
    }
  });
  return { insights };
}

function mockQuestions(ctx: Record<string, unknown>) {
  const steps = (ctx.steps ?? []) as MockStep[];
  const problems = (ctx.problems ?? []) as MockProblem[];
  const questions: Record<string, unknown>[] = [];

  for (const problem of problems.slice(0, 3)) {
    questions.push({
      category: 'troubleshooting',
      level: 'intermediate',
      text: `How did you diagnose "${problem.title}"?`,
      answer: {
        text: problem.symptoms
          ? `The symptoms recorded were: ${problem.symptoms}`
          : 'The project records this problem but not the diagnostic steps.',
        grounding: problem.id ? [{ type: 'problem', id: problem.id }] : [],
        generalKnowledge: 'Structured fault isolation changes one variable at a time and re-tests after each change.',
        confidence: problem.symptoms ? 'medium' : 'low',
      },
    });
  }
  for (const step of steps.slice(0, 4)) {
    questions.push({
      category: 'implementation',
      level: 'beginner',
      text: `Why was "${step.title}" necessary?`,
      answer: {
        text: step.userDescription || 'The project records this step without stating its purpose.',
        grounding: step.id ? [{ type: 'step', id: step.id }] : [],
        generalKnowledge: null,
        confidence: step.userDescription ? 'medium' : 'low',
      },
    });
  }
  questions.push({
    category: 'reflection',
    level: 'advanced',
    text: 'What would you do differently if you repeated this work?',
    answer: {
      text: 'The project does not record a retrospective; answer from your own experience.',
      grounding: [],
      generalKnowledge: null,
      confidence: 'low',
    },
  });
  return { questions };
}

function mockAssistantReply(ctx: Record<string, unknown>): string {
  const question = String(ctx.question ?? '');
  const facts = (ctx.facts ?? []) as string[];
  const header = `Answering from this project's records (offline mode — no model was called).`;
  if (facts.length === 0) {
    return `${header}\n\nI could not find anything in the project matching "${question}". Add steps or evidence and ask again.`;
  }
  return [header, '', `Relevant to "${question}":`, ...facts.slice(0, 8).map((f) => `- ${f}`)].join('\n');
}

/** Stable pseudo-random helper, kept for future mock variability without flakiness. */
export function mockSeed(input: string): number {
  return parseInt(sha256(input).slice(0, 8), 16);
}
