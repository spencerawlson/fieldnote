import { buildApp } from './app.ts';
import { config, assertProductionConfig } from './config.ts';
import { getDb, closeDb } from './db/index.ts';
import { purgeExpiredSessions } from './db/repositories/system.ts';
import { startWorker, stopWorker } from './jobs/worker.ts';
import { logger } from './lib/logger.ts';
import { providerInfo } from './ai/registry.ts';
import './jobs/handlers.ts'; // registers job handlers as a side effect

async function main(): Promise<void> {
  assertProductionConfig();

  const db = getDb();
  const purged = purgeExpiredSessions(db);
  if (purged > 0) logger.info({ purged }, 'Purged expired sessions');

  const app = await buildApp();
  startWorker();

  await app.listen({ port: config.port, host: config.host });

  const ai = providerInfo();
  logger.info(
    {
      port: config.port,
      host: config.host,
      env: config.env,
      aiProvider: ai.name,
      offline: ai.offline,
      models: ai.models,
      database: config.db.path,
    },
    'Fieldnote is running',
  );
  if (ai.offline) {
    logger.warn(
      {},
      'Running in offline mode: no API key configured, so AI output is produced by the deterministic local provider. Set OPENAI_API_KEY in .env for real elaboration.',
    );
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopWorker();
    await app.close().catch(() => {});
    closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error({ err: (error as Error).message, stack: (error as Error).stack }, 'Failed to start');
  process.exit(1);
});
