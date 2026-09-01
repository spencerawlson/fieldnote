import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/index.ts';
import {
  createExport,
  createPresentation,
  createReport,
  deletePresentation,
  deleteQuestion,
  deleteReport,
  deleteSlide,
  getExport,
  type ExportRecord,
  getPresentation,
  getReport,
  getSection,
  getSlide,
  listExports,
  listPresentations,
  listQuestions,
  listReports,
  listSections,
  listSlides,
  reorderSlides,
  updateAnswer,
  updatePresentation,
  updateQuestion,
  updateReport,
  updateSection,
  updateSlide,
} from '../db/repositories/outputs.ts';
import { enqueueJob, recordVersion, audit } from '../db/repositories/system.ts';
import { listInsights } from '../db/repositories/knowledge.ts';
import { getReportTemplate, getPresentationTemplate, PRESENTATION_TEMPLATES, REPORT_TEMPLATES } from '../domain/templates.ts';
import { getTheme, themesFor } from '../export/themes.ts';
import { buildProjectContext } from '../ai/context.ts';
import { projectKnowledgeHash } from '../ai/services/report.ts';
import { contentTypeFor, exportFileName } from '../export/render.ts';
import { getStorage } from '../files/storage.ts';
import { authorizeProject } from '../security/auth.ts';
import { parse, text, optionalText, depthSchema, z } from '../lib/validate.ts';
import { AppError, notFound, badRequest } from '../lib/core.ts';
import { TONES, VOICES } from '../domain/types.ts';

/** Themes are described to the client by their visible qualities, not their
 *  internal colour table — the picker shows a swatch and a sentence. */
function themeSummary(theme: ReturnType<typeof getTheme>) {
  return {
    key: theme.key,
    name: theme.name,
    description: theme.description,
    accent: `#${theme.palette.accent}`,
    cover: `#${theme.palette.cover}`,
    coverInk: `#${theme.palette.coverInk}`,
    surface: `#${theme.palette.surface}`,
    serif: theme.fonts.body === 'Cambria',
  };
}

