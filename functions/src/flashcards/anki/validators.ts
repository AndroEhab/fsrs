/**
 * Zod validators for the Anki .apkg import/export endpoints.
 *
 * Both endpoints are JSON POST handlers (matching every state-changing
 * backend handler). The import body carries the whole .apkg as a base64
 * string; the request cap mirrors the decoded byte cap (base64 is ~4/3 the
 * decoded size plus padding). Strict schema (unknown keys rejected, like the
 * rest of validators.ts).
 */
import { z } from 'zod';
import {
  ANKI_MAX_APKG_BYTES, ExportApkgInput, ImportApkgInput,
} from './types';
import { ValidationError } from '../validators';

/** base64 length ceiling for a decoded .apkg of ANKI_MAX_APKG_BYTES. */
export const IMPORT_PACKAGE_MAX_LENGTH = Math.ceil((ANKI_MAX_APKG_BYTES * 4) / 3) + 8;

const deckPathSchema = z.string()
  .min(1, 'deckPath cannot be empty')
  .max(300, 'deckPath too long (max 300 chars)')
  .refine((p) => p.split('::').every((part) => part.trim().length > 0 && part.trim().length <= 100), {
    message: 'deckPath levels must be 1-100 characters (separated by ::)',
  });

const importApkgSchema = z.object({
  package: z.string().min(1, 'package is required').max(IMPORT_PACKAGE_MAX_LENGTH, `package too large (max ${ANKI_MAX_APKG_BYTES} bytes decoded)`),
  deckPath: deckPathSchema.optional(),
}).strict() satisfies z.ZodType<ImportApkgInput>;

const exportApkgSchema = z.object({
  deck: z.string().min(1, 'deck cannot be empty').max(300, 'deck too long (max 300 chars)').optional(),
  cardIds: z.array(z.string().min(1, 'card id cannot be empty').max(200, 'card id too long'))
    .min(1, 'At least one card id is required')
    .max(1000, `No more than 1000 card ids per request`)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate card ids are not allowed' })
    .optional(),
}).strict().refine((data) => data.deck === undefined || data.cardIds === undefined, {
  message: 'deck and cardIds cannot be combined — pick one selection',
  path: ['cardIds'],
}) satisfies z.ZodType<ExportApkgInput>;

export function validateImportApkg(data: unknown): ImportApkgInput {
  const result = importApkgSchema.safeParse(data);
  if (!result.success) throw new ValidationError(result.error.issues);
  return result.data;
}

export function validateExportApkg(data: unknown): ExportApkgInput {
  const result = exportApkgSchema.safeParse(data);
  if (!result.success) throw new ValidationError(result.error.issues);
  return result.data;
}

export function safeValidateImportApkg(data: unknown): { success: true; data: ImportApkgInput } | { success: false; error: ValidationError } {
  const result = importApkgSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: new ValidationError(result.error.issues) };
}

export function safeValidateExportApkg(data: unknown): { success: true; data: ExportApkgInput } | { success: false; error: ValidationError } {
  const result = exportApkgSchema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: new ValidationError(result.error.issues) };
}
