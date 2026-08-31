import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export type Row = Record<string, unknown>;

/**
 * Thin, typed wrapper over node:sqlite.
 *
 * node:sqlite is synchronous. That is a deliberate fit here: SQLite reads are
 * microseconds, and synchronous access removes a whole class of interleaving
 * bugs. Anything genuinely slow (AI calls, rendering) runs in the job worker,
 * never inside a database transaction.
 */
export class Database {
  readonly handle: DatabaseSync;
  private statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.handle = new DatabaseSync(path);
    this.handle.exec('PRAGMA journal_mode = WAL');
    this.handle.exec('PRAGMA foreign_keys = ON');
    this.handle.exec('PRAGMA busy_timeout = 5000');
    this.handle.exec('PRAGMA synchronous = NORMAL');
  }

  private stmt(sql: string) {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.handle.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...(params as never[])) as T[];
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.stmt(sql).run(...(params as never[]));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  /** Synchronous transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.handle.exec('BEGIN');
    this.inTransaction = true;
    try {
      const value = fn();
      this.handle.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK');
      } catch {
        /* rollback of an already-aborted transaction is fine */
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  private inTransaction = false;

  close(): void {
    this.statements.clear();
    this.handle.close();
  }
}

export function migrate(db: Database): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // Migration DDL runs in its own transaction so a failure leaves no residue.
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', file, new Date().toISOString());
      db.exec('COMMIT');
      ran.push(file);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  return ran;
}

let singleton: Database | null = null;

export function getDb(): Database {
  if (!singleton) {
    singleton = new Database(config.db.path);
    migrate(singleton);
  }
  return singleton;
}

/** Used by tests to run against a throwaway in-memory database. */
export function createTestDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

export function closeDb(): void {
  singleton?.close();
  singleton = null;
}
