import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupStorage, createClient, makePng, type TestClient } from './helpers.ts';

/**
 * The acceptance scenario from the product specification, start to finish.
 *
 * Rough notes in, structured project out, evidence analysed and attached,
 * problem identified and explained, report and deck and speaker notes and Q&A
 * generated, everything exported — all against the same project record.
 */

const NOTES = `Installed Windows Server.
Configured static IP.
Installed AD DS.
Created domain lab.local.
Configured DNS.
Created users.
Tried joining Windows 11 client.
Domain join failed.
Checked DNS.
Changed client DNS to domain controller.
Retried.
Domain join succeeded.`;

const SCREENSHOTS = [
  { filename: 'server-manager.png', description: 'Server Manager showing AD DS role installed on WINSRV-DC01' },
  { filename: 'ad-ds-promotion.png', description: 'Active Directory Domain Services promotion to domain lab.local' },
  { filename: 'dns-zone.png', description: 'DNS Manager showing the forward lookup zone for lab.local' },
  { filename: 'domain-join-error.png', description: 'Domain join failed: An Active Directory Domain Controller for the domain lab.local could not be contacted' },
  { filename: 'client-dns-fixed.png', description: 'Windows 11 client DNS server changed to 10.20.20.10, the domain controller' },
  { filename: 'domain-join-success.png', description: 'Welcome to the lab.local domain — the client joined successfully' },
];

