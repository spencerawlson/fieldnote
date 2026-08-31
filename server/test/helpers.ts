import { mkdtempSync, rmSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';

/**
 * Test harness.
 *
 * Each suite gets a fresh in-memory database and a throwaway storage
 * directory, with the deterministic AI provider selected. Environment is set
 * before any application module is imported, because config is read once at
 * module load.
 */

const storageRoot = mkdtempSync(join(tmpdir(), 'fieldnote-test-'));

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STORAGE_PATH = storageRoot;
process.env.AI_PROVIDER = 'mock';
process.env.JOB_WORKER_ENABLED = 'false';
process.env.SESSION_SECRET = 'test-secret-value-that-is-long-enough-1234567890';
process.env.LOG_LEVEL = 'silent';
process.env.OCR_DRIVER = 'vision';

export function cleanupStorage(): void {
  rmSync(storageRoot, { recursive: true, force: true });
}

export interface TestClient {
  app: FastifyInstance;
  cookie: string;
  csrf: string;
  userId: string;
  get(url: string): Promise<{ status: number; body: any }>;
  post(url: string, payload?: unknown): Promise<{ status: number; body: any }>;
  patch(url: string, payload?: unknown): Promise<{ status: number; body: any }>;
  del(url: string): Promise<{ status: number; body: any }>;
  upload(
    url: string,
    files: { field?: string; filename: string; contentType: string; data: Buffer }[],
  ): Promise<{ status: number; body: any }>;
  raw(url: string): Promise<{ status: number; buffer: Buffer; headers: Record<string, unknown> }>;
}

export async function createClient(app: FastifyInstance, email = 'author@example.test'): Promise<TestClient> {
  const registration = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, name: 'Test Author', password: 'a-sufficiently-long-password' },
  });
  if (registration.statusCode !== 201) {
    throw new Error(`Registration failed: ${registration.statusCode} ${registration.body}`);
  }
  const cookie = registration.cookies[0];
  const parsed = registration.json();

  const headers = () => ({
    cookie: `${cookie!.name}=${cookie!.value}`,
    'x-fieldnote-csrf': parsed.csrfToken,
  });

  const send = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    // Built as a typed object rather than spread inline: a conditional spread
    // makes TypeScript fall back to inject's chainable overload, which has no
    // statusCode.
    const options: InjectOptions = { method, url, headers: headers() };
    if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
    const response = await app.inject(options);
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body: body as any };
  };

  return {
    app,
    cookie: `${cookie!.name}=${cookie!.value}`,
    csrf: parsed.csrfToken,
    userId: parsed.user.id,
    get: (url) => send('GET', url),
    post: (url, payload) => send('POST', url, payload ?? {}),
    patch: (url, payload) => send('PATCH', url, payload),
    del: (url) => send('DELETE', url),
    async upload(url, files) {
      const boundary = '----fieldnotetest';
      const parts: Buffer[] = [];
      for (const file of files) {
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
          ),
          file.data,
          Buffer.from('\r\n'),
        );
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const options: InjectOptions = {
        method: 'POST',
        url,
        headers: { ...headers(), 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat(parts),
      };
      const response = await app.inject(options);
      let body: unknown;
      try {
        body = response.json();
      } catch {
        body = response.body;
      }
      return { status: response.statusCode, body: body as any };
    },
    async raw(url) {
      const options: InjectOptions = { method: 'GET', url, headers: headers() };
      const response = await app.inject(options);
      return { status: response.statusCode, buffer: response.rawPayload, headers: response.headers as Record<string, unknown> };
    },
  };
}

/**
 * A 1x1 PNG. Real bytes so magic-byte validation, sharp and the export
 * renderers all exercise their real code paths.
 */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A slightly larger PNG (16x16, solid) so resolution checks have something real to read. */
export function makePng(width = 16, height = 16): Buffer {
  // Minimal valid PNG built by hand: signature, IHDR, IDAT (uncompressed
  // zlib block), IEND. Avoids a fixture file on disk.
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = 30;
      raw[p + 1] = 64;
      raw[p + 2] = 175;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData) >>> 0);
    return Buffer.concat([length, typeAndData, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable: number[] | null = null;
function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}
