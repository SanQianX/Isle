import path from 'node:path';
import { z } from 'zod';

/**
 * Central runtime configuration.
 *
 * DEPLOY_RUNBOOK §3: missing or invalid required values MUST abort startup with
 * a clear message. We deliberately never fall back to a project-directory
 * dev.db — that is how a production box ends up silently writing to a file
 * inside the release directory.
 */

const MIB = 1024 * 1024;

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Absolute sqlite URL, e.g. file:/var/lib/isle/db/isle.db */
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL must not be empty'),

  /** Root under which original/ and preview/ live. */
  MEDIA_ROOT: z.string({ error: 'MEDIA_ROOT is required' }).min(1, 'MEDIA_ROOT must not be empty'),

  /** Scratch space for in-flight uploads. */
  UPLOAD_TMP_DIR: z
    .string({ error: 'UPLOAD_TMP_DIR is required' })
    .min(1, 'UPLOAD_TMP_DIR must not be empty'),

  /** Public origin; decides the __Host- cookie prefix (ADR-003). */
  PUBLIC_BASE_URL: z
    .string()
    .url('PUBLIC_BASE_URL must be an absolute URL')
    .default('http://127.0.0.1:3000'),

  /** Hard ceiling per single file, in bytes. */
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * MIB),
  /** Ceiling per batch as the UI presents it. */
  MAX_UPLOAD_FILES: z.coerce.number().int().positive().max(200).default(30),
  /** Client-side upload concurrency the UI must respect. */
  MAX_CONCURRENT_UPLOADS_PER_CLIENT: z.coerce.number().int().positive().max(10).default(2),
  /** Decompression-bomb budget, in pixels. */
  MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(100_000_000),

  /** 'friends-only' expects an upstream gateway (nginx basic auth). */
  SITE_ACCESS_MODE: z.enum(['friends-only', 'public']).default('friends-only'),

  /** Slug shown on `/` when set; falls back to the oldest place. */
  FEATURED_PLACE_SLUG: z.string().optional(),

  /** E2E guard. Set by scripts/run-e2e-isolated.mjs. */
  ISLE_E2E: booleanish.default(false),

  /** Refuse new uploads above this fraction of the media volume. */
  MEDIA_DISK_HIGH_WATERMARK: z.coerce.number().min(0.1).max(1).default(0.9),

  /** Visitor identity cookie lifetime, seconds (~365 days). */
  VISITOR_COOKIE_MAX_AGE: z.coerce.number().int().positive().default(31_536_000),
});

export type Env = z.infer<typeof envSchema>;

export type AppConfig = {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly isE2E: boolean;
  readonly databaseUrl: string;
  /** Filesystem path of the SQLite file, derived from DATABASE_URL. */
  readonly databaseFile: string;
  readonly mediaRoot: string;
  readonly originalDir: string;
  readonly previewRoot: string;
  readonly uploadTmpDir: string;
  readonly publicBaseUrl: string;
  readonly isSecureOrigin: boolean;
  readonly visitorCookieName: string;
  readonly maxUploadBytes: number;
  readonly maxUploadFiles: number;
  readonly maxConcurrentUploads: number;
  readonly maxImagePixels: number;
  readonly accessMode: 'friends-only' | 'public';
  readonly featuredPlaceSlug: string | undefined;
  readonly mediaDiskHighWatermark: number;
  readonly visitorCookieMaxAge: number;
};

/** Preview widths persisted as independent derivative files (DATA_API_STORAGE §4.1). */
export const PREVIEW_SIZES = [400, 1200] as const;
export type PreviewSize = (typeof PREVIEW_SIZES)[number];

/** Mime types accepted in v1. HEIC/HEIF is rejected on purpose (DATA_API_STORAGE §4.1). */
export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

function filePathFromSqliteUrl(url: string): string {
  if (!url.startsWith('file:')) {
    throw new Error(`DATABASE_URL must be a file: URL in v1 (received "${url}").`);
  }
  const raw = url.slice('file:'.length).split('?')[0] ?? '';
  // Windows absolute paths (file:D:\… or file:C:/…) need the leading slash dropped.
  const isWindowsAbsolute = /^\/[A-Za-z]:[\\/]/.test(raw);
  const resolved = path.normalize(isWindowsAbsolute ? raw.slice(1) : raw);
  if (!path.isAbsolute(resolved)) {
    throw new Error(
      `DATABASE_URL must point at an absolute SQLite path (received "${url}"). ` +
        `Relative paths would let a release write its database inside the app bundle.`,
    );
  }
  return resolved;
}

function buildConfig(env: Env): AppConfig {
  const databaseFile = filePathFromSqliteUrl(env.DATABASE_URL);
  const mediaRoot = path.resolve(env.MEDIA_ROOT);
  const isSecureOrigin = env.PUBLIC_BASE_URL.startsWith('https://');

  if (!path.isAbsolute(env.UPLOAD_TMP_DIR)) {
    throw new Error('UPLOAD_TMP_DIR must be an absolute path.');
  }

  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isE2E: env.ISLE_E2E,
    databaseUrl: env.DATABASE_URL,
    databaseFile,
    mediaRoot,
    originalDir: path.join(mediaRoot, 'original'),
    previewRoot: path.join(mediaRoot, 'preview'),
    uploadTmpDir: path.resolve(env.UPLOAD_TMP_DIR),
    publicBaseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, ''),
    isSecureOrigin,
    // __Host- prefix requires Secure, which http://127.0.0.1 cannot set (ADR-003).
    visitorCookieName: isSecureOrigin ? '__Host-isle_visitor' : 'isle_visitor',
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    maxUploadFiles: env.MAX_UPLOAD_FILES,
    maxConcurrentUploads: env.MAX_CONCURRENT_UPLOADS_PER_CLIENT,
    maxImagePixels: env.MAX_IMAGE_PIXELS,
    accessMode: env.SITE_ACCESS_MODE,
    featuredPlaceSlug: env.FEATURED_PLACE_SLUG,
    mediaDiskHighWatermark: env.MEDIA_DISK_HIGH_WATERMARK,
    visitorCookieMaxAge: env.VISITOR_COOKIE_MAX_AGE,
  };
}

let cached: AppConfig | undefined;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid ISLE configuration:\n${detail}`);
  }
  return buildConfig(parsed.data);
}

/** Memoised accessor for runtime code paths. */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test-only: drop the memoised value so a new env takes effect. */
export function resetConfigCache(): void {
  cached = undefined;
}

/** Human-readable limits used by upload copy so UI and API never disagree. */
export function describeLimits(config: AppConfig = getConfig()) {
  return {
    maxUploadBytes: config.maxUploadBytes,
    maxUploadMiB: Math.round(config.maxUploadBytes / MIB),
    maxUploadFiles: config.maxUploadFiles,
    maxConcurrentUploads: config.maxConcurrentUploads,
    maxImageMegapixels: Math.round(config.maxImagePixels / 1_000_000),
    acceptedTypes: ALLOWED_IMAGE_MIME_TYPES.join(', '),
  } as const;
}
