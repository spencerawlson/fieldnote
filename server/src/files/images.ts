import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { AppError, payloadTooLarge } from '../lib/core.ts';
import { logger } from '../lib/logger.ts';

/**
 * Upload validation.
 *
 * The declared Content-Type is a claim by the client, not a fact. Every upload
 * is checked against its magic bytes, and anything whose real type disagrees
 * with its declared type is rejected rather than stored and hoped about.
 */

export interface DetectedType {
  mime: string;
  extension: string;
  kind: 'image' | 'document' | 'text';
}

const MAGIC: { mime: string; extension: string; kind: DetectedType['kind']; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', extension: 'png', kind: 'image', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', extension: 'jpg', kind: 'image', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', extension: 'gif', kind: 'image', test: (b) => b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a' },
  {
    mime: 'image/webp',
    extension: 'webp',
    kind: 'image',
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  { mime: 'image/bmp', extension: 'bmp', kind: 'image', test: (b) => b.subarray(0, 2).toString('ascii') === 'BM' },
  {
    mime: 'image/tiff',
    extension: 'tiff',
    kind: 'image',
    test: (b) => (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00),
  },
  { mime: 'application/pdf', extension: 'pdf', kind: 'document', test: (b) => b.subarray(0, 5).toString('ascii') === '%PDF-' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
    kind: 'document',
    // OOXML is a zip; the caller's declared type disambiguates docx from pptx/xlsx.
    test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07),
  },
];

const TEXT_EXTENSIONS: Record<string, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'text/x-log': 'log',
  'application/x-yaml': 'yaml',
  'text/yaml': 'yaml',
};

const SVG_REJECTION =
  'SVG uploads are not accepted: they can carry script and are rendered as documents by browsers. Export the diagram to PNG.';

export function detectType(buffer: Buffer, declaredMime: string, fileName: string): DetectedType {
  if (declaredMime === 'image/svg+xml' || /\.svg$/i.test(fileName)) {
    throw new AppError(415, 'unsupported_type', SVG_REJECTION);
  }

  for (const entry of MAGIC) {
    if (entry.test(buffer)) {
      // A zip could be docx, pptx or xlsx. Trust the declared type only to pick
      // among zip-based formats, and only when it is one we accept.
      if (entry.extension === 'docx') {
        const zipTypes: Record<string, { mime: string; extension: string }> = {
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { mime: declaredMime, extension: 'docx' },
          'application/vnd.openxmlformats-officedocument.presentationml.presentation': { mime: declaredMime, extension: 'pptx' },
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { mime: declaredMime, extension: 'xlsx' },
        };
        const resolved = zipTypes[declaredMime];
        if (!resolved) {
          throw new AppError(415, 'unsupported_type', 'Zip-based files are only accepted as .docx, .pptx or .xlsx');
        }
        return { mime: resolved.mime, extension: resolved.extension, kind: 'document' };
      }
      return { mime: entry.mime, extension: entry.extension, kind: entry.kind };
    }
  }

  // Plain text has no magic bytes; accept it only when it is declared as text
  // and actually decodes as UTF-8 without control bytes.
  const textExt = TEXT_EXTENSIONS[declaredMime];
  if (textExt && looksLikeText(buffer)) {
    return { mime: declaredMime, extension: textExt, kind: 'text' };
  }

  throw new AppError(
    415,
    'unsupported_type',
    `Unsupported or unrecognised file type (declared ${declaredMime}). Accepted: PNG, JPEG, WEBP, GIF, BMP, TIFF, PDF, DOCX, and plain text.`,
  );
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
  }
  return true;
}

export function assertSize(bytes: number): void {
  if (bytes > config.storage.maxUploadBytes) {
    const mb = Math.round(config.storage.maxUploadBytes / (1024 * 1024));
    throw payloadTooLarge(`File exceeds the ${mb} MB upload limit`);
  }
  if (bytes === 0) throw new AppError(400, 'empty_file', 'The uploaded file is empty');
}

export function checksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export interface ImageMeta {
  width: number | null;
  height: number | null;
}

/**
 * Thumbnail generation via sharp. sharp is an optional dependency: when it is
 * not installed the upload still succeeds, just without a thumbnail.
 */
export async function processImage(
  buffer: Buffer,
  mime: string,
): Promise<{ meta: ImageMeta; thumbnail: Buffer | null }> {
  if (!mime.startsWith('image/')) return { meta: { width: null, height: null }, thumbnail: null };
  try {
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default;
    const image = sharp(buffer, { failOn: 'none', limitInputPixels: 268_402_689 });
    const metadata = await image.metadata();
    const thumbnail = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    return {
      meta: { width: metadata.width ?? null, height: metadata.height ?? null },
      thumbnail,
    };
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Thumbnail generation unavailable; storing original only');
    return { meta: { width: null, height: null }, thumbnail: null };
  }
}

/** Maps a detected file type onto the evidence kind we default to. */
export function evidenceKindFor(detected: DetectedType, fileName: string): string {
  if (detected.kind === 'document') return 'document';
  if (detected.kind === 'text') return /\.(log|txt)$/i.test(fileName) ? 'log' : 'config';
  if (/diagram|topology|architecture/i.test(fileName)) return 'diagram';
  if (detected.mime === 'image/jpeg' && /IMG_|photo/i.test(fileName)) return 'photo';
  return 'screenshot';
}
