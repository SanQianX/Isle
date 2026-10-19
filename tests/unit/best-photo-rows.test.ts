import { describe, expect, it } from 'vitest';
import {
  bestPhotoRows,
  photoRatio,
  shouldStack,
  singleColumnRows,
  type LayoutInput,
} from '@/features/gallery/best-photo-rows';

/**
 * Justified gallery invariants (FRONTEND_UX §4.2).
 *
 * A layout algorithm that passes "looks fine" can still crop a photo, drop one
 * off the end, or quietly reorder the leaderboard. Every test below asserts a
 * property that must hold for *any* input, not a specific pixel arrangement.
 */

function photos(...specs: Array<[string, number, number]>): LayoutInput[] {
  return specs.map(([id, width, height]) => ({ id, width, height }));
}

function flatten(rows: ReturnType<typeof bestPhotoRows>): string[] {
  return rows.flatMap((row) => row.tiles.map((tile) => tile.id));
}

/** Build n photos cycling through a set of aspect ratios. */
function manyPhotos(
  count: number,
  ratios: Array<[number, number]> = [
    [1600, 900],
    [900, 1600],
    [1000, 1000],
    [2400, 480],
    [480, 2400],
  ],
): LayoutInput[] {
  return Array.from({ length: count }, (_, index) => {
    const [width, height] = ratios[index % ratios.length] as [number, number];
    return { id: `p${index}`, width, height };
  });
}

describe('photoRatio', () => {
  it('is width over height', () => {
    expect(photoRatio({ id: 'a', width: 1600, height: 900 })).toBeCloseTo(16 / 9);
    expect(photoRatio({ id: 'a', width: 900, height: 1600 })).toBeCloseTo(9 / 16);
  });

  it('falls back to a landscape default for zero or invalid dimensions', () => {
    // Broken metadata must not produce Infinity or NaN widths.
    expect(photoRatio({ id: 'a', width: 0, height: 100 })).toBe(1.4);
    expect(photoRatio({ id: 'a', width: 100, height: 0 })).toBe(1.4);
    expect(photoRatio({ id: 'a', width: Number.NaN, height: 100 })).toBe(1.4);
  });
});

describe('bestPhotoRows ordering invariants', () => {
  it('preserves input order exactly, for every count', () => {
    for (const count of [0, 1, 2, 3, 4, 5, 7, 20, 50, 100]) {
      const input = manyPhotos(count);
      const rows = bestPhotoRows(input, 1280);
      expect(flatten(rows), `count=${count}`).toEqual(input.map((photo) => photo.id));
    }
  });

  it('never drops or duplicates a photo', () => {
    for (const width of [320, 768, 1024, 1440, 1920]) {
      for (const count of [1, 2, 3, 5, 8, 13, 21, 40]) {
        const input = manyPhotos(count);
        const ids = flatten(bestPhotoRows(input, width));
        expect(new Set(ids).size, `w=${width} n=${count}`).toBe(count);
      }
    }
  });

  it('handles extreme aspect ratios without losing a photo', () => {
    const extreme = photos(
      ['panorama', 8000, 400],
      ['needle', 300, 6000],
      ['square', 1000, 1000],
      ['letterbox', 4000, 500],
    );
    const rows = bestPhotoRows(extreme, 1280);
    expect(flatten(rows)).toEqual(['panorama', 'needle', 'square', 'letterbox']);
    for (const tile of rows.flatMap((row) => row.tiles)) {
      expect(tile.widthPx).toBeGreaterThan(0);
      expect(Number.isFinite(tile.widthPx)).toBe(true);
    }
  });
});

