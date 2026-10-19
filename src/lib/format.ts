/** Display formatting shared by server and client components. */

/** Scores read as +13, -2, or 0 — never "+0" or "-0". */
export function formatScore(score: number): string {
  if (score > 0) return `+${score}`;
  return String(score);
}

/** Ranks are two digits while they fit, then as many as they need. */
export function formatRank(rank: number): string {
  return String(rank).padStart(2, '0');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

const MIME_LABELS: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
};

export function formatMime(mime: string): string {
  return MIME_LABELS[mime] ?? mime;
}

/** ISO timestamp -> 2026-10-19 18:04 */
export function formatTimestamp(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
