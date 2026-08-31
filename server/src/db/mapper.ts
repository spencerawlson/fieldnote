import { parseJson } from '../lib/core.ts';

/** snake_case -> camelCase, applied to every row read out of SQLite. */
export function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export type FieldSpec = {
  /** columns holding JSON text that should be parsed on read */
  json?: Record<string, unknown>;
  /** columns holding 0/1 that should surface as booleans */
  bool?: string[];
  /** columns to rename after camel-casing, e.g. { key: 'sectionKey' } */
  rename?: Record<string, string>;
};

export function mapRow<T>(row: Record<string, unknown> | undefined, spec: FieldSpec = {}): T | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = {};
  const boolSet = new Set(spec.bool ?? []);
  for (const [key, value] of Object.entries(row)) {
    let name = camel(key.replace(/_json$/, ''));
    if (spec.rename?.[name]) name = spec.rename[name]!;
    if (key.endsWith('_json')) {
      out[name] = parseJson(value as string, spec.json?.[name] ?? null);
    } else if (boolSet.has(key)) {
      out[name] = value === null ? null : Boolean(value);
    } else {
      out[name] = value;
    }
  }
  return out as T;
}

export function mapRows<T>(rows: Record<string, unknown>[], spec: FieldSpec = {}): T[] {
  return rows.map((r) => mapRow<T>(r, spec)!);
}

/**
 * Builds `SET a = ?, b = ?` from a partial patch, ignoring undefined values so
 * callers can pass sparse objects straight from a validated request body.
 */
export function buildUpdate(
  patch: Record<string, unknown>,
  columns: Record<string, string>,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [field, column] of Object.entries(columns)) {
    if (patch[field] === undefined) continue;
    let value = patch[field];
    if (typeof value === 'boolean') value = value ? 1 : 0;
    else if (value !== null && typeof value === 'object') value = JSON.stringify(value);
    parts.push(`${column} = ?`);
    params.push(value);
  }
  return { sql: parts.join(', '), params };
}
