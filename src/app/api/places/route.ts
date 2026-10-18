import { ApiError, errorResponse } from '@/lib/errors';
import {
  checkDurableQuota,
  dailyBucket,
  jsonWithCookie,
  LIMITS,
  rateLimited,
  requireReadContext,
  requireWriteContext,
} from '@/server/http/request';
import { createPlace, createPlaceSchema, listPlaces } from '@/server/services/place';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/places — public list, no identity required beyond a display code. */
export async function GET(request: Request): Promise<Response> {
  try {
    const context = await requireReadContext(request);
    const places = await listPlaces();
    return jsonWithCookie({ places }, context);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/places — create a place.
 *
 * Requires the visitor cookie and a same-origin request, and is capped at 3 new
 * places per visitor per day (DATA_API_STORAGE §5).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const context = await requireWriteContext(request);

    const retryAfter = await checkDurableQuota(context.visitor.id, {
      name: dailyBucket('place-create'),
      limit: LIMITS.placesPerDay,
    });
    if (retryAfter !== null) {
      rateLimited(retryAfter, '今天创建的地点太多了，明天再来吧');
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw ApiError.badRequest('请求格式不正确');
    }

    const parsed = createPlaceSchema.safeParse(payload);
    if (!parsed.success) {
      throw ApiError.badRequest(parsed.error.issues[0]?.message ?? '请检查填写的内容', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const place = await createPlace(parsed.data);
    return jsonWithCookie({ place }, context, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
