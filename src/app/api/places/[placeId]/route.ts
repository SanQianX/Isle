import { ApiError, errorResponse } from '@/lib/errors';
import { jsonWithCookie, requireReadContext } from '@/server/http/request';
import { getPlaceById, getPlaceBySlug } from '@/server/services/place';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ placeId: string }> };

/**
 * GET /api/places/:placeId — place detail.
 *
 * Accepts either the internal id or the URL slug (DATA_API_STORAGE §3: the URL
 * uses the slug, the server resolves it). A malformed id is a 404, never a 500:
 * an unknown string is indistinguishable from a missing place and must not leak
 * whether it exists.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const readContext = await requireReadContext(request);
    const { placeId } = await context.params;

    if (typeof placeId !== 'string' || placeId.length === 0 || placeId.length > 64) {
      throw ApiError.notFound('找不到该地点');
    }

    const place = (await getPlaceById(placeId)) ?? (await getPlaceBySlug(placeId));
    if (place === null) throw ApiError.notFound('找不到该地点');

    return jsonWithCookie({ place }, readContext);
  } catch (error) {
    return errorResponse(error);
  }
}
