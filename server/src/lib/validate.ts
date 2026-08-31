import { z } from 'zod';
import { unprocessable } from './core.ts';

/** Parses a request payload, turning zod issues into a 422 with field detail. */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw unprocessable(
      'The request body is not valid',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export const idSchema = z.string().min(3).max(64).regex(/^[a-z]{3}_[a-f0-9]{32}$/, 'Not a valid id');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Strips C0 control characters except tab, newline and carriage return.
 * These reach exports and PDF renderers, where a stray control byte either
 * corrupts the file or silently disappears mid-sentence.
 */
export function stripControlChars(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    const isAllowedWhitespace = code === 9 || code === 10 || code === 13;
    if (code < 0x20 && !isAllowedWhitespace) continue;
    if (code === 0x7f) continue;
    out += char;
  }
  return out;
}

/** Free text: control characters stripped, trimmed, length-capped. */
export const text = (max: number, min = 0) =>
  z
    .string()
    .transform((value) => stripControlChars(value).trim())
    .refine((value) => value.length >= min, { message: `Must be at least ${min} characters` })
    .refine((value) => value.length <= max, { message: `Must be at most ${max} characters` });

export const optionalText = (max: number) => text(max).optional().nullable();

export const confidenceSchema = z.enum(['high', 'medium', 'low']);
export const provenanceSchema = z.enum([
  'USER_FACT',
  'EVIDENCE',
  'AI_EXPLANATION',
  'AI_INFERENCE',
  'AI_RECOMMENDATION',
]);
export const depthSchema = z.coerce.number().int().min(1).max(4);

export { z };
