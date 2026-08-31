import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.ts'; // sets test environment before app modules load

describe('knowledge model', () => {
  it('separates factual provenance from generated provenance', async () => {
    const { isFactual, PROVENANCE } = await import('../src/domain/types.ts');
    assert.equal(isFactual('USER_FACT'), true);
    assert.equal(isFactual('EVIDENCE'), true);
    assert.equal(isFactual('AI_EXPLANATION'), false);
    assert.equal(isFactual('AI_INFERENCE'), false);
    assert.equal(isFactual('AI_RECOMMENDATION'), false);
    assert.equal(PROVENANCE.length, 5);
  });

  it('marks a step stale when the author edits its substance', async () => {
    const { createTestDb } = await import('../src/db/index.ts');
    const { createUser } = await import('../src/db/repositories/system.ts');
    const { createProject } = await import('../src/db/repositories/projects.ts');
    const { createStep, updateStep, getStep } = await import('../src/db/repositories/steps.ts');

    const db = createTestDb();
    const user = createUser(db, { email: 'u@test', name: 'U', passwordHash: 'x' });
    const project = createProject(db, { ownerId: user.id, title: 'P' });
    const step = createStep(db, { projectId: project.id, title: 'Configure DNS', userDescription: 'Set DNS to the DC' });

    updateStep(db, step.id, { aiState: 'elaborated' });
    assert.equal(getStep(db, step.id)?.aiState, 'elaborated');

    // A cosmetic field must not invalidate the elaboration...
    updateStep(db, step.id, { occurredAt: new Date().toISOString() });
    assert.equal(getStep(db, step.id)?.aiState, 'elaborated');

    // ...but changing what the author actually said must.
    updateStep(db, step.id, { userDescription: 'Set DNS to 10.20.20.10, the domain controller' });
    assert.equal(getStep(db, step.id)?.aiState, 'stale');
    db.close();
  });

  it('preserves human-edited claims across regeneration', async () => {
    const { createTestDb } = await import('../src/db/index.ts');
    const { createUser } = await import('../src/db/repositories/system.ts');
    const { createProject } = await import('../src/db/repositories/projects.ts');
    const { createClaim, updateClaim, replaceGeneratedClaims, listClaims } = await import(
      '../src/db/repositories/knowledge.ts'
    );

    const db = createTestDb();
    const user = createUser(db, { email: 'u@test', name: 'U', passwordHash: 'x' });
    const project = createProject(db, { ownerId: user.id, title: 'P' });

    const generated = createClaim(db, {
      projectId: project.id,
      subjectType: 'step',
      subjectId: 'stp_x',
      slot: 'why_it_matters',
      provenance: 'AI_EXPLANATION',
      text: 'Original generated text',
    });
    const edited = createClaim(db, {
      projectId: project.id,
      subjectType: 'step',
      subjectId: 'stp_x',
      slot: 'what_was_done',
      provenance: 'USER_FACT',
      text: 'Author wrote this',
    });
    updateClaim(db, edited.id, { editedByUser: true });

    replaceGeneratedClaims(
      db,
      'step',
      'stp_x',
      [
        { projectId: project.id, subjectType: 'step', subjectId: 'stp_x', slot: 'why_it_matters', provenance: 'AI_EXPLANATION', text: 'Fresh text' },
        { projectId: project.id, subjectType: 'step', subjectId: 'stp_x', slot: 'what_was_done', provenance: 'AI_INFERENCE', text: 'Model would overwrite this' },
      ],
      'gen_1',
    );

    const after = listClaims(db, 'step', 'stp_x');
    const survivor = after.find((c) => c.id === edited.id);
    assert.ok(survivor, 'the human-edited claim must survive');
    assert.equal(survivor.text, 'Author wrote this');
    assert.equal(after.find((c) => c.id === generated.id), undefined, 'untouched generated claims are replaced');
    assert.ok(after.some((c) => c.text === 'Fresh text'));
    db.close();
  });

  it('keeps dismissed insights dismissed across re-analysis', async () => {
    const { createTestDb } = await import('../src/db/index.ts');
    const { createUser } = await import('../src/db/repositories/system.ts');
    const { createProject } = await import('../src/db/repositories/projects.ts');
    const { replaceInsights, listInsights, setInsightState } = await import('../src/db/repositories/knowledge.ts');

    const db = createTestDb();
    const user = createUser(db, { email: 'u@test', name: 'U', passwordHash: 'x' });
    const project = createProject(db, { ownerId: user.id, title: 'P' });

    const base = {
      runId: null,
      kind: 'missing-evidence' as const,
      severity: 'info' as const,
      detail: 'd',
      suggestion: null,
      targets: [],
      confidence: 'high' as const,
    };
    const [first] = replaceInsights(db, project.id, 'project', null, [{ ...base, title: 'No evidence on step 1' }]);
    setInsightState(db, first!.id, 'dismissed');

    replaceInsights(db, project.id, 'project', null, [
      { ...base, title: 'No evidence on step 1' },
      { ...base, title: 'No evidence on step 2' },
    ]);

    const open = listInsights(db, project.id, { state: 'open' });
    assert.equal(open.length, 1);
    assert.equal(open[0]!.title, 'No evidence on step 2', 'a dismissed finding must not come back');
    db.close();
  });

  it('scores completeness from what the project holds, and labels it an estimate', async () => {
    const { createTestDb } = await import('../src/db/index.ts');
    const { createUser } = await import('../src/db/repositories/system.ts');
    const { createProject } = await import('../src/db/repositories/projects.ts');
    const { createStep } = await import('../src/db/repositories/steps.ts');
    const { computeCompleteness } = await import('../src/ai/services/consistency.ts');

    const db = createTestDb();
    const user = createUser(db, { email: 'u@test', name: 'U', passwordHash: 'x' });
    const empty = createProject(db, { ownerId: user.id, title: 'Empty' });
    const emptyScore = computeCompleteness(db, empty.id);
    assert.ok(emptyScore.percent < 30, `an empty project should score low, got ${emptyScore.percent}`);
    assert.ok(emptyScore.missing.some((m) => /objective/i.test(m)));
    assert.match(emptyScore.note, /estimate/i);

    createStep(db, { projectId: empty.id, title: 'Did a thing', userDescription: 'A properly described step here' });
    const withStep = computeCompleteness(db, empty.id);
    assert.ok(withStep.percent > emptyScore.percent, 'adding documented work should raise the score');
    db.close();
  });
});

