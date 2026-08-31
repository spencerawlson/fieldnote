import { EventEmitter } from 'node:events';
import { config } from '../config.ts';
import { getDb, type Database } from '../db/index.ts';
import {
  claimNextJob,
  completeJob,
  failJob,
  getJob,
  requeueStaleJobs,
  updateJobProgress,
  type JobRecord,
} from '../db/repositories/system.ts';
import { newId } from '../lib/core.ts';
import { countEvent, logger, observeDuration } from '../lib/logger.ts';

/**
 * In-process job queue backed by SQLite.
 *
 * Chosen over Redis/BullMQ deliberately: this product's long operations are
 * AI calls and document rendering, measured in seconds, at single-digit
 * concurrency. A database-backed queue keeps deployment to one process and one
 * file while still giving durability, retries, progress and crash recovery.
 * `claimNextJob` takes the row under a transaction, so adding a second worker
 * process later is safe without changing the schema.
 */

export interface JobContext {
  db: Database;
  job: JobRecord;
  progress: (current: number, total: number, message?: string) => void;
  log: (message: string) => void;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(200);

function emitJob(job: JobRecord | undefined): void {
  if (!job) return;
  jobEvents.emit('update', job);
  if (job.projectId) jobEvents.emit(`project:${job.projectId}`, job);
}

let running = false;
let timer: NodeJS.Timeout | null = null;
let active = 0;
const workerId = `worker-${process.pid}-${newId('job').slice(-6)}`;

export function startWorker(): void {
  if (running || !config.jobs.enabled) return;
  running = true;
  const db = getDb();
  const requeued = requeueStaleJobs(db);
  if (requeued > 0) logger.warn({ requeued }, 'Requeued jobs that were interrupted by a previous shutdown');
  logger.info({ workerId, concurrency: config.jobs.concurrency }, 'Job worker started');
  tick();
}

export function stopWorker(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

function tick(): void {
  if (!running) return;
  while (active < config.jobs.concurrency) {
    const db = getDb();
    const job = claimNextJob(db, workerId);
    if (!job) break;
    active += 1;
    emitJob(job);
    void run(db, job).finally(() => {
      active -= 1;
    });
  }
  timer = setTimeout(tick, config.jobs.pollIntervalMs);
  timer.unref?.();
}

async function run(db: Database, job: JobRecord): Promise<void> {
  const handler = handlers.get(job.type);
  const started = Date.now();
  if (!handler) {
    failJob(db, job.id, `No handler registered for job type "${job.type}"`, 0);
    emitJob(getJob(db, job.id));
    return;
  }

  const ctx: JobContext = {
    db,
    job,
    progress: (current, total, message) => {
      updateJobProgress(db, job.id, { progress: current, progressTotal: total, message });
      emitJob(getJob(db, job.id));
    },
    log: (message) => {
      updateJobProgress(db, job.id, { message });
      emitJob(getJob(db, job.id));
    },
  };

  try {
    const result = await handler(ctx);
    completeJob(db, job.id, result);
    countEvent(`job.${job.type}.succeeded`);
    observeDuration(`job.${job.type}`, Date.now() - started);
    logger.info({ jobId: job.id, type: job.type, ms: Date.now() - started }, 'Job succeeded');
  } catch (error) {
    const message = (error as Error).message ?? 'Unknown error';
    // Backoff grows with attempts; a transient provider outage is retried,
    // a bad payload fails fast once max_attempts is reached.
    failJob(db, job.id, message, 2000 * 2 ** job.attempts);
    countEvent(`job.${job.type}.failed`);
    logger.error({ jobId: job.id, type: job.type, error: message }, 'Job failed');
  }
  emitJob(getJob(db, job.id));
}

/** Test seam: drain the queue synchronously instead of polling. */
export async function drainJobs(db: Database, limit = 100): Promise<number> {
  let processed = 0;
  for (let i = 0; i < limit; i += 1) {
    const job = claimNextJob(db, 'test-worker');
    if (!job) break;
    await run(db, job);
    processed += 1;
  }
  return processed;
}
