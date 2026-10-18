import { ApiError } from '@/lib/errors';
import { getPrisma, TRANSACTION_OPTIONS } from '@/server/db/client';
import { tallyVotes } from '@/server/ranking';

/**
 * Voting (DATA_API_STORAGE §2.2).
 *
 * The API is PUT with an *absolute* target state: `{value: -1 | 0 | 1}` means
 * "after this request, my vote should be exactly this". The server never
 * increments on receipt of a request. That is what makes the endpoint safely
 * retryable and what lets the client send `value: 0` when a user clicks the
 * button they already selected.
 *
 * Withdrawing a vote DELETEs the row. A `value` of 0 is never stored, so
 * "how many neutral votes are there" is always zero rather than a count that has
 * to be reasoned about.
 */

export type VoteValue = -1 | 0 | 1;
export type VoteAction = 'insert' | 'keep' | 'delete';

export type VoteTransition = {
  /** What to do with the Vote row. */
  action: VoteAction;
  /** Value to persist; 0 means the row is removed. */
  value: Exclude<VoteValue, 0>;
  /** Change to the photo's aggregate score. */
  scoreDelta: number;
};

/**
 * The complete state machine (DATA_API_STORAGE §2.2).
 *
 * Pure and total: every combination of a current value and a requested value
 * has exactly one outcome. The five cases that are not `insert` are the ones
 * that matter — a server that treated a repeated request as a new vote would
 * let one visitor inflate a score by clicking quickly.
 */
export function voteTransitions(current: VoteValue, requested: VoteValue): VoteTransition {
  if (requested === 0) {
    if (current === 0) return { action: 'keep', value: 1, scoreDelta: 0 };
    return { action: 'delete', value: current, scoreDelta: -current };
  }

  if (current === requested) {
    // Idempotent replay: the desired state already holds.
    return { action: 'keep', value: requested, scoreDelta: 0 };
  }

  if (current === 0) {
    return { action: 'insert', value: requested, scoreDelta: requested };
  }

  // Switching sides moves the score by two, not one.
  return { action: 'insert', value: requested, scoreDelta: requested - current };
}

export type VoteResult = {
  photoId: string;
  currentVisitorVote: VoteValue;
  score: number;
  upCount: number;
  downCount: number;
  rankingMayHaveChanged: boolean;
};

/**
 * Apply an absolute vote target inside a transaction.
 *
 * The read of the current vote and the write that follows it happen in one
 * transaction, and the `(photoId, visitorId)` primary key is the final guard: if
 * two identical requests race, one inserts and the other loses the unique
 * constraint and retries, at which point it observes the new state and becomes
 * a no-op. Score can therefore never double-count.
 */
export async function setVote(
  photoId: string,
  visitorId: string,
  requested: VoteValue,
): Promise<VoteResult> {
  const prisma = await getPrisma();

  return prisma.$transaction(async (tx) => {
    const photo = await tx.photo.findUnique({
      where: { id: photoId },
      select: { id: true, status: true },
    });
    // A HIDDEN or processing photo is a 404, not a silent success.
    if (photo === null || photo.status !== 'READY') {
      throw ApiError.notFound('找不到该照片');
    }

    const existing = await tx.vote.findUnique({
      where: { photoId_visitorId: { photoId, visitorId } },
      select: { value: true },
    });
    const current: VoteValue =
      existing === null ? 0 : existing.value === 1 ? 1 : existing.value === -1 ? -1 : 0;

    const transition = voteTransitions(current, requested);

    switch (transition.action) {
      case 'insert':
        await tx.vote.upsert({
          where: { photoId_visitorId: { photoId, visitorId } },
          create: { photoId, visitorId, value: transition.value },
          update: { value: transition.value },
        });
        break;
      case 'delete':
        await tx.vote.delete({ where: { photoId_visitorId: { photoId, visitorId } } });
        break;
      case 'keep':
        break;
    }

    // Re-derive the aggregate from the table rather than adjusting a running
    // total, so the response can never drift from what is actually stored.
    const votes = await tx.vote.findMany({
      where: { photoId },
      select: { value: true },
    });
    const counts = tallyVotes(votes.map((vote) => ({ photoId, value: vote.value }))).get(
      photoId,
    ) ?? {
      upCount: 0,
      downCount: 0,
    };

    const score = counts.upCount - counts.downCount;
    return {
      photoId,
      currentVisitorVote: requested,
      score,
      upCount: counts.upCount,
      downCount: counts.downCount,
      // Only a genuine score movement can reshuffle the leaderboard.
      rankingMayHaveChanged: transition.scoreDelta !== 0,
    };
  }, TRANSACTION_OPTIONS);
}
