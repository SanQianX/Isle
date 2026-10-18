import { serveMedia } from '@/server/http/media';
import { errorResponse } from '@/lib/errors';
import { ApiError } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SIZES = new Set(['400', '1200']);

/**
 * GET /api/photos/:photoId/preview/:size — an independently stored derivative.
 *
 * The size must be one of the two widths we actually persist; anything else is a
 * 404 rather than a resize-on-the-fly path, which would turn a cheap cacheable
 * URL into an expensive re-encode on every request.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ photoId: string; size: string }> },
) {
  try {
    const { photoId, size } = await context.params;
    if (!SIZES.has(size)) {
      throw ApiError.notFound('找不到该预览尺寸');
    }
    return await serveMedia(request, photoId, 'preview', Number(size));
  } catch (error) {
    return errorResponse(error);
  }
}
