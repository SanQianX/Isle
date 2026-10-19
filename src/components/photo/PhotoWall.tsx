'use client';

import { useEffect, useRef, useState } from 'react';
import {
  bestPhotoRows,
  shouldStack,
  singleColumnRows,
  type LayoutInput,
  type LayoutRow,
} from '@/features/gallery/best-photo-rows';

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

export type WallPhoto = LayoutInput & {
  rank: number;
  title: string;
  description: string;
  uploader: string;
  score: number;
  upCount: number;
  downCount: number;
  preview1200Url: string;
  preview400Url: string;
};

type PhotoWallProps = {
  photos: WallPhoto[];
  /** Renders the caption and vote controls under each tile. */
  renderCaption?: (photo: WallPhoto) => React.ReactNode;
};

const FALLBACK_WIDTH = 1280;

export function PhotoWall({ photos, renderCaption }: PhotoWallProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (node === null) return;

    const measure = () => {
      const rect = node.getBoundingClientRect();
      const padding = Number.parseFloat(getComputedStyle(node).paddingLeft) || 0;
      const paddingRight = Number.parseFloat(getComputedStyle(node).paddingRight) || 0;
      const usable = rect.width - padding - paddingRight;
      if (usable > 0) setContainerWidth(usable);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Render the single-column stack immediately on a phone so the first paint is
  // already correct; the observer refines it once the width is known.
  const effectiveWidth = containerWidth ?? (shouldStack(760) ? 360 : FALLBACK_WIDTH);

  const rows: LayoutRow[] =
    photos.length === 0
      ? []
      : shouldStack(effectiveWidth)
        ? singleColumnRows(photos, effectiveWidth)
        : bestPhotoRows(photos, effectiveWidth);

  if (photos.length === 0) return <div className="photo-grid" ref={containerRef} />;

  return (
    <div className="photo-grid" ref={containerRef} data-testid="photo-wall">
      {rows.map((row, rowIndex) => (
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
                  shouldStack(effectiveWidth)
                    ? ({ '--photo-aspect': `${photo.width} / ${photo.height}` } as React.CSSProperties)
                    : ({
                        '--photo-width': `${tile.widthPx}px`,
                        '--photo-height': `${tile.heightPx}px`,
                      } as React.CSSProperties)
                }
              >
                <button className="photo-tap" type="button" aria-label={`查看第 ${photo.rank} 名照片原图`}>
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
                  <span className="rank-label">{String(photo.rank).padStart(2, '0')}</span>
                  <div className="caption-copy">
                    <div className="caption-title">{photo.title}</div>
                    <div className="caption-author">{photo.uploader}</div>
                  </div>
                  {renderCaption?.(photo)}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
