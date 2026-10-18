import { ApiError, ERROR_CODES } from '@/lib/errors';
import { getConfig } from '@/lib/config';
import { getPrisma } from '@/server/db/client';
import {
  buildVisitorCookie,
  readVisitorTokenFromCookieHeader,
  resolveVisitor,
  visitorDisplayLabel,
  type ResolvedVisitor,
} from '@/server/auth/visitor';

/**
 * Cross-cutting request concerns: identity, CSRF origin checking and rate
 * limiting. Every mutating route goes through `requireWriteContext`, so no
 * handler can accidentally skip one of them.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reject cross-site writes (DATA_API_STORAGE §2.3).
 *
 * Browsers omit Origin on same-origin GET, and some non-browser clients omit it
 * entirely; a missing Origin on a write is therefore allowed (it cannot have
 * been produced by a browser cross-site form post without a cookie being sent
 * SameSite=Lax). A *present* Origin must match exactly — that is the signal
 * that matters, and it is what a CSRF attempt looks like.
 */
export function assertSameOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;

  const origin = request.headers.get('origin');
  if (origin === null) return;

  const expected = new URL(getConfig().publicBaseUrl).origin;
  if (origin !== expected) {
    throw ApiError.invalidOrigin();
  }
}

export type WriteContext = {
  visitor: ResolvedVisitor['visitor'];
  /** Cookie header to append to the response, when a new identity was minted. */
  setCookie: string | null;
  displayLabel: string;
};

/**
 * Resolve identity and enforce origin for a mutating request.
 *
 * Throws `ApiError` (INVALID_ORIGIN / INVALID_VISITOR) rather than returning a
 * partially-valid context, so a handler cannot forget to check.
 */
export async function requireWriteContext(request: Request): Promise<WriteContext> {
  assertSameOrigin(request);
  const resolved = await resolveVisitor(
    readVisitorTokenFromCookieHeader(request.headers.get('cookie')),
  );
  return {
    visitor: resolved.visitor,
    setCookie: resolved.token === null ? null : buildVisitorCookie(resolved.token),
    displayLabel: visitorDisplayLabel(resolved.visitor),
  };
}

/** Read-only requests still need an identity so vote state can be personalised. */
export async function requireReadContext(request: Request): Promise<WriteContext> {
  const resolved = await resolveVisitor(
    readVisitorTokenFromCookieHeader(request.headers.get('cookie')),
  );
  return {
    visitor: resolved.visitor,
    setCookie: resolved.token === null ? null : buildVisitorCookie(resolved.token),
    displayLabel: visitorDisplayLabel(resolved.visitor),
  };
}

/** Attach a Set-Cookie header when a new identity was created. */
export function withVisitorCookie(headers: Headers, context: WriteContext): Headers {
  if (context.setCookie !== null) headers.append('Set-Cookie', context.setCookie);
  return headers;
}

export function jsonWithCookie(
  body: unknown,
  context: WriteContext,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'private, no-store');
  withVisitorCookie(headers, context);
  return Response.json(body, { ...init, headers });
}

// --- Rate limiting (ADR-009) -------------------------------------------------

/**
 * High-frequency limits live in process memory: they only need to hold for the
 * length of a burst, and a restart resetting them is acceptable.
 */
type Window = { count: number; resetAt: number };
const memoryWindows = new Map<string, Window>();

function memoryKey(visitorId: string, rule: string): string {
  return `${rule}:${visitorId}`;
}

function sweepMemoryWindows(now: number): void {
  for (const [key, window] of memoryWindows) {
    if (window.resetAt <= now) memoryWindows.delete(key);
  }
}

/**
 * Sliding-window limit. Returns null when allowed, or the number of seconds to
 * wait when refused.
 */
export function checkMemoryRateLimit(
  visitorId: string,
  rule: string,
  limit: number,
  windowMs: number,
): number | null {
  const now = Date.now();
  const key = memoryKey(visitorId, rule);
  const existing = memoryWindows.get(key);

  if (existing === undefined || existing.resetAt <= now) {
    memoryWindows.set(key, { count: 1, resetAt: now + windowMs });
    // Cheap periodic sweep; the map only holds visitors seen recently.
    if (memoryWindows.size > 512) sweepMemoryWindows(now);
    return null;
  }

  existing.count += 1;
  if (existing.count <= limit) return null;
  return Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
}

/** Test-only: clear the in-memory limiter between cases. */
export function resetMemoryRateLimits(): void {
  memoryWindows.clear();
}

export type QuotaRule = {
  /** Bucket name; include the day for daily quotas. */
  name: string;
  limit: number;
  /** Bucket lifetime. Defaults to one day. */
  ttlMs?: number;
};

/**
 * Durable quota, stored in SQLite so it survives a restart. Used for the daily
 * "at most N places / N uploads" rules.
 */
export async function checkDurableQuota(
  visitorId: string,
  rule: QuotaRule,
): Promise<number | null> {
  const prisma = await getPrisma();
  const ttlMs = rule.ttlMs ?? 24 * 60 * 60 * 1000;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  // Prisma has no atomic upsert-with-increment, so read then write inside a
  // transaction. The primary key makes a lost update harmless: the worst case is
  // a quota reset, never an unbounded hole.
  return prisma.$transaction(async (tx) => {
    const existing = await tx.rateBucket.findUnique({
      where: { visitorId_bucket: { visitorId, bucket: rule.name } },
    });

    if (existing === null || existing.expiresAt <= now) {
      await tx.rateBucket.upsert({
        where: { visitorId_bucket: { visitorId, bucket: rule.name } },
        create: { visitorId, bucket: rule.name, count: 1, expiresAt },
        update: { count: 1, expiresAt },
      });
      return null;
    }

    if (existing.count >= rule.limit) {
      return Math.max(1, Math.ceil((existing.expiresAt.getTime() - now.getTime()) / 1000));
    }

    await tx.rateBucket.update({
      where: { visitorId_bucket: { visitorId, bucket: rule.name } },
      data: { count: { increment: 1 } },
    });
    return null;
  });
}

/** Roll a rate-limit refusal back into the documented 429 response. */
export function rateLimited(retryAfterSeconds: number, message: string): never {
  throw ApiError.rateLimited(message, retryAfterSeconds);
}

export const LIMITS = {
  /** DATA_API_STORAGE §5 — per visitor, per day. */
  placesPerDay: 3,
  photosPerDay: 30,
  /** Per minute. */
  votesPerMinute: 120,
  voteBurst: 30,
  uploadBurstPerMinute: 12,
} as const;

export function dailyBucket(name: string, at: Date = new Date()): string {
  return `${name}:${at.toISOString().slice(0, 10)}`;
}

export { ERROR_CODES };
