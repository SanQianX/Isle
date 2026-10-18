import { serveMedia } from '@/server/http/media';
import { errorResponse } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET|HEAD /api/photos/:photoId/original — the uploaded file, byte for byte.
 *
 * Streamed from disk, never re-encoded and never routed through the Next image
 * optimizer (DATA_API_STORAGE §3).
 */
export async function GET(request: Request, context: { params: Promise<{ photoId: string }> }) {
  try {
    const { photoId } = await context.params;
    return await serveMedia(request, photoId, 'original');
  } catch (error) {
    return errorResponse(error);
  }
}

export async function HEAD(request: Request, context: { params: Promise<{ photoId: string }> }) {
  try {
    const { photoId } = await context.params;
    return await serveMedia(request, photoId, 'original');
  } catch (error) {
    return errorResponse(error);
  }
}
