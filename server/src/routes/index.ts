import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.ts';
import { projectRoutes } from './projects.ts';
import { workRoutes } from './work.ts';
import { evidenceRoutes } from './evidence.ts';
import { aiRoutes } from './ai.ts';
import { outputRoutes } from './outputs.ts';
import { getDb } from '../db/index.ts';
import { getJob, listActiveJobs, listJobs } from '../db/repositories/system.ts';
import { jobEvents } from '../jobs/worker.ts';
import { authorizeProject } from '../security/auth.ts';
import { providerInfo } from '../ai/registry.ts';
import { metricsSnapshot } from '../lib/logger.ts';
import { config } from '../config.ts';
import { notFound } from '../lib/core.ts';
import { STEP_CATEGORIES, TONES, AUDIENCES, DEPTH_LABELS } from '../domain/types.ts';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(authRoutes);
  await app.register(projectRoutes);
  await app.register(workRoutes);
  await app.register(evidenceRoutes);
  await app.register(aiRoutes);
  await app.register(outputRoutes);
  await app.register(systemRoutes);
  await app.register(jobRoutes);
}

async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    const db = getDb();
    const ok = db.get<{ n: number }>('SELECT 1 AS n')?.n === 1;
    return {
      status: ok ? 'ok' : 'degraded',
      version: '0.1.0',
      env: config.env,
      ai: providerInfo(),
      jobs: { enabled: config.jobs.enabled, concurrency: config.jobs.concurrency },
    };
  });

  app.get('/api/meta', async () => ({
    categories: STEP_CATEGORIES,
    tones: TONES,
    audiences: AUDIENCES,
    depths: Object.entries(DEPTH_LABELS).map(([value, label]) => ({ value: Number(value), label })),
    ai: providerInfo(),
    limits: {
      maxUploadBytes: config.storage.maxUploadBytes,
      maxUploadsPerProject: config.storage.maxUploadsPerProject,
    },
  }));

  app.get('/api/metrics', async (request, reply) => {
    // Operational data only; no project content is ever in here.
    if (!request.user || request.user.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Admin access required' } });
    }
    return metricsSnapshot();
  });
}

async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects/:projectId/jobs', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);
    return { jobs: listJobs(db, projectId, 25), active: listActiveJobs(db, projectId) };
  });

  app.get('/api/projects/:projectId/jobs/:jobId', async (request) => {
    const { projectId, jobId } = request.params as { projectId: string; jobId: string };
    const { db } = authorizeProject(request, projectId);
    const job = getJob(db, jobId);
    if (!job || job.projectId !== projectId) throw notFound('Job');
    return { job };
  });

  /**
   * Server-sent events for job progress.
   *
   * SSE rather than WebSockets: progress is one-directional, it survives
   * proxies that mangle upgrades, and the browser reconnects on its own.
   */
  app.get('/api/projects/:projectId/jobs/stream', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { db } = authorizeProject(request, projectId);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('snapshot', { jobs: listActiveJobs(db, projectId) });

    const channel = `project:${projectId}`;
    const onUpdate = (job: unknown) => send('job', job);
    jobEvents.on(channel, onUpdate);

    // Keep-alive comment so intermediaries do not close an idle stream.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      jobEvents.off(channel, onUpdate);
    });

    // Returning the raw reply hands the socket lifetime to the handlers above.
    return reply;
  });
}
