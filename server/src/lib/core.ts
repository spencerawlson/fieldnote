import { randomUUID, randomBytes, createHash, timingSafeEqual, scryptSync } from 'node:crypto';

// --- identity -------------------------------------------------------------

const ID_PREFIXES = {
  user: 'usr',
  session: 'ses',
  project: 'prj',
  step: 'stp',
  command: 'cmd',
  file: 'fil',
  evidence: 'evd',
  evidenceLink: 'lnk',
  imageAnalysis: 'ima',
  ocr: 'ocr',
  secret: 'sec',
  problem: 'pbm',
  investigation: 'inv',
  resolution: 'res',
  test: 'tst',
  result: 'rst',
  ref: 'ref',
  tag: 'tag',
  claim: 'clm',
  aiRun: 'run',
  insight: 'ins',
  report: 'rpt',
  section: 'sct',
  presentation: 'prs',
  slide: 'sld',
  question: 'qst',
  answer: 'ans',
  export: 'exp',
  version: 'ver',
  job: 'job',
  audit: 'aud',
  embedding: 'emb',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** Prefixed, sortable-ish identifier: `stp_01h9…`. Readable in logs and URLs. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomUUID().replace(/-/g, '')}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// --- time -----------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// --- hashing --------------------------------------------------------------

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable hash of an object, used for AI caching and staleness detection. */
export function stableHash(value: unknown): string {
  return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

// --- passwords ------------------------------------------------------------

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  try {
    const derived = scryptSync(password.normalize('NFKC'), Buffer.from(saltRaw!, 'base64'), SCRYPT_KEYLEN, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
      maxmem: 64 * 1024 * 1024,
    });
    const expected = Buffer.from(hashRaw!, 'base64');
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// --- errors ---------------------------------------------------------------

export class AppError extends Error {
  statusCode: number;
  code: string;
  details: unknown;
  expose: boolean;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = statusCode < 500;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, details);
export const payloadTooLarge = (message: string) =>
  new AppError(413, 'payload_too_large', message);
export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'unprocessable', message, details);
export const upstreamFailure = (message: string, details?: unknown) =>
  new AppError(502, 'upstream_failure', message, details);

// --- misc -----------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 80) || 'untitled';
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; baseDelayMs?: number; shouldRetry?: (e: unknown) => boolean },
): Promise<T> {
  const base = opts.baseDelayMs ?? 400;
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (opts.shouldRetry && !opts.shouldRetry(error)) throw error;
      if (attempt === opts.retries) break;
      const delay = base * 2 ** attempt + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
