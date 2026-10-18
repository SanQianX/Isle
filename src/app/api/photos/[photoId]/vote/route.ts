import { z } from 'zod';
import { ApiError, errorResponse } from '@/lib/errors';
import {
  checkMemoryRateLimit,
  jsonWithCookie,
  LIMITS,
  rateLimited,
  requireWriteContext,
} from '@/server/http/request';
import { setVote, type VoteValue } from '@/server/services/vote';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ photoId: string }> };

/**
 * Strict: anything that is not exactly -1, 0 or 1 is rejected. `"1"`, `true`,
 * `5` and `null` must not be coerced into a vote.
 */
const voteBodySchema = z
  .object({
    value: z
      .union([z.literal(-1), z.literal(0), z.literal(1)])
      .describe('投票的绝对目标状态：1 赞成，-1 反对，0 撤销'),
  })
  .strict();

/**
 * PUT /api/photos/:photoId/vote — set the caller's vote to an absolute value.
 *
 * PUT rather than POST because the body states the *desired* vote, so retrying
 * the same request is a no-op rather than a second vote (DATA_API_STORAGE §2.2).
 */
export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const writeContext = await requireWriteContext(request);

    const limited = checkMemoryRateLimit(
      writeContext.visitor.id,
      'vote',
      LIMITS.votesPerMinute,
      60_000,
    );
    if (limited !== null) {
      rateLimited(limited, '投票太频繁了，请稍后再试');
    }

    const { photoId } = await context.params;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw ApiError.badRequest('请求格式不正确');
    }

    const parsed = voteBodySchema.safeParse(payload);
    if (!parsed.success) {
      throw ApiError.badRequest('投票只能是 1（赞成）、-1（反对）或 0（撤销）', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const result = await setVote(photoId, writeContext.visitor.id, parsed.data.value as VoteValue);
    return jsonWithCookie({ ...result }, writeContext);
  } catch (error) {
    return errorResponse(error);
  }
}