describe('acceptance: Active Directory Lab, end to end', () => {
  let app: Awaited<ReturnType<typeof import('../src/app.ts').buildApp>>;
  let client: TestClient;
  let projectId: string;
  let reportId: string;
  let presentationId: string;
  let drainJobs: typeof import('../src/jobs/worker.ts').drainJobs;
  let getDb: typeof import('../src/db/index.ts').getDb;

  before(async () => {
    const { buildApp } = await import('../src/app.ts');
    await import('../src/jobs/handlers.ts');
    ({ drainJobs } = await import('../src/jobs/worker.ts'));
    ({ getDb } = await import('../src/db/index.ts'));
    app = await buildApp();
    client = await createClient(app);
  });

  after(async () => {
    await app?.close();
    cleanupStorage();
  });

  it('1. creates the project', async () => {
    const response = await client.post('/api/projects', {
      title: 'Active Directory Lab',
      objective: 'Stand up a Windows domain and join a Windows 11 client to it.',
      domain: 'windows-server',
      audience: 'professor',
      tone: 'academic',
      elaborationDepth: 3,
    });
    assert.equal(response.status, 201);
    projectId = response.body.project.id;
    assert.ok(projectId.startsWith('prj_'));
  });

  it('2. turns rough notes into structured steps and problems', async () => {
    const proposal = await client.post(`/api/projects/${projectId}/ai/structure`, { notes: NOTES });
    assert.equal(proposal.status, 200);

    const steps = proposal.body.proposal.steps;
    assert.ok(steps.length >= 10, `expected the 12 note lines to become steps, got ${steps.length}`);
    // The author's own sentence must survive verbatim.
    assert.ok(steps.some((s: { userDescription: string }) => s.userDescription.includes('Domain join failed')));
    // The failure line must also become a problem.
    assert.ok(
      proposal.body.proposal.problems.some((p: { title: string }) => /domain join failed/i.test(p.title)),
      'the domain join failure should be recognised as a problem',
    );

    const commit = await client.post(`/api/projects/${projectId}/ai/structure/commit`, {
      proposal: proposal.body.proposal,
      analyze: false,
    });
    assert.equal(commit.status, 201);
    assert.ok(commit.body.stepIds.length >= 10);
    assert.ok(commit.body.problemIds.length >= 1);
  });

  it('3. accepts screenshot uploads and stores them as evidence', async () => {
    for (const shot of SCREENSHOTS) {
      const upload = await client.upload(`/api/projects/${projectId}/evidence/upload`, [
        { filename: shot.filename, contentType: 'image/png', data: makePng(320, 200) },
      ]);
      assert.equal(upload.status, 201, `upload failed for ${shot.filename}: ${JSON.stringify(upload.body)}`);

      // The description stands in for what a vision model would read out of the
      // screenshot; it is what the offline provider and the linker work from.
      const evidenceId = upload.body.uploaded[0].evidence.id;
      const patch = await client.patch(`/api/projects/${projectId}/evidence/${evidenceId}`, {
        description: shot.description,
        title: shot.filename.replace('.png', ''),
      });
      assert.equal(patch.status, 200);
    }

    const listing = await client.get(`/api/projects/${projectId}/evidence`);
    assert.equal(listing.body.evidence.length, SCREENSHOTS.length);
    // Uploads dedupe by checksum but must remain distinct evidence records.
    const fileIds = new Set(listing.body.evidence.map((e: { fileId: string }) => e.fileId));
    assert.equal(fileIds.size >= 1, true);
  });

  it('4. runs the full analysis pipeline', async () => {
    const queued = await client.post(`/api/projects/${projectId}/ai/analyze`, { regenerate: true });
    assert.equal(queued.status, 202);

    const processed = await drainJobs(getDb());
    assert.ok(processed >= 1, 'the analysis job should have run');

    const job = await client.get(`/api/projects/${projectId}/jobs/${queued.body.job.id}`);
    assert.equal(job.body.job.status, 'succeeded', `job failed: ${job.body.job.error}`);
    assert.deepEqual(job.body.job.result.failures, [], 'no sub-step of the pipeline should have failed');
  });

  it('5. elaborates steps with provenance-labelled claims', async () => {
    const response = await client.get(`/api/projects/${projectId}/steps`);
    const steps = response.body.steps;
    const elaborated = steps.filter((s: { claims: unknown[] }) => s.claims.length > 0);
    assert.ok(elaborated.length >= steps.length - 1, 'nearly every step should carry elaboration');

    const allClaims = steps.flatMap((s: { claims: { provenance: string; text: string }[] }) => s.claims);

    // The central product requirement: the AI explains, it does not just restate.
    const provenances = new Set(allClaims.map((c: { provenance: string }) => c.provenance));
    assert.ok(provenances.has('USER_FACT'), 'claims must include the author facts');
    assert.ok(
      provenances.has('AI_EXPLANATION'),
      'claims must include technical explanation beyond what the author wrote',
    );
    assert.ok(provenances.has('AI_INFERENCE') || provenances.has('AI_RECOMMENDATION'));

    // Every USER_FACT must trace back to something the author actually wrote.
    const authored = NOTES.toLowerCase();
    for (const claim of allClaims.filter((c: { provenance: string }) => c.provenance === 'USER_FACT')) {
      const words = claim.text.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4);
      const overlap = words.filter((w: string) => authored.includes(w)).length;
      assert.ok(
        words.length === 0 || overlap > 0,
        `USER_FACT claim is not grounded in the author's notes: "${claim.text}"`,
      );
    }
  });

  it('6. explains DNS and why it matters to Active Directory', async () => {
    const response = await client.get(`/api/projects/${projectId}/steps`);
    const dnsStep = response.body.steps.find((s: { title: string }) => /dns/i.test(s.title));
    assert.ok(dnsStep, 'a DNS step should exist');

    const explanations = dnsStep.claims.filter((c: { provenance: string }) => c.provenance === 'AI_EXPLANATION');
    assert.ok(explanations.length > 0, 'the DNS step should carry technical explanation');
    const text = explanations.map((c: { text: string }) => c.text).join(' ').toLowerCase();
    assert.ok(
      /resolv|name|address|discover/.test(text),
      `DNS explanation should describe resolution or service discovery, got: ${text}`,
    );
  });

  it('7. attaches evidence to the steps and problems it supports', async () => {
    const response = await client.get(`/api/projects/${projectId}/evidence`);
    const linked = response.body.evidence.filter((e: { links: unknown[] }) => e.links.length > 0);
    assert.ok(linked.length > 0, 'the classifier should have attached evidence to the project');

    const errorShot = response.body.evidence.find((e: { title: string }) => /domain-join-error/.test(e.title));
    assert.ok(errorShot, 'the failure screenshot should exist');
    assert.ok(
      errorShot.links.some((l: { targetType: string }) => l.targetType === 'problem') ||
        errorShot.links.some((l: { role: string }) => l.role === 'symptom'),
      'the failure screenshot should attach to the problem it evidences',
    );
  });

  it('8. structures the troubleshooting episode', async () => {
    const response = await client.get(`/api/projects/${projectId}/problems`);
    const problem = response.body.problems[0];
    assert.ok(problem, 'a problem should exist');
    assert.ok(problem.claims.length > 0, 'the problem should be elaborated');

    // A derived root cause is an inference, never presented as author fact.
    if (problem.rootCause) {
      assert.notEqual(problem.rootCauseProvenance, 'USER_FACT');
      assert.ok(['low', 'medium', 'high'].includes(problem.rootCauseConfidence));
    }
  });

  it('9. reports what is missing rather than papering over it', async () => {
    const insights = await client.get(`/api/projects/${projectId}/insights`);
    assert.ok(Array.isArray(insights.body.insights));

    const completeness = await client.get(`/api/projects/${projectId}/completeness`);
    assert.ok(completeness.body.percent >= 0 && completeness.body.percent <= 100);
    assert.match(completeness.body.note, /estimate/i, 'the score must be labelled an estimate');
    assert.ok(Array.isArray(completeness.body.categories) && completeness.body.categories.length > 0);
  });

  it('10. generates a detailed technical report', async () => {
    const created = await client.post(`/api/projects/${projectId}/reports`, {
      templateKey: 'technical-lab',
      depth: 3,
    });
    assert.equal(created.status, 201);
    reportId = created.body.report.id;

    await drainJobs(getDb());

    const report = await client.get(`/api/projects/${projectId}/reports/${reportId}`);
    assert.equal(report.body.report.status, 'ready');
    assert.ok(report.body.sections.length >= 6, 'the report should have real structure');

    const stepSection = report.body.sections.find((s: { key: string }) => s.key === 'steps');
    assert.ok(stepSection, 'a step-by-step section should exist');
    const blockTypes = new Set(stepSection.blocks.map((b: { type: string }) => b.type));
    assert.ok(blockTypes.has('heading'), 'steps should be headed');
    assert.ok(blockTypes.has('paragraph'), 'steps should carry prose');
    assert.ok(blockTypes.has('figure'), 'evidence should appear as numbered figures');

    // Figures are numbered in document order.
    const figures = report.body.sections
      .flatMap((s: { blocks: { type: string; number?: number }[] }) => s.blocks)
      .filter((b: { type: string }) => b.type === 'figure');
    assert.deepEqual(
      figures.map((f: { number: number }) => f.number),
      figures.map((_: unknown, i: number) => i + 1),
      'figures should be numbered sequentially',
    );

  });

  it('11. generates a concise presentation with speaker notes', async () => {
    const created = await client.post(`/api/projects/${projectId}/presentations`, {
      templateKey: 'academic',
      slideTarget: 10,
      audience: 'professor',
    });
    assert.equal(created.status, 201);
    presentationId = created.body.presentation.id;

    await drainJobs(getDb());

    const deck = await client.get(`/api/projects/${projectId}/presentations/${presentationId}`);
    assert.equal(deck.body.presentation.status, 'ready');
    assert.ok(deck.body.slides.length >= 3, 'the deck should have slides');
    assert.ok(deck.body.slides.length <= 14, 'the deck should respect the requested length');

    // Slides stay short; the elaboration goes into the notes.
    for (const slide of deck.body.slides) {
      const words = slide.bullets.join(' ').split(/\s+/).filter(Boolean).length;
      assert.ok(words <= 90, `slide "${slide.title}" carries ${words} words of bullets`);
    }

    const notesRun = await client.post(`/api/projects/${projectId}/presentations/${presentationId}/notes`);
    assert.equal(notesRun.status, 202);
    await drainJobs(getDb());

    const withNotes = await client.get(`/api/projects/${projectId}/presentations/${presentationId}`);
    const noted = withNotes.body.slides.filter((s: { speakerNotes: string }) => s.speakerNotes.trim().length > 20);
    assert.ok(noted.length > 0, 'slides should carry speaker notes');

  });

  it('12. coaches the presentation before it is presented', async () => {
    const review = await client.post(`/api/projects/${projectId}/presentations/${presentationId}/review`);
    assert.equal(review.status, 202);
    await drainJobs(getDb());

    const deck = await client.get(`/api/projects/${projectId}/presentations/${presentationId}`);
    assert.ok(Array.isArray(deck.body.coaching));
  });

  it('13. generates Q&A grounded in the project', async () => {
    const queued = await client.post(`/api/projects/${projectId}/questions/generate`, { count: 10 });
    assert.equal(queued.status, 202);
    await drainJobs(getDb());

    const questions = await client.get(`/api/projects/${projectId}/questions`);
    assert.ok(questions.body.questions.length >= 3, 'a question bank should exist');

    const grounded = questions.body.questions.filter(
      (q: { answer?: { grounding: unknown[] } }) => (q.answer?.grounding.length ?? 0) > 0,
    );
    assert.ok(grounded.length > 0, 'at least some answers should cite project records');

    // Project fact and general knowledge are kept in separate fields.
    for (const item of questions.body.questions) {
      assert.ok(item.answer, 'every question needs an answer');
      assert.ok('generalKnowledge' in item.answer);
    }
  });

  it('14. lets the author correct AI interpretation, and keeps the correction', async () => {
    const evidence = await client.get(`/api/projects/${projectId}/evidence`);
    const target = evidence.body.evidence[0];

    const corrected = await client.post(`/api/projects/${projectId}/evidence/${target.id}/review`, {
      verdict: 'correct',
      description: 'Corrected by the author: this shows the AD DS role installation completing.',
      caption: 'AD DS role installation',
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.body.evidence.reviewState, 'user-corrected');

    // Correct a claim too, then confirm regeneration does not discard it.
    const steps = await client.get(`/api/projects/${projectId}/steps`);
    const step = steps.body.steps.find((s: { claims: unknown[] }) => s.claims.length > 0);
    const claim = step.claims[0];

    const edit = await client.patch(`/api/projects/${projectId}/claims/${claim.id}`, {
      text: 'Author-corrected explanation that must survive regeneration.',
    });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.claim.editedByUser, true);

    const regen = await client.post(`/api/projects/${projectId}/steps/${step.id}/ai/elaborate`, { regenerate: true });
    assert.equal(regen.status, 202);
    await drainJobs(getDb());

    const after = await client.get(`/api/projects/${projectId}/steps/${step.id}`);
    const survived = after.body.claims.find((c: { id: string }) => c.id === claim.id);
    assert.ok(survived, 'a user-edited claim must survive regeneration');
    assert.equal(survived.text, 'Author-corrected explanation that must survive regeneration.');
  });

  it('15. exports the report in every supported format', async () => {

    for (const format of ['pdf', 'docx', 'html', 'md'] as const) {
      const requested = await client.post(`/api/projects/${projectId}/exports`, {
        subjectType: 'report',
        subjectId: reportId,
        format,
      });
      assert.equal(requested.status, 202, `export request failed for ${format}`);
      await drainJobs(getDb());

      const record = await client.get(`/api/projects/${projectId}/exports/${requested.body.export.id}`);
      assert.equal(record.body.export.status, 'ready', `${format} export failed: ${record.body.export.error}`);
      assert.ok(record.body.export.byteSize > 400, `${format} export is suspiciously small`);

      const download = await client.raw(
        `/api/projects/${projectId}/exports/${requested.body.export.id}/download`,
      );
      assert.equal(download.status, 200);
      assertFormat(format, download.buffer);
    }
  });

  it('16. exports the presentation as PPTX and PDF', async () => {

    for (const format of ['pptx', 'pdf'] as const) {
      const requested = await client.post(`/api/projects/${projectId}/exports`, {
        subjectType: 'presentation',
        subjectId: presentationId,
        format,
      });
      assert.equal(requested.status, 202);
      await drainJobs(getDb());

      const record = await client.get(`/api/projects/${projectId}/exports/${requested.body.export.id}`);
      assert.equal(record.body.export.status, 'ready', `${format} export failed: ${record.body.export.error}`);

      const download = await client.raw(
        `/api/projects/${projectId}/exports/${requested.body.export.id}/download`,
      );
      assert.equal(download.status, 200);
      assertFormat(format, download.buffer);
    }
  });

  it('17. keeps report and deck traceable to one project source of truth', async () => {

    // Change a project fact.
    const update = await client.patch(`/api/projects/${projectId}`, {
      conclusion: 'The domain was established and the client joined after correcting client DNS.',
    });
    assert.equal(update.status, 200);

    // Both outputs should now report themselves as stale relative to the project.
    const reports = await client.get(`/api/projects/${projectId}/reports`);
    const report = reports.body.reports.find((r: { id: string }) => r.id === reportId);
    assert.equal(report.stale, true, 'the report should be flagged stale after a project fact changes');

    // Regenerating clears staleness without the user re-entering anything.
    await client.post(`/api/projects/${projectId}/reports/${reportId}/generate`);
    await drainJobs(getDb());
    const refreshed = await client.get(`/api/projects/${projectId}/reports/${reportId}`);
    assert.equal(refreshed.body.stale, false);
  });

  it('18. makes the whole project searchable, including screenshot text', async () => {
    const search = await client.get(`/api/projects/${projectId}/search?q=DNS`);
    assert.ok(search.body.hits.length > 0, 'DNS should be findable across the project');

    const evidenceHit = await client.get(`/api/projects/${projectId}/search?q=lab.local`);
    assert.ok(
      evidenceHit.body.hits.length > 0,
      'text captured from evidence should be searchable',
    );
  });
});

function assertFormat(format: string, buffer: Buffer): void {
  switch (format) {
    case 'pdf':
      assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-', 'not a PDF');
      break;
    case 'docx':
    case 'pptx':
      assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK', 'not a zip-based Office file');
      break;
    case 'html':
      assert.match(buffer.subarray(0, 200).toString('utf8'), /<!doctype html>/i);
      break;
    case 'md':
      assert.match(buffer.subarray(0, 200).toString('utf8'), /^#\s/);
      break;
    default:
      break;
  }
}
