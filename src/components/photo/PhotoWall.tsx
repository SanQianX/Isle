'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { formatRank, formatScore } from '@/lib/format';
import { VoteControls, type VoteControlsProps } from '@/components/photo/VoteControls';
import {
  bestPhotoRows,
  shouldStack,
  singleColumnRows,
  type LayoutRow,
} from '@/features/gallery/best-photo-rows';
import type { WallPhoto } from '@/lib/wall-photo';

export type { WallPhoto };

/**
 * The justified photography wall.
 *
 * Heights and tile widths are computed in JS rather than CSS because the
 * requirement is exact: every photo in a row shares one height, and each tile is
 * precisely as wide as its own ratio demands. CSS flexbox cannot express that.
 *
 * Container width comes from a ResizeObserver, so rotating a phone, resizing a
 * window or opening a side panel all trigger a correct re-layout. `window.
 * innerWidth` would be wrong on every one of those.
 */

type PhotoWallProps = {
  photos: WallPhoto[];
  /**
   * Optional caption override.
   *
   * Only usable from another *client* component: React forbids passing a
   * function from a Server Component to a Client Component, which is why the
   * server-rendered pages rely on the built-in caption instead.
   */
  renderCaption?: (photo: WallPhoto) => React.ReactNode;
  /** Forwarded to the built-in VoteControls, so a live board can re-rank. */
  onVoteApplied?: VoteControlsProps['onVoteApplied'];
};

export function PhotoWall({ photos, renderCaption, onVoteApplied }: PhotoWallProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  // useLayoutEffect, not useEffect: this must run before the browser paints.
  // Measuring after paint means briefly laying out desktop-width tiles on a
  // phone, which shows up as a horizontal scrollbar and a visible jump.
  const measure = useCallback(() => {
    const node = containerRef.current;
    if (node === null) return;
    const styles = getComputedStyle(node);
    const padding = Number.parseFloat(styles.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
    const usable = node.getBoundingClientRect().width - padding - paddingRight;
    if (usable > 0) setContainerWidth(usable);
  }, []);

  useLayoutEffect(() => {
    measure();
    const node = containerRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  // Before the first measurement, stack at full width. Rendering nothing would
  // mean the photographs are absent for a frame, and guessing a desktop width
  // would overflow a phone. Stacking is safe on every engine and is replaced by
  // the justified layout as soon as the real width arrives.
  const isStacked = containerWidth === null || shouldStack(containerWidth);
  const rows: LayoutRow[] =
    photos.length === 0
      ? []
      : containerWidth === null
        ? singleColumnRows(photos, 1)
        : isStacked
          ? singleColumnRows(photos, containerWidth)
          : bestPhotoRows(photos, containerWidth);

  return (
    <div className="photo-grid" ref={containerRef} data-testid="photo-wall">
      {rows.map((row, rowIndex) => {
        return (
          <div
            className={row.isLast ? 'photo-row is-tail' : 'photo-row'}
            key={`row-${rowIndex}-${row.tiles[0]?.id ?? ''}`}
            style={{ '--gallery-gap': '22px' } as React.CSSProperties}
          >
            {row.tiles.map((tile) => {
              const photo = photos[tile.index] as WallPhoto;
              return (
                <div
                  className="photo-card"
                  key={photo.id}
                  data-testid={`photo-card-${photo.id}`}
                  style={
                    isStacked
                      ? ({
                          '--photo-aspect': `${photo.width} / ${photo.height}`,
                        } as React.CSSProperties)
                      : ({
                          '--photo-width': `${tile.widthPx}px`,
                          '--photo-height': `${tile.heightPx}px`,
                        } as React.CSSProperties)
                  }
                >
                  <button
                    className="photo-tap"
                    type="button"
                    aria-label={`查看第 ${photo.rank} 名照片原图`}
                  >
                    <div className="photo-media">
                      <img
                        src={photo.preview1200Url}
                        alt={photo.title}
                        loading={rowIndex === 0 ? 'eager' : 'lazy'}
                        decoding="async"
                        width={photo.width}
                        height={photo.height}
                      />
                    </div>
                  </button>

                  <div className="caption-line">
                    <span className="rank-label">{formatRank(photo.rank)}</span>
                    <div className="caption-copy">
                      <div className="caption-title">{photo.title}</div>
                      <div className="caption-author">{photo.uploader}</div>
                    </div>
                    {renderCaption !== undefined ? (
                      renderCaption(photo)
                    ) : (
                      <div className="small-vote">
                        <span className="score count" data-testid={`photo-score-${photo.id}`}>
                          {formatScore(photo.score)}
                        </span>
                        <VoteControls
                          photoId={photo.id}
                          score={photo.score}
                          upCount={photo.upCount}
                          downCount={photo.downCount}
                          currentVote={photo.currentVote}
                          variant="inline"
                          onVoteApplied={onVoteApplied}
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