export async function outputRoutes(app: FastifyInstance): Promise<void> {
  // --- templates ----------------------------------------------------------

  app.get('/api/templates', async () => ({
    reports: REPORT_TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      defaultTone: t.defaultTone,
      defaultAudience: t.defaultAudience,
      sections: t.sections.map((s) => ({ key: s.key, heading: s.heading, derived: Boolean(s.derived) })),
    })),
    presentations: PRESENTATION_TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      defaultTone: t.defaultTone,
      defaultAudience: t.defaultAudience,
      slideCount: t.slides.length,
      slides: t.slides.map((s) => ({ key: s.key, title: s.title })),
    })),
    themes: {
      report: themesFor('report').map(themeSummary),
      presentation: themesFor('presentation').map(themeSummary),
    },
  }));

  // --- reports ------------------------------------------------------------

  app.get('/api/projects/:projectId/reports', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    const context = buildProjectContext(db, projectId, { evidenceTextChars: 1 });
    const currentHash = projectKnowledgeHash(context);
    return {
      reports: listReports(db, projectId).map((report) => ({
        ...report,
        stale: report.sourceHash !== null && report.sourceHash !== currentHash,
        sections: listSections(db, report.id).length,
      })),
    };
  });

  app.post('/api/projects/:projectId/reports', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db, project, user } = authorizeProject(request, projectId, 'editor');
    const body = parse(
      z.object({
        templateKey: text(60).default('technical'),
        title: text(200).optional(),
        subtitle: optionalText(300),
        author: optionalText(150),
        tone: z.enum(TONES).optional(),
        audience: text(60).optional(),
        depth: depthSchema.optional(),
        theme: text(30).optional(),
        voice: z.enum(VOICES).optional(),
        generate: z.boolean().default(true),
      }),
      request.body ?? {},
    );

    const template = getReportTemplate(body.templateKey);
    const report = createReport(db, {
      projectId,
      templateKey: template.key,
      title: body.title ?? project.title,
      subtitle: body.subtitle ?? project.summary ?? null,
      author: body.author ?? null,
      tone: body.tone ?? template.defaultTone,
      audience: body.audience ?? template.defaultAudience,
      depth: body.depth ?? Math.max(2, project.elaborationDepth),
      theme: getTheme(body.theme).key,
      voice: body.voice ?? project.voice,
    });

    let jobId: string | null = null;
    if (body.generate) {
      jobId = enqueueJob(db, { projectId, userId: user.id, type: 'report.generate', payload: { projectId, reportId: report.id } }).id;
    }
    audit(db, { projectId, userId: user.id, action: 'report.create', entityType: 'report', entityId: report.id, ip: request.ip });
    return reply.code(201).send({ report, jobId });
  });

  app.get('/api/projects/:projectId/reports/:reportId', async (request) => {
    const { projectId, reportId } = request.params as { projectId: string; reportId: string };
    const { db } = authorizeProject(request, projectId);
    const report = getReport(db, reportId);
    if (!report || report.projectId !== projectId) throw notFound('Report');
    const context = buildProjectContext(db, projectId, { evidenceTextChars: 1 });
    return {
      report,
      stale: report.sourceHash !== null && report.sourceHash !== projectKnowledgeHash(context),
      sections: listSections(db, reportId),
      exports: listExports(db, 'report', reportId),
    };
  });

  app.patch('/api/projects/:projectId/reports/:reportId', async (request) => {
    const { projectId, reportId } = request.params as { projectId: string; reportId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const report = getReport(db, reportId);
    if (!report || report.projectId !== projectId) throw notFound('Report');
    const body = parse(
      z.object({
        title: text(200).optional(),
        subtitle: optionalText(300),
        author: optionalText(150),
        tone: z.enum(TONES).optional(),
        audience: text(60).optional(),
        depth: depthSchema.optional(),
        theme: text(30).optional(),
        voice: z.enum(VOICES).optional(),
      }),
      request.body,
    );
    // An unknown theme key falls back to the default rather than being stored
    // and failing at render time.
    const patch = body.theme ? { ...body, theme: getTheme(body.theme).key } : body;
    return { report: updateReport(db, reportId, patch) };
  });

  app.post('/api/projects/:projectId/reports/:reportId/generate', async (request, reply) => {
    const { projectId, reportId } = request.params as { projectId: string; reportId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const report = getReport(db, reportId);
    if (!report || report.projectId !== projectId) throw notFound('Report');
    const job = enqueueJob(db, { projectId, userId: user.id, type: 'report.generate', payload: { projectId, reportId } });
    return reply.code(202).send({ job });
  });

  app.patch('/api/projects/:projectId/reports/:reportId/sections/:sectionId', async (request) => {
    const { projectId, reportId, sectionId } = request.params as { projectId: string; reportId: string; sectionId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const report = getReport(db, reportId);
    if (!report || report.projectId !== projectId) throw notFound('Report');
    const existing = getSection(db, sectionId);
    if (!existing || existing.reportId !== reportId) throw notFound('Section');

    const body = parse(
      z.object({
        heading: text(200).optional(),
        blocks: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
      request.body,
    );

    recordVersion(db, { projectId, entityType: 'report_section', entityId: sectionId, actorType: 'user', actorId: user.id, reason: 'edit', snapshot: existing });
    // Marking the section as user-edited protects it from the next regeneration.
    const section = updateSection(db, sectionId, { ...body, editedByUser: true });
    return { section };
  });

  app.delete('/api/projects/:projectId/reports/:reportId', async (request) => {
    const { projectId, reportId } = request.params as { projectId: string; reportId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    deleteReport(db, reportId);
    return { ok: true };
  });

  // --- presentations ------------------------------------------------------

  app.get('/api/projects/:projectId/presentations', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    const context = buildProjectContext(db, projectId, { evidenceTextChars: 1 });
    const currentHash = projectKnowledgeHash(context);
    return {
      presentations: listPresentations(db, projectId).map((presentation) => ({
        ...presentation,
        stale: presentation.sourceHash !== null && presentation.sourceHash !== currentHash,
        slides: listSlides(db, presentation.id).length,
      })),
    };
  });

  app.post('/api/projects/:projectId/presentations', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db, project, user } = authorizeProject(request, projectId, 'editor');
    const body = parse(
      z.object({
        templateKey: text(60).default('technical-demo'),
        title: text(200).optional(),
        subtitle: optionalText(300),
        presenter: optionalText(150),
        audience: text(60).optional(),
        tone: z.enum(TONES).optional(),
        slideTarget: z.coerce.number().int().min(3).max(40).default(12),
        theme: text(30).default('slate'),
        voice: z.enum(VOICES).optional(),
        generate: z.boolean().default(true),
      }),
      request.body ?? {},
    );

    const template = getPresentationTemplate(body.templateKey);
    const presentation = createPresentation(db, {
      projectId,
      templateKey: template.key,
      title: body.title ?? project.title,
      subtitle: body.subtitle ?? project.objective ?? null,
      presenter: body.presenter ?? null,
      audience: body.audience ?? template.defaultAudience,
      tone: body.tone ?? template.defaultTone,
      slideTarget: body.slideTarget,
      theme: getTheme(body.theme).key,
      voice: body.voice ?? project.voice,
    });

    let jobId: string | null = null;
    if (body.generate) {
      jobId = enqueueJob(db, {
        projectId,
        userId: user.id,
        type: 'presentation.generate',
        payload: { projectId, presentationId: presentation.id },
      }).id;
    }
    return reply.code(201).send({ presentation, jobId });
  });

  app.get('/api/projects/:projectId/presentations/:presentationId', async (request) => {
    const { projectId, presentationId } = request.params as { projectId: string; presentationId: string };
    const { db } = authorizeProject(request, projectId);
    const presentation = getPresentation(db, presentationId);
    if (!presentation || presentation.projectId !== projectId) throw notFound('Presentation');
    const context = buildProjectContext(db, projectId, { evidenceTextChars: 1 });
    return {
      presentation,
      stale: presentation.sourceHash !== null && presentation.sourceHash !== projectKnowledgeHash(context),
      slides: listSlides(db, presentationId),
      coaching: listInsights(db, projectId, { scope: 'presentation', scopeId: presentationId, state: 'open' }),
      exports: listExports(db, 'presentation', presentationId),
    };
  });

  app.patch('/api/projects/:projectId/presentations/:presentationId', async (request) => {
    const { projectId, presentationId } = request.params as { projectId: string; presentationId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const presentation = getPresentation(db, presentationId);
    if (!presentation || presentation.projectId !== projectId) throw notFound('Presentation');
    const body = parse(
      z.object({
        title: text(200).optional(),
        subtitle: optionalText(300),
        presenter: optionalText(150),
        audience: text(60).optional(),
        tone: z.enum(TONES).optional(),
        slideTarget: z.coerce.number().int().min(3).max(40).optional(),
        theme: text(30).optional(),
        voice: z.enum(VOICES).optional(),
      }),
      request.body,
    );
    const patch = body.theme ? { ...body, theme: getTheme(body.theme).key } : body;
    return { presentation: updatePresentation(db, presentationId, patch) };
  });

  for (const action of ['generate', 'notes', 'review'] as const) {
    app.post(`/api/projects/:projectId/presentations/:presentationId/${action}`, async (request, reply) => {
      const { projectId, presentationId } = request.params as { projectId: string; presentationId: string };
      const { db, user } = authorizeProject(request, projectId, 'editor');
      const presentation = getPresentation(db, presentationId);
      if (!presentation || presentation.projectId !== projectId) throw notFound('Presentation');
      const job = enqueueJob(db, {
        projectId,
        userId: user.id,
        type: `presentation.${action}`,
        payload: { projectId, presentationId },
      });
      return reply.code(202).send({ job });
    });
  }

  app.patch('/api/projects/:projectId/slides/:slideId', async (request) => {
    const { projectId, slideId } = request.params as { projectId: string; slideId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const existing = getSlide(db, slideId);
    if (!existing) throw notFound('Slide');
    const presentation = getPresentation(db, existing.presentationId);
    if (!presentation || presentation.projectId !== projectId) throw notFound('Slide');

    const body = parse(
      z.object({
        title: text(200).optional(),
        subtitle: optionalText(300),
        bullets: z.array(text(400)).max(12).optional(),
        speakerNotes: text(20_000).optional(),
        layout: z
          .enum(['title', 'bullets', 'bullets-image', 'image', 'two-column', 'before-after', 'table', 'quote', 'code', 'diagram', 'closing'])
          .optional(),
        evidenceIds: z.array(z.string()).max(4).optional(),
        body: z.record(z.string(), z.unknown()).optional(),
      }),
      request.body,
    );

    recordVersion(db, { projectId, entityType: 'slide', entityId: slideId, actorType: 'user', actorId: user.id, reason: 'edit', snapshot: existing });
    return { slide: updateSlide(db, slideId, { ...body, editedByUser: true }) };
  });

  app.delete('/api/projects/:projectId/slides/:slideId', async (request) => {
    const { projectId, slideId } = request.params as { projectId: string; slideId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const slide = getSlide(db, slideId);
    if (!slide) throw notFound('Slide');
    const presentation = getPresentation(db, slide.presentationId);
    if (!presentation || presentation.projectId !== projectId) throw notFound('Slide');
    deleteSlide(db, slideId);
    return { ok: true };
  });

  app.post('/api/projects/:projectId/presentations/:presentationId/reorder', async (request) => {
    const { projectId, presentationId } = request.params as { projectId: string; presentationId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const presentation = getPresentation(db, presentationId);
    if (!presentation || presentation.projectId !== projectId) throw notFound('Presentation');
    const body = parse(z.object({ orderedIds: z.array(z.string()).min(1) }), request.body);
    reorderSlides(db, presentationId, body.orderedIds);
    return { slides: listSlides(db, presentationId) };
  });

  app.delete('/api/projects/:projectId/presentations/:presentationId', async (request) => {
    const { projectId, presentationId } = request.params as { projectId: string; presentationId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    deletePresentation(db, presentationId);
    return { ok: true };
  });

  // --- Q&A ----------------------------------------------------------------

  app.get('/api/projects/:projectId/questions', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    return { questions: listQuestions(db, projectId) };
  });

  app.post('/api/projects/:projectId/questions/generate', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const body = parse(
      z.object({ presentationId: z.string().nullable().optional(), count: z.coerce.number().int().min(4).max(40).optional() }),
      request.body ?? {},
    );
    const job = enqueueJob(db, { projectId, userId: user.id, type: 'qa.generate', payload: { projectId, ...body } });
    return reply.code(202).send({ job });
  });

  app.patch('/api/projects/:projectId/questions/:questionId', async (request) => {
    const { projectId, questionId } = request.params as { projectId: string; questionId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const body = parse(
      z.object({
        text: text(2000, 1).optional(),
        category: text(60).optional(),
        level: z.enum(['beginner', 'intermediate', 'advanced', 'expert']).optional(),
      }),
      request.body,
    );
    return { question: updateQuestion(db, questionId, { ...body, editedByUser: true }) };
  });

  app.patch('/api/projects/:projectId/answers/:answerId', async (request) => {
    const { projectId, answerId } = request.params as { projectId: string; answerId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const body = parse(
      z.object({ text: text(20_000, 1).optional(), generalKnowledge: optionalText(8000) }),
      request.body,
    );
    return { answer: updateAnswer(db, answerId, { ...body, editedByUser: true }) };
  });

  app.delete('/api/projects/:projectId/questions/:questionId', async (request) => {
    const { projectId, questionId } = request.params as { projectId: string; questionId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    deleteQuestion(db, questionId);
    return { ok: true };
  });

  // --- exports ------------------------------------------------------------

  app.post('/api/projects/:projectId/exports', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db, user } = authorizeProject(request, projectId);
    const body = parse(
      z.object({
        subjectType: z.enum(['report', 'presentation', 'project']),
        subjectId: z.string().min(3),
        format: z.enum(['pdf', 'docx', 'html', 'md', 'pptx', 'json']),
      }),
      request.body,
    );

    // Verify the subject belongs to this project before rendering anything.
    if (body.subjectType === 'report') {
      const report = getReport(db, body.subjectId);
      if (!report || report.projectId !== projectId) throw notFound('Report');
      if (report.status !== 'ready') throw badRequest('Generate the report before exporting it');
      if (body.format === 'pptx') throw badRequest('Reports cannot be exported as PPTX');
    } else if (body.subjectType === 'presentation') {
      const presentation = getPresentation(db, body.subjectId);
      if (!presentation || presentation.projectId !== projectId) throw notFound('Presentation');
      if (presentation.status !== 'ready') throw badRequest('Generate the presentation before exporting it');
      if (body.format === 'docx') throw badRequest('Presentations cannot be exported as DOCX');
    } else if (body.subjectId !== projectId) {
      throw badRequest('Project exports must reference their own project id');
    }

    const record = createExport(db, { projectId, ...body });
    const job = enqueueJob(db, { projectId, userId: user.id, type: 'export.render', payload: { exportId: record.id } });
    audit(db, { projectId, userId: user.id, action: 'export.request', entityType: body.subjectType, entityId: body.subjectId, ip: request.ip, detail: { format: body.format } });
    return reply.code(202).send({ export: record, job });
  });

  app.get('/api/projects/:projectId/exports/:exportId', async (request) => {
    const { projectId, exportId } = request.params as { projectId: string; exportId: string };
    const { db } = authorizeProject(request, projectId);
    const record = getExport(db, exportId);
    if (!record || record.projectId !== projectId) throw notFound('Export');
    return { export: { ...record, fileName: exportNameFor(db, record) } };
  });

  app.get('/api/projects/:projectId/exports/:exportId/download/:fileName', downloadExport);
  app.get('/api/projects/:projectId/exports/:exportId/download', downloadExport);

  async function downloadExport(request: FastifyRequest, reply: FastifyReply) {
    const { projectId, exportId } = request.params as { projectId: string; exportId: string };
    const { db } = authorizeProject(request, projectId);
    const record = getExport(db, exportId);
    if (!record || record.projectId !== projectId) throw notFound('Export');
    if (record.status !== 'ready' || !record.storageKey) {
      throw new AppError(409, 'export_not_ready', `The export is ${record.status}. Wait for it to finish.`);
    }

    const bytes = await getStorage().read(record.storageKey);
    return reply
      .header('Content-Type', contentTypeFor(record.format))
      .header('Content-Disposition', `attachment; filename="${exportNameFor(db, record)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .send(bytes);
  }
}

/** The filename a download will present, derived the same way the route does. */
function exportNameFor(db: Database, record: ExportRecord): string {
  const subjectTitle =
    record.subjectType === 'report'
      ? getReport(db, record.subjectId)?.title
      : record.subjectType === 'presentation'
        ? getPresentation(db, record.subjectId)?.title
        : 'project';
  return exportFileName(subjectTitle ?? 'export', record.format, record.subjectType);
}