describe('templates', () => {
  it('trims a deck to the requested length, keeping the spine', async () => {
    const { getPresentationTemplate, planSlides } = await import('../src/domain/templates.ts');
    const template = getPresentationTemplate('technical-demo');

    const short = planSlides(template, 5);
    assert.equal(short.length, 5);
    assert.equal(short[0]!.key, 'title', 'the title slide is never dropped');
    assert.equal(short[short.length - 1]!.key, 'conclusion', 'the closing slide is never dropped');
    // The lowest-priority slots go first.
    assert.ok(!short.some((s) => s.key === 'architecture'));

    const long = planSlides(template, 40);
    assert.equal(long.length, template.slides.length, 'asking for more slides than exist does not invent any');
  });

  it('never lets a template invent content', async () => {
    const { REPORT_TEMPLATES } = await import('../src/domain/templates.ts');
    for (const template of REPORT_TEMPLATES) {
      for (const section of template.sections) {
        assert.ok(section.key && section.heading && section.intent);
        // A template describes intent; it carries no prose of its own.
        assert.equal('content' in section, false);
      }
    }
  });
});

describe('export validation', () => {
  it('flags a missing image as an error, not a silent omission', async () => {
    const { validateReport } = await import('../src/export/validate.ts');
    const findings = validateReport({
      kind: 'report',
      id: 'rpt_1',
      title: 'T',
      subtitle: null,
      author: null,
      projectTitle: 'P',
      templateKey: 'technical',
      theme: 'slate',
      generatedAt: new Date().toISOString(),
      meta: { tone: 'technical', audience: 'technical-team', depth: 3, version: 1 },
      sections: [
        {
          key: 'steps',
          heading: 'Steps',
          blocks: [{ type: 'figure', evidenceId: 'evd_missing', caption: 'Gone', number: 1 }],
        },
      ],
      figures: new Map([
        ['evd_missing', { evidenceId: 'evd_missing', number: 1, caption: 'Gone', bytes: null, mimeType: null, width: null, height: null, missingReason: 'Stored file is missing' }],
      ]),
    });
    const error = findings.find((f) => f.code === 'missing-image');
    assert.ok(error, 'a missing figure must be reported');
    assert.equal(error.level, 'error');
    assert.match(error.message, /Stored file is missing/);
  });

  it('flags ragged tables and text-heavy slides', async () => {
    const { validateReport, validatePresentation } = await import('../src/export/validate.ts');

    const tableFindings = validateReport({
      kind: 'report',
      id: 'rpt_1',
      title: 'T',
      subtitle: null,
      author: null,
      projectTitle: 'P',
      templateKey: 'technical',
      theme: 'slate',
      generatedAt: new Date().toISOString(),
      meta: { tone: 'technical', audience: 'technical-team', depth: 3, version: 1 },
      sections: [
        {
          key: 'testing',
          heading: 'Testing',
          blocks: [{ type: 'table', headers: ['A', 'B'], rows: [['1', '2'], ['only one']] }],
        },
      ],
      figures: new Map(),
    });
    assert.ok(tableFindings.some((f) => f.code === 'table-shape' && f.level === 'error'));

    const deckFindings = validatePresentation({
      kind: 'presentation',
      id: 'prs_1',
      title: 'T',
      subtitle: null,
      presenter: null,
      projectTitle: 'P',
      generatedAt: new Date().toISOString(),
      theme: 'slate',
      slides: [
        {
          id: 'sld_1',
          position: 0,
          layout: 'bullets',
          title: 'Wall of text',
          subtitle: null,
          bullets: [Array.from({ length: 80 }, () => 'word').join(' ')],
          body: {},
          speakerNotes: '',
          figures: [],
        },
      ],
    });
    assert.ok(deckFindings.some((f) => f.code === 'slide-text-heavy'));
    assert.ok(deckFindings.some((f) => f.code === 'missing-conclusion'));
  });
});

