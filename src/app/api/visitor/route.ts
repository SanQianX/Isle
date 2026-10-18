import { errorResponse } from '@/lib/errors';
import { jsonWithCookie, requireReadContext } from '@/server/http/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/visitor — issues or reuses the anonymous browser identity.
 *
 * Returns only the non-identifying display label. The token never appears in
 * the body, and neither does the stored hash (DATA_API_STORAGE §2.3).
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const context = await requireReadContext(request);
    return jsonWithCookie(
      {
        visitor: {
          displayCode: context.visitor.displayCode,
          displayLabel: context.displayLabel,
        },
      },
      context,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
