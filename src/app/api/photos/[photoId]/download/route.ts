import { serveMedia } from '@/server/http/media';
import { errorResponse } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/photos/:photoId/download — identical bytes, attachment disposition.
 */
export async function GET(request: Request, context: { params: Promise<{ photoId: string }> }) {
  try {
    const { photoId } = await context.params;
    return await serveMedia(request, photoId, 'download');
  } catch (error) {
    return errorResponse(error);
  }
}
