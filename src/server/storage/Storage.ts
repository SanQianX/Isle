import type { Readable } from 'node:stream';

/**
 * Storage boundary (DATA_API_STORAGE §4.3).
 *
 * Keys are opaque, server-generated strings such as
 * `original/ab/6f1c....jpg`. Nothing derived from user input ever reaches the
 * filesystem — the key is minted by the server and validated on the way back
 * out, which is what keeps `../../etc/passwd` from ever being a path.
 *
 * Implementations must be immutable: `putOriginal` on an existing key is a
 * programming error, not an update.
 */

export type StoredObject = {
  byteLength: number;
  sha256: string;
};

export type RangeSpec = {
  start: number;
  /** Inclusive. Omit for "to the end of the file". */
  end?: number;
};

export interface Storage {
  /**
   * Stream bytes to an immutable key. Computes SHA-256 and the byte count as the
   * data flows through, so a 25 MiB upload is never re-read to hash it.
   */
  putOriginal(key: string, source: AsyncIterable<Uint8Array>): Promise<StoredObject>;

  /** Write a derivative. Derivatives are rebuildable, so this may replace. */
  putDerivative(key: string, bytes: Uint8Array): Promise<void>;

  /** Open a read stream, optionally limited to a byte range. */
  openReadStream(key: string, range?: RangeSpec): Promise<{ stream: Readable; size: number }>;

  stat(key: string): Promise<{ size: number }>;

  /** Delete a temporary upload. Missing keys are not an error. */
  removeTemporary(key: string): Promise<void>;

  /**
   * Delete a stored object. Only used by the moderation CLI and by rollback of
   * a failed ingestion — never by ordinary business logic, because originals are
   * archived permanently.
   */
  remove(key: string): Promise<void>;

  /** Absolute path, for diagnostics and the reconciler only. Never in a response. */
  absolutePath(key: string): string;
}

/** Keys are generated, not user data. Anything else is a bug or an attack. */
const SAFE_KEY = /^(original|preview\/(400|1200))\/[0-9a-f]{2}\/[0-9a-f]{16,64}\.[a-z0-9]{1,5}$/;

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key)) {
    throw new Error(`Unsafe storage key rejected: ${JSON.stringify(key)}`);
  }
}
