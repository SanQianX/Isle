import { createHash, randomBytes } from 'node:crypto';
import type { Visitor } from '@prisma/client';
import { getConfig } from '@/lib/config';
import { getPrisma } from '@/server/db/client';

/**
 * Anonymous visitor identity (DATA_API_STORAGE §2.3).
 *
 * The browser holds a random token. The database holds only its SHA-256. The
 * token is never returned by any API, never logged, and never accepted from a
 * request body — a client that claims a visitorId is simply ignored, because
 * no code path reads one.
 *
 * Honest limitation, stated here and in the runbook: this identifies a *browser
 * profile*, not a person. Clearing cookies or switching browsers produces a new
 * identity and the old votes stay with the old one. Nothing here pretends to
 * stop a determined person from voting twice.
 */

const TOKEN_BYTES = 32; // 256 bits, comfortably above the 128-bit minimum
const DISPLAY_CODE_PATTERN = /^[0-9a-f]{6}$/;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Six lowercase hex characters, retried on the (astronomically unlikely)
 * collision with an existing display code, which is uniquely indexed.
 */
async function allocateDisplayCode(): Promise<string> {
  const prisma = await getPrisma();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomBytes(3).toString('hex'); // 3 bytes -> exactly 6 hex chars
    if (!DISPLAY_CODE_PATTERN.test(code)) continue;
    const taken = await prisma.visitor.findUnique({
      where: { displayCode: code },
      select: { id: true },
    });
    if (taken === null) return code;
  }
  throw new Error('Unable to allocate a unique visitor display code');
}

export type ResolvedVisitor = {
  visitor: Visitor;
  /** True when a fresh token was minted and must be written back as a cookie. */
  issued: boolean;
  /**
   * Plaintext token to set as a cookie, or null when an existing identity was
   * reused. The plaintext exists only in this return value and the Set-Cookie
   * header; it is never stored, logged or echoed in a response body.
   */
  token: string | null;
};

/**
 * Resolve the caller from its cookie token, minting a new identity when the
 * cookie is absent, malformed, or does not match any stored hash.
 *
 * A tampered cookie is treated exactly like a missing one: the caller gets a new
 * identity and their old votes remain under the old one. There is no attempt to
 * "repair" or recover a guessed token.
 */
export async function resolveVisitor(rawToken: string | undefined): Promise<ResolvedVisitor> {
  const prisma = await getPrisma();

  const looksLikeToken =
    typeof rawToken === 'string' &&
    rawToken.length >= 43 &&
    rawToken.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(rawToken);

  if (looksLikeToken) {
    const existing = await prisma.visitor.findUnique({ where: { tokenHash: hashToken(rawToken) } });
    if (existing !== null) {
      // Touch lastSeenAt lazily; a failure here must not fail the request.
      await prisma.visitor
        .update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
      return { visitor: existing, issued: false, token: null };
    }
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const displayCode = await allocateDisplayCode();
  const visitor = await prisma.visitor.create({
    data: { tokenHash: hashToken(token), displayCode },
  });

  return { visitor, issued: true, token };
}

export function readVisitorTokenFromCookieHeader(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  const config = getConfig();
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== config.visitorCookieName) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

export function buildVisitorCookie(token: string): string {
  const config = getConfig();
  const parts = [
    `${config.visitorCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.visitorCookieMaxAge}`,
  ];
  // __Host- is only valid with Secure, which requires HTTPS.
  if (config.isSecureOrigin) parts.push('Secure');
  return parts.join('; ');
}

/** Public, non-identifying label. Never returns the token or its hash. */
export function visitorDisplayLabel(visitor: Pick<Visitor, 'displayCode'>): string {
  return `访客 #${visitor.displayCode}`;
}

export { hashToken };