describe('bestPhotoRows geometry invariants', () => {
  const containerWidth = 1280;

  it('gives every tile in a row the same height', () => {
    const rows = bestPhotoRows(manyPhotos(12), containerWidth);
    for (const row of rows) {
      const heights = new Set(row.tiles.map((tile) => tile.heightPx));
      expect(heights.size, 'tiles in a row must share one height').toBe(1);
    }
  });

  it("keeps each tile at the photo's true aspect ratio, so nothing is stretched", () => {
    const input = manyPhotos(14);
    const byId = new Map(input.map((photo) => [photo.id, photo]));
    for (const tile of bestPhotoRows(input, containerWidth).flatMap((row) => row.tiles)) {
      const source = byId.get(tile.id) as LayoutInput;
      expect(tile.widthPx / tile.heightPx, tile.id).toBeCloseTo(source.width / source.height, 6);
    }
  });

  it('never exceeds the container width', () => {
    for (const width of [320, 500, 768, 1024, 1440, 1920]) {
      for (const count of [2, 3, 5, 9, 17, 30]) {
        for (const row of bestPhotoRows(manyPhotos(count), width)) {
          const used =
            row.tiles.reduce((sum, tile) => sum + tile.widthPx, 0) + 22 * (row.tiles.length - 1);
          // 1px tolerance for floating point accumulation.
          expect(used, `w=${width} n=${count}`).toBeLessThanOrEqual(width + 1);
        }
      }
    }
  });

  it('respects the maximum row height and the per-row photo cap', () => {
    for (const row of bestPhotoRows(manyPhotos(30), containerWidth)) {
      expect(row.heightPx).toBeLessThanOrEqual(440 + 1e-6);
      expect(row.tiles.length).toBeLessThanOrEqual(5);
    }
  });

  it('either fills a non-final row or pins it at the maximum height', () => {
    // Unused width is only acceptable when the row is already at the height
    // ceiling and physically cannot grow. Any other slack means the partition
    // was poor. This is the precise form of the "no big hole" rule: a loose
    // percentage threshold would either pass a genuinely bad layout or fail a
    // correctly capped one.
    for (const width of [768, 1024, 1440, 1920]) {
      for (const count of [6, 9, 12, 18, 25]) {
        for (const row of bestPhotoRows(manyPhotos(count), width).slice(0, -1)) {
          const atCeiling = row.heightPx >= 440 - 1e-6;
          const fillsWidth = row.slackPx <= 1;
          expect(
            atCeiling || fillsWidth,
            `width=${width} count=${count} row slack=${row.slackPx.toFixed(1)} height=${row.heightPx.toFixed(1)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('marks exactly the final row as last', () => {
    const rows = bestPhotoRows(manyPhotos(9), containerWidth);
    expect(rows[rows.length - 1]?.isLast).toBe(true);
    for (const row of rows.slice(0, -1)) {
      expect(row.isLast).toBe(false);
    }
  });
});

describe('bestPhotoRows robustness', () => {
  it('returns nothing for an empty list', () => {
    expect(bestPhotoRows([], 1280)).toEqual([]);
  });

  it('returns nothing for a non-positive container width', () => {
    expect(bestPhotoRows(manyPhotos(3), 0)).toEqual([]);
    expect(bestPhotoRows(manyPhotos(3), -100)).toEqual([]);
    expect(bestPhotoRows(manyPhotos(3), Number.NaN)).toEqual([]);
  });

  it('still lays out photos whose dimensions are missing', () => {
    const broken = photos(['a', 0, 0], ['b', 1600, 900], ['c', 0, 0]);
    const rows = bestPhotoRows(broken, 1280);
    expect(flatten(rows)).toEqual(['a', 'b', 'c']);
    for (const tile of rows.flatMap((row) => row.tiles)) {
      expect(Number.isFinite(tile.widthPx)).toBe(true);
      expect(tile.widthPx).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    const input = manyPhotos(17);
    const a = bestPhotoRows(input, 1440);
    const b = bestPhotoRows(input, 1440);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate its input', () => {
    const input = manyPhotos(8);
    const before = JSON.stringify(input);
    bestPhotoRows(input, 1280);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('lays out a single photo at full width', () => {
    const rows = bestPhotoRows(photos(['only', 1600, 900]), 1280);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isLast).toBe(true);
    expect(rows[0]?.tiles).toHaveLength(1);
  });
});

describe('single column layout', () => {
  it('gives every photo the full width at its own ratio', () => {
    const input = photos(['land', 1600, 900], ['port', 900, 1600], ['sq', 1000, 1000]);
    const rows = singleColumnRows(input, 360);

    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.entries()) {
      expect(row.tiles[0]?.widthPx).toBe(360);
      const source = input[index] as LayoutInput;
      expect(row.heightPx).toBeCloseTo(360 / (source.width / source.height), 6);
    }
  });

  it('never crops: the tile always matches the photo', () => {
    const rows = singleColumnRows(manyPhotos(6), 320);
    expect(flatten(rows)).toEqual(manyPhotos(6).map((photo) => photo.id));
  });
});

describe('shouldStack', () => {
  it('stacks at and below 760px, matching the prototype breakpoint', () => {
    expect(shouldStack(320)).toBe(true);
    expect(shouldStack(760)).toBe(true);
    expect(shouldStack(761)).toBe(false);
    expect(shouldStack(1440)).toBe(false);
  });
});
