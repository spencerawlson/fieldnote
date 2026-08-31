import { getDb, migrate } from './index.ts';
import { logger } from '../lib/logger.ts';

const db = getDb();
const applied = migrate(db);
logger.info({ applied: applied.length ? applied : 'none (already up to date)' }, 'Migrations complete');
