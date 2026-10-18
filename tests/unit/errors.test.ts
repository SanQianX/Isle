import { describe, expect, it } from 'vitest';
import { ApiError, ERROR_CODES, errorResponse, isApiError } from '@/lib/errors';

describe('API error contract (DATA_API_STORAGE §3)', () => {
  it.each([
    [ERROR_CODES.BAD_REQUEST, 400],
    [ERROR_CODES.INVALID_VISITOR, 401],
    [ERROR_CODES.INVALID_ORIGIN, 403],
    [ERROR_CODES.NOT_FOUND, 404],
    [ERROR_CODES.DUPLICATE_PLACE, 409],
    [ERROR_CODES.DUPLICATE_UPLOAD, 409],
    [ERROR_CODES.PHOTO_TOO_LARGE, 413],
    [ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, 415],
    [ERROR_CODES.INVALID_IMAGE, 422],
    [ERROR_CODES.IMAGE_TOO_LARGE, 422],
    [ERROR_CODES.RATE_LIMITED, 429],
    [ERROR_CODES.INTERNAL_ERROR, 500],
    [ERROR_CODES.STORAGE_UNAVAILABLE, 503],
  ])('maps %s to HTTP %i', (code, status) => {
    expect(new ApiError(code, '消息').status).toBe(status);
  });

  it('serialises to { error: { code, message } } and omits absent details', async () => {
    const response = errorResponse(ApiError.notFound('找不到该地点'));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: '找不到该地点' },
    });
  });

  it('sets Retry-After on a 429 so clients can back off', async () => {
    const response = errorResponse(ApiError.rateLimited('操作太频繁，请稍后再试', 30));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    const body = await response.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details.retryAfterSeconds).toBe(30);
  });

  it('never leaks internals for an unexpected throw', async () => {
    const secret = new Error('SQLITE_CANTOPEN at /var/lib/isle/db/isle.db');
    const response = errorResponse(secret);
    expect(response.status).toBe(500);

    const body = await response.json();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('/var/lib/isle');
    expect(raw).not.toContain('SQLITE');
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('identifies its own instances only', () => {
    expect(isApiError(ApiError.badRequest('x'))).toBe(true);
    expect(isApiError(new Error('x'))).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError({ code: 'NOT_FOUND' })).toBe(false);
  });
});
