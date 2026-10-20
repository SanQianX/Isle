/**
 * Typed API errors.
 *
 * DATA_API_STORAGE §3 requires every failure to carry a locatable machine code
 * alongside a human-readable (Chinese) message, and requires real HTTP status
 * semantics — never a swallowed exception returning 200.
 */

export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  INVALID_VISITOR: 'INVALID_VISITOR',
  INVALID_ORIGIN: 'INVALID_ORIGIN',
  NOT_FOUND: 'NOT_FOUND',
  DUPLICATE_PLACE: 'DUPLICATE_PLACE',
  DUPLICATE_UPLOAD: 'DUPLICATE_UPLOAD',
  PHOTO_TOO_LARGE: 'PHOTO_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  INVALID_IMAGE: 'INVALID_IMAGE',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  // A deliberate pause, distinct from a storage fault. Both are 503 and both
  // mean "try later", but an operator reading the logs needs to be able to
  // tell "the site is in maintenance" from "the disk is broken".
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  INVALID_VISITOR: 401,
  INVALID_ORIGIN: 403,
  NOT_FOUND: 404,
  DUPLICATE_PLACE: 409,
  DUPLICATE_UPLOAD: 409,
  PHOTO_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INVALID_IMAGE: 422,
  IMAGE_TOO_LARGE: 422,
  RATE_LIMITED: 429,
  STORAGE_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export type ApiErrorBody = {
  error: { code: ErrorCode; message: string; details?: unknown };
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(ERROR_CODES.BAD_REQUEST, message, details);
  }

  static notFound(message = '找不到该内容') {
    return new ApiError(ERROR_CODES.NOT_FOUND, message);
  }

  static duplicatePlace(message: string, details?: unknown) {
    return new ApiError(ERROR_CODES.DUPLICATE_PLACE, message, details);
  }

  static invalidOrigin(message = '请求来源不被信任，已拒绝写入') {
    return new ApiError(ERROR_CODES.INVALID_ORIGIN, message);
  }

  static tooLarge(message: string) {
    return new ApiError(ERROR_CODES.PHOTO_TOO_LARGE, message);
  }

  static unsupportedType(message: string) {
    return new ApiError(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, message);
  }

  static invalidImage(message: string) {
    return new ApiError(ERROR_CODES.INVALID_IMAGE, message);
  }

  static rateLimited(message: string, retryAfterSeconds: number) {
    return new ApiError(ERROR_CODES.RATE_LIMITED, message, { retryAfterSeconds });
  }

  static storageUnavailable(message = '照片存储暂时不可用，请稍后再试') {
    return new ApiError(ERROR_CODES.STORAGE_UNAVAILABLE, message);
  }

  static serviceUnavailable(message = '服务暂时不可用，请稍后再试') {
    return new ApiError(ERROR_CODES.SERVICE_UNAVAILABLE, message);
  }

  static internal(message = '服务器开小差了，请稍后再试') {
    return new ApiError(ERROR_CODES.INTERNAL_ERROR, message);
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Convert an unknown throw into a JSON response with correct status.
 * Unexpected errors become a generic 500 — internal details never leak.
 */
export function errorResponse(error: unknown): Response {
  if (isApiError(error)) {
    const headers = new Headers();
    const retryAfter = (error.details as { retryAfterSeconds?: number } | undefined)
      ?.retryAfterSeconds;
    if (typeof retryAfter === 'number') {
      headers.set('Retry-After', String(retryAfter));
    }
    return Response.json(error.toBody(), { status: error.status, headers });
  }

  console.error('[isle] unhandled error:', error);
  return Response.json(ApiError.internal().toBody(), { status: 500 });
}
