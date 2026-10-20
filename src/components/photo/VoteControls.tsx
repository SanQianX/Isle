'use client';

import { useCallback, useState, useTransition } from 'react';
import { formatScore } from '@/lib/format';

/**
 * Vote buttons.
 *
 * The interaction the product specifies (PRODUCT_REQUIREMENTS §附):
 *   - tap ↑ for a thumbs up, ↓ for a thumbs down
 *   - tap the SAME arrow again to withdraw, back to 0
 *   - tap the other arrow to switch sides, which moves the score by 2
 *
 * That means the client must send an *absolute* target state, not a delta. The
 * server is what enforces it; this component just has to not get it wrong.
 *
 * Optimistic update, then reconcile with the server's authoritative aggregate.
 * If the request fails the UI is rolled back to exactly what it was, because a
 * score that looks changed but isn't would be worse than no response at all.
 */

export type VoteControlsProps = {
  photoId: string;
  score: number;
  upCount: number;
  downCount: number;
  currentVote: -1 | 0 | 1;
  /** 'hero' is the larger pair beside the leader image. */
  variant?: 'inline' | 'hero';
  /** Called after a successful vote so the page can re-rank if needed. */
  onVoteApplied?: (result: {
    photoId: string;
    score: number;
    upCount: number;
    downCount: number;
    currentVisitorVote: number;
    rankingMayHaveChanged: boolean;
  }) => void;
};

type VoteResponse = {
  photoId: string;
  currentVisitorVote: number;
  score: number;
  upCount: number;
  downCount: number;
  rankingMayHaveChanged: boolean;
};

export function VoteControls({
  photoId,
  score: initialScore,
  upCount: initialUpCount,
  downCount: initialDownCount,
  currentVote: initialVote,
  variant = 'inline',
  onVoteApplied,
}: VoteControlsProps) {
  const [score, setScore] = useState(initialScore);
  const [upCount, setUpCount] = useState(initialUpCount);
  const [downCount, setDownCount] = useState(initialDownCount);
  const [vote, setVote] = useState<-1 | 0 | 1>(initialVote);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Guards against a double click firing two requests that would race.
  const [inFlight, setInFlight] = useState(false);

  const apply = useCallback(
    (next: -1 | 0 | 1) => {
      // Clicking the selected arrow withdraws the vote; that is the whole rule.
      const target = vote === next ? 0 : next;
      if (target === vote) return;

      // Optimistic: derive the new aggregate locally so the UI feels instant.
      const previous = { score, upCount, downCount, vote };
      const nextUp = upCount + (target === 1 ? 1 : 0) - (vote === 1 ? 1 : 0);
      const nextDown = downCount + (target === -1 ? 1 : 0) - (vote === -1 ? 1 : 0);

      setVote(target);
      setUpCount(nextUp);
      setDownCount(nextDown);
      setScore(nextUp - nextDown);
      setError(null);
      setInFlight(true);

      void (async () => {
        try {
          const response = await fetch(`/api/photos/${photoId}/vote`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ value: target }),
          });

          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as {
              error?: { message?: string };
            } | null;
            throw new Error(body?.error?.message ?? '投票失败，请稍后再试');
          }

          const result = (await response.json()) as VoteResponse;
          startTransition(() => {
            setVote(
              result.currentVisitorVote === 1 ? 1 : result.currentVisitorVote === -1 ? -1 : 0,
            );
            setUpCount(result.upCount);
            setDownCount(result.downCount);
            setScore(result.score);
          });
          onVoteApplied?.(result);
        } catch (cause) {
          // Roll all the way back: a score that lies about what was stored is the
          // one failure mode this product cannot have.
          setScore(previous.score);
          setUpCount(previous.upCount);
          setDownCount(previous.downCount);
          setVote(previous.vote);
          setError(cause instanceof Error ? cause.message : '投票失败，请稍后再试');
        } finally {
          setInFlight(false);
        }
      })();
    },
    [downCount, onVoteApplied, photoId, score, upCount, vote],
  );

  const buttonClass = variant === 'hero' ? '' : '';
  const disabled = inFlight || pending;

  return (
    // The wrapper is a column so a failure can be *seen*. The error used to
    // live only in the live region below, which is the screen-reader channel:
    // a sighted user whose vote was refused saw the score snap back and
    // nothing else. FRONTEND_UX §3.3 asks for visible success/error feedback
    // on the vote control, and a message only a screen reader can hear is
    // not feedback for most of the people using the site.
    <div className={`vote-control ${buttonClass}`.trim()} data-testid={`vote-${photoId}`}>
      <div className="vote-inline">
        <button
          type="button"
          onClick={() => apply(1)}
          disabled={disabled}
          aria-pressed={vote === 1}
          aria-label="赞成这张照片"
          data-testid={`vote-up-${photoId}`}
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => apply(-1)}
          disabled={disabled}
          aria-pressed={vote === -1}
          aria-label="反对这张照片"
          data-testid={`vote-down-${photoId}`}
        >
          ↓
        </button>
      </div>

      {error !== null ? (
        <span
          className="vote-error"
          role="alert"
          data-testid={`vote-error-${photoId}`}
          title={error}
        >
          {error}
        </span>
      ) : null}

      <span className="sr-only" aria-live="polite" data-testid={`vote-status-${photoId}`}>
        {`当前 ${formatScore(score)} 分`}
      </span>
    </div>
  );
}
