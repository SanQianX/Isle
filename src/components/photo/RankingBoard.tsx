'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PhotoWall } from '@/components/photo/PhotoWall';
import { Lightbox } from '@/components/lightbox/PhotoLightbox';
import { VoteControls } from '@/components/photo/VoteControls';
import { formatRank, formatScore } from '@/lib/format';
import { toWallPhoto } from '@/lib/wall-photo';

/**
 * The full leaderboard, interactive.
 *
 * Re-ranking on a vote is the hard part. Three things must not happen:
 *
 *   1. the page must not jump to the top,
 *   2. keyboard focus must not be lost when the DOM order changes,
 *   3. the photo the user just voted for must keep its identity.
 *
 * All three fall out of keying on `photo.id` (never on rank or array index),
 * remembering which button had focus, and re-focusing it by id after the sort.
 * An `aria-live` region announces the reorder so the change is not silent for
 * anyone who cannot see the page move.
 */

export type RankingItem = {
  id: string;
  rank: number;
  title: string;
  description: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
  createdAt: string;
  uploaderDisplayCode: string;
  score: number;
  upCount: number;
  downCount: number;
  currentVisitorVote: -1 | 0 | 1;
  preview400Url: string;
  preview1200Url: string;
  originalUrl: string;
  downloadUrl: string;
};

/** Mirrors src/server/ranking.ts. Kept in sync by tests/unit/ranking.test.ts. */
function compareItems(
  a: Pick<RankingItem, 'score' | 'upCount' | 'createdAt' | 'id'>,
  b: Pick<RankingItem, 'score' | 'upCount' | 'createdAt' | 'id'>,
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.upCount !== b.upCount) return b.upCount - a.upCount;
  const createdDelta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (createdDelta !== 0) return createdDelta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type Props = {
  placeId: string;
  placeName: string;
  placeSlug: string;
  items: RankingItem[];
};

