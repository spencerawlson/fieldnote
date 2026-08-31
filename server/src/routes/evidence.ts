import type { FastifyInstance } from 'fastify';
import {
  countFiles,
  createEvidence,
  createFile,
  deleteEvidence,
  findFileByChecksum,
  getEvidence,
  getFile,
  getLatestImageAnalysis,
  getLatestOcr,
  linkEvidence,
  listEvidence,
  listEvidenceLinks,
  listLinksForEvidence,
  softDeleteFile,
  unlinkEvidence,
  updateEvidence,
} from '../db/repositories/evidence.ts';
import { audit, enqueueJob, recordVersion } from '../db/repositories/system.ts';
import { getStorage, buildStorageKey, buildThumbKey } from '../files/storage.ts';
import { assertSize, checksum, detectType, evidenceKindFor, processImage } from '../files/images.ts';
import { reindexEvidence, storeOcrText } from '../ai/services/vision.ts';
import { authorizeProject } from '../security/auth.ts';
import { parse, text, optionalText, confidenceSchema, z } from '../lib/validate.ts';
import { AppError, badRequest, notFound } from '../lib/core.ts';
import { detectSecrets } from '../ai/safety.ts';
import { recordSecretFinding } from '../db/repositories/evidence.ts';

/**
 * Evidence and file routes.
 *
 * Uploads are buffered, type-checked against magic bytes, hashed, thumbnailed
 * and stored under an opaque key. Bytes are only ever served back through
 * `/files/:fileId`, which re-checks project membership on every request — the
 * storage directory is never exposed statically.
 */

