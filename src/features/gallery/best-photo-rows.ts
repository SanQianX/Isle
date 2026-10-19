/**
 * Justified gallery layout.
 *
 * Ported from `bestPhotoRows()` in the V4.1 prototype
 * (docs/plans/ISLE_V1_Production_PlanPack/00-reference/V4.1_REFERENCE_ONLY.html).
 *
 * The goal is a wall where every photo in a row shares one height and each tile
 * is exactly as wide as its own aspect ratio demands — so nothing is cropped,
 * stretched, or reordered, and the page has no awkward holes.
 *
 * This is a dynamic program, not a greedy fill. Greedy would let the first row
 * swallow five photos and strand a lone portrait on the last row; the DP
 * evaluates every partition and picks the cheapest overall.
 *
 * The single most important property, and the one the unit tests pin hardest:
 * **input order is output order.** Ranking is a hard constraint, so a layout
 * that shuffled photos to look tidier would be wrong, however pretty.
 */

export type LayoutInput = {
  id: string;
  width: number;
  height: number;
};

export type LayoutTile = {
  id: string;
  widthPx: number;
  heightPx: number;
  /** Index within the whole input, so the caller can recover rank. */
  index: number;
};

export type LayoutRow = {
  heightPx: number;
  tiles: LayoutTile[];
  /** True for the final row, which the CSS centres rather than stretching. */
  isLast: boolean;
  /** Unused horizontal space, in CSS pixels. */
  slackPx: number;
};

export type LayoutOptions = {
  /** Horizontal gutter between tiles. Mirrors --gallery-gap. */
  gap?: number;
  /** Row height the optimiser aims for. */
  targetHeight?: number;
  /** Hard ceiling; a row never gets taller than this. */
  maxHeight?: number;
  /** Below this a row looks squashed, so it is penalised. */
  minHeight?: number;
  /** Most photos allowed in one row. */
  maxPerRow?: number;
  /** Narrowest acceptable tile before the layout degrades. */
  minTileWidth?: number;
};

const DEFAULTS: Required<LayoutOptions> = {
  gap: 22,
  targetHeight: 335,
  maxHeight: 440,
  minHeight: 220,
  maxPerRow: 5,
  minTileWidth: 152,
};

/** Aspect ratio of a photo, falling back to a landscape default for bad data. */
export function photoRatio(photo: LayoutInput): number {
  const width = Number(photo.width);
  const height = Number(photo.height);
  return width > 0 && height > 0 ? width / height : 1.4;
}

/**
 * Partition `items` into equal-height rows that fill the container width.
 *
 * Pure: same inputs always give the same layout, and the input array is never
 * mutated.
 */
export function bestPhotoRows(
  items: readonly LayoutInput[],
  containerWidth: number,
  options: LayoutOptions = {},
): LayoutRow[] {
  const { gap, targetHeight, maxHeight, minHeight, maxPerRow, minTileWidth } = {
    ...DEFAULTS,
    ...options,
  };

  const n = items.length;
  if (n === 0) return [];
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return [];

  const ratios = items.map(photoRatio);

  // cost[i] = cheapest total penalty for laying out items[i..n-1].
  const cost: number[] = new Array(n + 1).fill(Number.POSITIVE_INFINITY);
  const choice: Array<{ count: number; height: number } | null> = new Array(n).fill(null);
  cost[n] = 0;

  for (let i = n - 1; i >= 0; i -= 1) {
    let sumRatios = 0;

    for (let k = 1; k <= Math.min(maxPerRow, n - i); k += 1) {
      sumRatios += ratios[i + k - 1] as number;

      // Height that would exactly fill the row.
      const raw = (containerWidth - gap * (k - 1)) / sumRatios;
      if (raw <= 0) continue;

      const height = Math.min(raw, maxHeight);
      const isLastRow = i + k === n;
      const empty = containerWidth - (sumRatios * height + gap * (k - 1));

      // Distance from the target height, squared, so deviations are cheap near
      // the target and expensive far from it.
      let penalty = ((height - targetHeight) / targetHeight) ** 2;

      // A row that comes out too short looks squashed.
      if (raw < minHeight) {
        penalty += 2 * ((minHeight - raw) / minHeight) ** 2;
      }

      // A non-final row that leaves a hole is the thing we most want to avoid.
      if (!isLastRow && empty > 2) {
        penalty += 2 * (empty / containerWidth) ** 2;
      }

      // A single photo on a non-final row is almost always a mistake.
      if (k === 1 && n > 1) penalty += 1.4;
      // A lone photo as the final row is tolerable, just not ideal.
      if (isLastRow && k === 1 && n > 1) penalty += 0.5;

      // A barely-filled final row is fine; an almost-empty one is not.
      if (isLastRow && empty > gap && k > 1) {
        penalty += 0.16 * (empty / containerWidth) ** 2;
      }

      // A very tall photo squeezed into a narrow tile is unreadable, so make it
      // expensive rather than allowing the tile to collapse.
      let narrowest = Number.POSITIVE_INFINITY;
      for (let j = i; j < i + k; j += 1) {
        narrowest = Math.min(narrowest, (ratios[j] as number) * height);
      }
      if (narrowest < minTileWidth) {
        penalty += 3 * ((minTileWidth - narrowest) / minTileWidth) ** 2;
      }

      const total = penalty + (cost[i + k] as number);
      if (total < (cost[i] as number)) {
        cost[i] = total;
        choice[i] = { count: k, height };
      }
    }
  }

  // Walk the chosen partition back into rows.
  const rows: LayoutRow[] = [];
  let index = 0;
  while (index < n) {
    const step = choice[index] ?? { count: 1, height: targetHeight };
    const height = step.height;
    const tiles: LayoutTile[] = [];

    for (let j = 0; j < step.count; j += 1) {
      const photo = items[index + j] as LayoutInput;
      tiles.push({
        id: photo.id,
        // Width follows from the photo's own ratio, so nothing is distorted.
        widthPx: photoRatio(photo) * height,
        heightPx: height,
        index: index + j,
      });
    }

    const used = tiles.reduce((sum, tile) => sum + tile.widthPx, 0) + gap * (tiles.length - 1);
    rows.push({
      heightPx: height,
      tiles,
      isLast: index + step.count >= n,
      slackPx: Math.max(0, containerWidth - used),
    });

    index += step.count;
  }

  return rows;
}

/**
 * Single-column layout for narrow viewports.
 *
 * The prototype skips the DP entirely below 760px and stacks each photo at its
 * own ratio, which is the right call: a justified row on a 360px screen forces
 * tiles so narrow that a portrait becomes unreadable.
 */
export function singleColumnRows(
  items: readonly LayoutInput[],
  containerWidth: number,
): LayoutRow[] {
  return items.map((photo, index) => {
    const ratio = photoRatio(photo);
    const heightPx = ratio > 0 ? containerWidth / ratio : containerWidth;
    return {
      heightPx,
      tiles: [{ id: photo.id, widthPx: containerWidth, heightPx, index }],
      isLast: index === items.length - 1,
      slackPx: 0,
    };
  });
}

/** The breakpoint at which the justified wall collapses to one column. */
export const SINGLE_COLUMN_MAX_WIDTH = 760;

/** Below this container width, stacking is the only readable option. */
export function shouldStack(containerWidth: number): boolean {
  return containerWidth <= SINGLE_COLUMN_MAX_WIDTH;
}