describe('AI provider abstraction', () => {
  it('recovers JSON that the model wrapped in prose or fences', async () => {
    const { extractJson } = await import('../src/ai/provider.ts');
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
    assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
    assert.throws(() => extractJson('not json at all'), /not valid JSON/);
  });

  it('estimates cost per model and does not report unknown models as free', async () => {
    const { costCents, priceFor } = await import('../src/ai/provider.ts');
    assert.ok(costCents('gpt-5', 1_000_000, 0) > 0);
    assert.ok(costCents('gpt-5', 0, 1_000_000) > costCents('gpt-5', 1_000_000, 0), 'output costs more than input');
    assert.equal(costCents('mock', 1_000_000, 1_000_000), 0);

    const unknown = priceFor('some-model-we-have-never-seen');
    assert.equal(unknown.estimated, true);
    assert.ok(unknown.inputCentsPerMTok > 0, 'an unknown model must not be priced at zero');

    // A dated snapshot inherits its family price.
    assert.equal(priceFor('gpt-5-2026-01-01').inputCentsPerMTok, priceFor('gpt-5').inputCentsPerMTok);
  });

  it('falls back to the offline provider when no key is configured', async () => {
    const { providerInfo } = await import('../src/ai/registry.ts');
    const info = providerInfo();
    assert.equal(info.name, 'mock');
    assert.equal(info.offline, true);
  });
});

describe('search', () => {
  it('quotes FTS operators so a literal query cannot become a syntax error', async () => {
    const { toFtsQuery } = await import('../src/db/repositories/system.ts');
    assert.equal(toFtsQuery('dns'), '"dns"*');
    assert.equal(toFtsQuery('lab.local dns'), '"lab.local"* AND "dns"*');
    // Characters FTS5 treats as operators must not reach the parser.
    assert.equal(toFtsQuery('OR AND *'), '"OR"* AND "AND"*');
    assert.equal(toFtsQuery('   '), '');
  });
});