export async function evidenceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/projects/:projectId/evidence/upload',
    { config: { rateLimit: { max: 120, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { db, user } = authorizeProject(request, projectId, 'editor');

      if (!request.isMultipart()) throw badRequest('Expected a multipart upload');
      if (countFiles(db, projectId) >= 500) {
        throw badRequest('This project has reached its file limit. Delete unused evidence first.');
      }

      const created: unknown[] = [];
      const parts = request.parts();

      for await (const part of parts) {
        if (part.type !== 'file') continue;

        const buffer = await part.toBuffer();
        assertSize(buffer.length);
        const detected = detectType(buffer, part.mimetype, part.filename);
        const digest = checksum(buffer);

        // Re-uploading the same bytes reuses the stored file rather than
        // duplicating it, but still creates a distinct evidence record.
        let file = findFileByChecksum(db, projectId, digest);
        if (!file) {
          const { meta, thumbnail } = await processImage(buffer, detected.mime);
          const fileId = `pending-${digest.slice(0, 12)}`;
          const storageKey = buildStorageKey(projectId, fileId, detected.extension);
          await getStorage().writeBuffer(storageKey, buffer);

          let thumbKey: string | null = null;
          if (thumbnail) {
            thumbKey = buildThumbKey(projectId, fileId);
            await getStorage().writeBuffer(thumbKey, thumbnail);
          }

          file = createFile(db, {
            projectId,
            uploaderId: user.id,
            storageKey,
            thumbKey,
            originalName: part.filename.slice(0, 255),
            mimeType: detected.mime,
            byteSize: buffer.length,
            checksum: digest,
            width: meta.width,
            height: meta.height,
            scanState: 'clean',
          });
        }

        const evidence = createEvidence(db, {
          projectId,
          fileId: file.id,
          kind: evidenceKindFor(detected, part.filename),
          title: part.filename.replace(/\.[^.]+$/, '').slice(0, 120),
        });

        // Text-like uploads carry their content straight into the searchable
        // record without needing a vision pass.
        if (detected.kind === 'text') {
          const content = buffer.toString('utf8').slice(0, 200_000);
          storeOcrText(db, projectId, evidence.id, content, 'upload:text');
        }

        // Secrets in the filename itself are rare but cheap to check.
        for (const match of detectSecrets(part.filename)) {
          recordSecretFinding(db, {
            projectId,
            subjectType: 'evidence',
            subjectId: evidence.id,
            detector: match.detector,
            severity: match.severity,
            preview: match.preview,
          });
        }

        reindexEvidence(db, projectId, evidence.id);
        enqueueJob(db, {
          projectId,
          userId: user.id,
          type: 'evidence.analyze',
          payload: { projectId, evidenceId: evidence.id },
        });

        created.push({ evidence, file: publicFile(file) });
        audit(db, {
          projectId,
          userId: user.id,
          action: 'evidence.upload',
          entityType: 'evidence',
          entityId: evidence.id,
          ip: request.ip,
          detail: { mime: detected.mime, bytes: buffer.length },
        });
      }

      if (created.length === 0) throw badRequest('No files were included in the upload');
      return reply.code(201).send({ uploaded: created });
    },
  );

  app.get('/api/projects/:projectId/evidence', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    const items = listEvidence(db, projectId);
    return {
      evidence: items.map((item) => ({
        ...item,
        file: item.fileId ? publicFile(getFile(db, item.fileId)) : null,
        analysis: getLatestImageAnalysis(db, item.id) ?? null,
        ocr: summariseOcr(getLatestOcr(db, item.id)),
        links: listLinksForEvidence(db, item.id),
      })),
      links: listEvidenceLinks(db, projectId),
    };
  });

  app.get('/api/projects/:projectId/evidence/:evidenceId', async (request) => {
    const { projectId, evidenceId } = request.params as { projectId: string; evidenceId: string };
    const { db } = authorizeProject(request, projectId);
    const evidence = getEvidence(db, evidenceId);
    if (!evidence || evidence.projectId !== projectId) throw notFound('Evidence');
    return {
      evidence,
      file: evidence.fileId ? publicFile(getFile(db, evidence.fileId)) : null,
      analysis: getLatestImageAnalysis(db, evidenceId) ?? null,
      ocr: getLatestOcr(db, evidenceId) ?? null,
      links: listLinksForEvidence(db, evidenceId),
    };
  });

  app.patch('/api/projects/:projectId/evidence/:evidenceId', async (request) => {
    const { projectId, evidenceId } = request.params as { projectId: string; evidenceId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const existing = getEvidence(db, evidenceId);
    if (!existing || existing.projectId !== projectId) throw notFound('Evidence');

    const body = parse(
      z.object({
        title: text(200).optional(),
        description: optionalText(8000),
        caption: optionalText(500),
        source: optionalText(300),
        kind: z.enum(['screenshot', 'photo', 'diagram', 'document', 'log', 'config', 'code', 'link', 'other']).optional(),
        capturedAt: z.string().datetime().nullable().optional(),
        reviewState: z.enum(['unreviewed', 'ai-analyzed', 'user-confirmed', 'user-corrected', 'rejected']).optional(),
        confidence: confidenceSchema.optional(),
      }),
      request.body,
    );

    recordVersion(db, { projectId, entityType: 'evidence', entityId: evidenceId, actorType: 'user', actorId: user.id, reason: 'edit', snapshot: existing });
    const evidence = updateEvidence(db, evidenceId, body);
    reindexEvidence(db, projectId, evidenceId);
    return { evidence };
  });

  /**
   * The user's verdict on an AI reading of a screenshot. Correcting the
   * description is a first-class action: it replaces what every downstream
   * generator sees.
   */
  app.post('/api/projects/:projectId/evidence/:evidenceId/review', async (request) => {
    const { projectId, evidenceId } = request.params as { projectId: string; evidenceId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const existing = getEvidence(db, evidenceId);
    if (!existing || existing.projectId !== projectId) throw notFound('Evidence');

    const body = parse(
      z.object({
        verdict: z.enum(['confirm', 'correct', 'reject']),
        description: optionalText(8000),
        caption: optionalText(500),
      }),
      request.body,
    );

    const reviewState =
      body.verdict === 'confirm' ? 'user-confirmed' : body.verdict === 'correct' ? 'user-corrected' : 'rejected';

    const patch: Record<string, unknown> = { reviewState };
    if (body.description !== undefined) patch.description = body.description;
    if (body.caption !== undefined) patch.caption = body.caption;
    if (body.verdict === 'confirm') patch.confidence = 'high';

    const evidence = updateEvidence(db, evidenceId, patch);
    reindexEvidence(db, projectId, evidenceId);
    audit(db, { projectId, userId: user.id, action: `evidence.${body.verdict}`, entityType: 'evidence', entityId: evidenceId, ip: request.ip });
    return { evidence };
  });

  app.delete('/api/projects/:projectId/evidence/:evidenceId', async (request) => {
    const { projectId, evidenceId } = request.params as { projectId: string; evidenceId: string };
    const { db, user } = authorizeProject(request, projectId, 'editor');
    const evidence = getEvidence(db, evidenceId);
    if (!evidence || evidence.projectId !== projectId) throw notFound('Evidence');

    recordVersion(db, { projectId, entityType: 'evidence', entityId: evidenceId, actorType: 'user', actorId: user.id, reason: 'delete', snapshot: evidence });
    deleteEvidence(db, evidenceId);
    if (evidence.fileId) softDeleteFile(db, evidence.fileId);
    audit(db, { projectId, userId: user.id, action: 'evidence.delete', entityType: 'evidence', entityId: evidenceId, ip: request.ip });
    return { ok: true };
  });

  // --- the evidence chain --------------------------------------------------

  app.post('/api/projects/:projectId/evidence/:evidenceId/links', async (request, reply) => {
    const { projectId, evidenceId } = request.params as { projectId: string; evidenceId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    const evidence = getEvidence(db, evidenceId);
    if (!evidence || evidence.projectId !== projectId) throw notFound('Evidence');

    const body = parse(
      z.object({
        targetType: z.enum(['step', 'problem', 'resolution', 'result', 'test', 'project']),
        targetId: z.string().min(3),
        role: z.enum(['supports', 'before', 'after', 'symptom', 'investigation', 'resolution', 'validation']).default('supports'),
        note: optionalText(500),
      }),
      request.body,
    );

    const link = linkEvidence(db, { projectId, evidenceId, ...body, origin: 'user', confidence: 'high' });
    return reply.code(201).send({ link, links: listLinksForEvidence(db, evidenceId) });
  });

  app.delete('/api/projects/:projectId/evidence/links/:linkId', async (request) => {
    const { projectId, linkId } = request.params as { projectId: string; linkId: string };
    const { db } = authorizeProject(request, projectId, 'editor');
    unlinkEvidence(db, linkId);
    return { ok: true };
  });

  // --- file bytes ----------------------------------------------------------

  app.get('/api/projects/:projectId/files/:fileId', async (request, reply) => {
    const { projectId, fileId } = request.params as { projectId: string; fileId: string };
    const { db } = authorizeProject(request, projectId);
    const query = parse(z.object({ variant: z.enum(['original', 'thumb']).default('original') }), request.query);

    const file = getFile(db, fileId);
    if (!file || file.projectId !== projectId) throw notFound('File');

    const key = query.variant === 'thumb' && file.thumbKey ? file.thumbKey : file.storageKey;
    let bytes: Buffer;
    try {
      bytes = await getStorage().read(key);
    } catch {
      throw new AppError(410, 'file_missing', 'The stored file is no longer available');
    }

    return reply
      .header('Content-Type', query.variant === 'thumb' && file.thumbKey ? 'image/webp' : file.mimeType)
      // Never let a browser interpret an upload as an active document.
      .header('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=3600')
      .send(bytes);
  });
}

function publicFile(file: ReturnType<typeof getFile>) {
  if (!file) return null;
  // storage_key is deliberately not exposed to clients.
  const { storageKey, thumbKey, ...rest } = file;
  return { ...rest, hasThumbnail: Boolean(thumbKey) };
}

function summariseOcr(ocr: ReturnType<typeof getLatestOcr>) {
  if (!ocr) return null;
  const body = ocr.redactedText ?? ocr.text;
  return { id: ocr.id, engine: ocr.engine, chars: body.length, preview: body.slice(0, 280), redacted: Boolean(ocr.redactedText) };
}