export function RankingBoard({ placeId, placeName, placeSlug, items: initialItems }: Props) {
  const searchParams = useSearchParams();
  const photoParam = searchParams.get('photo');

  const [items, setItems] = useState<RankingItem[]>(initialItems);
  const [announcement, setAnnouncement] = useState('');

  // The viewer is driven by local state, not by useSearchParams. Closing then
  // never waits on a server round trip, so the element that opened it is still
  // in the DOM when focus is handed back. The URL is kept in sync as a side
  // effect, purely so the link is shareable and Back still closes the viewer.
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(photoParam);

  // A deep link arriving from outside (paste, shared URL) still opens the
  // viewer. Values this component wrote itself are ignored: an in-flight
  // router.push can echo back the photo we just closed, and honouring that
  // would reopen the viewer the moment the user pressed Escape.
  const selfWrittenRef = useRef<string | null>(null);
  useEffect(() => {
    if (photoParam === null) return;
    if (selfWrittenRef.current !== null) {
      if (selfWrittenRef.current === photoParam) return;
      selfWrittenRef.current = null;
    }
    setOpenPhotoId(photoParam);
  }, [photoParam]);
  // Which vote button currently holds keyboard focus, so it can be restored.
  const focusRef = useRef<string | null>(null);

  const handleVote = useCallback(
    (result: {
      photoId: string;
      score: number;
      upCount: number;
      downCount: number;
      currentVisitorVote: number;
      rankingMayHaveChanged: boolean;
    }) => {
      const before = items.find((item) => item.id === result.photoId);
      if (before === undefined) return;

      const updated: RankingItem[] = items.map((item) =>
        item.id === result.photoId
          ? {
              ...item,
              score: result.score,
              upCount: result.upCount,
              downCount: result.downCount,
              currentVisitorVote: (result.currentVisitorVote === 1
                ? 1
                : result.currentVisitorVote === -1
                  ? -1
                  : 0) as -1 | 0 | 1,
            }
          : item,
      );

      const sorted = [...updated].sort(compareItems).map((item, index) => ({
        ...item,
        rank: index + 1,
      }));

      const newRank = sorted.findIndex((item) => item.id === result.photoId) + 1;

      // Restore focus by photo id. The DOM nodes move on re-sort, so focus would
      // otherwise land on whatever slid into the focused slot.
      const restore = focusRef.current;
      setItems(sorted);

      if (restore !== null) {
        queueMicrotask(() => {
          document.querySelector<HTMLElement>(restore)?.focus({ preventScroll: true });
        });
      }

      if (newRank !== before.rank) {
        setAnnouncement(`「${before.title}」从第 ${before.rank} 名变为第 ${newRank} 名。`);
      } else {
        setAnnouncement(
          `「${before.title}」现在是 ${formatScore(result.score)} 分，第 ${newRank} 名。`,
        );
      }
    },
    [items],
  );

  const [leader, ...rest] = items;

  const urlWithPhoto = useCallback((id: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set('photo', id);
    const query = params.toString();
    return `${window.location.pathname}${query === '' ? '' : `?${query}`}`;
  }, []);

  /**
   * Open the viewer.
   *
   * Uses the History API rather than the router. Routing every viewer change
   * through Next triggered an RSC refetch, and the test suite's rapid clicks
   * then raced that refetch -- arrows could land twice, and Back could walk
   * past the page entirely. A pushState is instant and has no render to wait
   * for; the viewer is already driven by local state.
   */
  const openPhoto = useCallback(
    (id: string) => {
      selfWrittenRef.current = id;
      setOpenPhotoId(id);
      // push, not replace: Back must close the viewer (NAV-03).
      window.history.pushState({ photo: id }, '', urlWithPhoto(id));
    },
    [urlWithPhoto],
  );

  /**
   * Moving between photos inside the viewer updates the URL with replace, not
   * push. Pushing per photo would make Back walk back through every image the
   * user looked at, instead of simply closing the viewer (NAV-03).
   */
  const stepToPhoto = useCallback(
    (id: string) => {
      selfWrittenRef.current = id;
      setOpenPhotoId(id);
      // replace: Back should close the viewer, not retrace the photos in it.
      window.history.replaceState({ photo: id }, '', urlWithPhoto(id));
    },
    [urlWithPhoto],
  );

  const closePhoto = useCallback(() => {
    selfWrittenRef.current = null;
    setOpenPhotoId(null);
    const params = new URLSearchParams(window.location.search);
    params.delete('photo');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query === '' ? '' : `?${query}`}`,
    );
  }, []);

  // Popstate: the browser Back button closes the viewer.
  useEffect(() => {
    const onPop = () => {
      selfWrittenRef.current = null;
      const fromUrl = new URLSearchParams(window.location.search).get('photo');
      setOpenPhotoId(fromUrl);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const wallPhotos = useMemo(() => rest.map(toWallPhoto), [rest]);

  if (leader === undefined) {
    return (
      <div className="feature-empty">
        <div>
          <h3>还没有照片</h3>
          <p>{placeName}的照片榜还没有照片。上传第一张，这里就有了第一名。</p>
        </div>
        <a href={`/places/${placeSlug}/upload`} className="btn-outline">
          ＋ 上传第一张照片 ↗
        </a>
      </div>
    );
  }

  return (
    <div data-place-id={placeId}>
      {/* Announcements for reorders, so a silent reshuffle is not a silent one. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="ranking-announcement">
        {announcement}
      </p>

      <div className="rank-feature">
        <button
          className="photo-tap"
          type="button"
          onClick={() => openPhoto(leader.id)}
          aria-label={`查看第一名照片原图：${leader.title}`}
          data-testid="ranking-leader-open"
        >
          <div className="photo-media">
            <img
              src={leader.preview1200Url}
              alt={leader.title}
              width={leader.width}
              height={leader.height}
              fetchPriority="high"
              data-testid="ranking-leader-image"
            />
          </div>
        </button>
        <div>
          <div className="feature-number">
            CURRENT NO.01 / {String(items.length).padStart(2, '0')}
          </div>
          <div className="feature-position" data-testid="ranking-leader-rank">
            01
            <span style={{ fontSize: '18px', verticalAlign: 'top', color: 'var(--muted)' }}>
              　/ 第一名
            </span>
          </div>
          <h2>{leader.title}</h2>
          <p>
            访客 #{leader.uploaderDisplayCode} 分享于{placeName}
            <br />
            {leader.description}
          </p>
          <div className="big-vote">
            <strong className="count" data-testid={`photo-score-${leader.id}`}>
              {formatScore(leader.score)}
            </strong>
            <span
              onFocusCapture={() => {
                focusRef.current = `[data-testid="vote-up-${leader.id}"]`;
              }}
              onBlurCapture={() => {
                focusRef.current = null;
              }}
            >
              <VoteControls
                photoId={leader.id}
                score={leader.score}
                upCount={leader.upCount}
                downCount={leader.downCount}
                currentVote={leader.currentVisitorVote}
                variant="hero"
                onVoteApplied={handleVote}
              />
            </span>
          </div>
        </div>
      </div>

      {rest.length > 0 ? (
        <>
          <div className="ranking-mini">
            <strong>全部参选照片</strong>
            <span>按净票数排序 · 同分先比赞成票，再比上传时间</span>
          </div>

          <PhotoWall
            photos={wallPhotos}
            onPhotoOpen={openPhoto}
            renderCaption={(photo) => {
              const full = items.find((item) => item.id === photo.id);
              if (full === undefined) return null;
              return (
                <div className="small-vote">
                  <span className="score count" data-testid={`photo-score-${full.id}`}>
                    {formatScore(full.score)}
                  </span>
                  <span
                    onFocusCapture={() => {
                      focusRef.current = `[data-testid="vote-up-${full.id}"]`;
                    }}
                    onBlurCapture={() => {
                      focusRef.current = null;
                    }}
                  >
                    <VoteControls
                      photoId={full.id}
                      score={full.score}
                      upCount={full.upCount}
                      downCount={full.downCount}
                      currentVote={full.currentVisitorVote}
                      variant="inline"
                      onVoteApplied={handleVote}
                    />
                  </span>
                </div>
              );
            }}
          />
        </>
      ) : (
        <p className="muted" style={{ padding: '40px 0', fontSize: '13px' }}>
          还没有其他照片。
        </p>
      )}

      <Lightbox
        items={items}
        activeId={openPhotoId}
        onClose={closePhoto}
        onNavigate={stepToPhoto}
        onVoteApplied={handleVote}
      />
    </div>
  );
}

export { formatRank };
