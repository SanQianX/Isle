import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { getConfig } from '@/lib/config';
import { assertSafeKey, type RangeSpec, type Storage, type StoredObject } from './Storage';

/**
 * Disk-backed Storage.
 *
 * Layout (DATA_API_STORAGE §4.3):
 *   MEDIA_ROOT/original/<ab>/<opaque-id>.<ext>
 *   MEDIA_ROOT/preview/400/<ab>/<opaque-id>.webp
 *   MEDIA_ROOT/preview/1200/<ab>/<opaque-id>.webp
 *
 * `<ab>` is the first two hex characters of the object's own SHA-256. It is
 * derived from the content, so keys stay stable across restores and the two
 * leading characters spread directories evenly.
 *
 * Durability: write to a temp file in the same directory, fsync the file, then
 * rename into place. Rename within a filesystem is atomic, so a reader never
 * sees a half-written original and a crash never leaves a partial file under a
 * live key.
 */

const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function extensionForMime(mime: string): string {
  const extension = MIME_EXTENSION[mime];
  if (extension === undefined) {
    throw new Error(`No storage extension for mime type ${mime}`);
  }
  return extension;
}

export type StorageRoots = {
  originalDir: string;
  previewRoot: string;
  uploadTmpDir: string;
};

export class DiskStorage implements Storage {
  private readonly originalDir: string;
  private readonly previewRoot: string;
  private readonly uploadTmpDir: string;

  constructor(roots: StorageRoots) {
    this.originalDir = roots.originalDir;
    this.previewRoot = roots.previewRoot;
    this.uploadTmpDir = roots.uploadTmpDir;
  }

  /** Public read-only view of the roots, for tests and the storage reconciler. */
  get roots(): Readonly<StorageRoots> {
    return {
      originalDir: this.originalDir,
      previewRoot: this.previewRoot,
      uploadTmpDir: this.uploadTmpDir,
    };
  }

  static fromConfig(): DiskStorage {
    const config = getConfig();
    return new DiskStorage({
      originalDir: config.originalDir,
      previewRoot: config.previewRoot,
      uploadTmpDir: config.uploadTmpDir,
    });
  }

  /** Mint an immutable key for a new original, derived from its own content. */
  static buildOriginalKey(sha256: string, mime: string): string {
    return `original/${sha256.slice(0, 2)}/${sha256}.${extensionForMime(mime)}`;
  }

  static buildPreviewKey(sha256: string, size: number): string {
    return `preview/${size}/${sha256.slice(0, 2)}/${sha256}.webp`;
  }

  absolutePath(key: string): string {
    assertSafeKey(key);
    if (key.startsWith('original/')) {
      return path.join(this.originalDir, key.slice('original/'.length));
    }
    // key is `preview/<size>/<ab>/<sha>.<ext>` and assertSafeKey has already
    // constrained <size> to 400 or 1200 and the rest to hex-safe segments.
    const [, size, ...rest] = key.split('/');
    return path.join(this.previewRoot, size as string, ...rest);
  }

  /** Root directory a key must stay inside. */
  private rootFor(key: string): string {
    return key.startsWith('original/') ? this.originalDir : this.previewRoot;
  }

  private resolve(key: string): string {
    const absolute = this.absolutePath(key);
    const root = this.rootFor(key);
    // Defence in depth: assertSafeKey already makes escape impossible, but the
    // containment check is the actual guarantee and costs nothing.
    if (!absolute.startsWith(root + path.sep)) {
      throw new Error(`Storage key escaped its root: ${key}`);
    }
    return absolute;
  }

  /**
   * Write bytes durably: temp file in the same directory, fsync, then link into
   * place. `link` rather than `rename`, because link fails with EEXIST instead
   * of silently clobbering an archived original.
   *
   * `onExists` decides what an EEXIST means to the caller.
   */
  private async writeDurable(
    target: string,
    produce: (handle: fs.promises.FileHandle) => Promise<void>,
    options:
      | { mode: 'replace' }
      | {
          mode: 'immutable';
          onExists: (error: NodeJS.ErrnoException) => Promise<'reused' | 'failed'>;
        },
  ): Promise<'written' | 'reused'> {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomBytes(8).toString('hex')}.part`;

    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      await produce(handle);
      await handle.sync();
      await handle.close();
      handle = undefined;

      if (options.mode === 'replace') {
        // Derivatives are rebuildable from the original, so replacing one is
        // correct. rename is atomic within a filesystem and overwrites.
        await fs.promises.rename(temporary, target);
        await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
        return 'written';
      }

      try {
        // link rather than rename: it fails with EEXIST instead of silently
        // clobbering an archived original.
        await fs.promises.link(temporary, target);
      } catch (error) {
        const decision =
          options.mode === 'immutable'
            ? await options.onExists(error as NodeJS.ErrnoException)
            : 'failed';
        if (decision === 'reused') {
          await fs.promises.rm(temporary, { force: true });
          return 'reused';
        }
        throw error;
      }
      await fs.promises.rm(temporary, { force: true });
      return 'written';
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** SHA-256 of a file already on disk, used to confirm an existing blob. */
  private async hashFile(target: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(target)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }

  async putOriginal(key: string, source: AsyncIterable<Uint8Array>): Promise<StoredObject> {
    const target = this.resolve(key);
    const hash = createHash('sha256');
    let byteLength = 0;

    const outcome = await this.writeDurable(
      target,
      async (handle) => {
        for await (const chunk of source) {
          byteLength += chunk.byteLength;
          hash.update(chunk);
          await handle.write(chunk);
        }
        if (byteLength === 0) {
          throw new Error('Refusing to store an empty original');
        }
      },
      {
        mode: 'immutable',
        onExists: async (error) => {
          if (error.code !== 'EEXIST') return 'failed';

          // Keys are content-addressed, so an existing key normally means these
          // exact bytes are already archived. Re-uploading the same photo -- by
          // two visitors, or under a second idempotency key -- must reuse the
          // blob rather than fail. Verify before trusting that, so a forged key
          // still cannot overwrite anything.
          const incomingHash = hash.copy().digest('hex');
          const existingHash = await this.hashFile(target);
          if (existingHash !== incomingHash) {
            throw new Error(
              `Storage key ${key} already holds different content ` +
                `(${existingHash} != ${incomingHash}); refusing to overwrite.`,
            );
          }
          return 'reused';
        },
      },
    );

    if (outcome === 'reused') {
      // Length comes from the file that was just verified, not from the stream.
      const stats = await fs.promises.stat(target);
      return { byteLength: stats.size, sha256: hash.digest('hex') };
    }

    return { byteLength, sha256: hash.digest('hex') };
  }

  async putDerivative(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.resolve(key);
    await this.writeDurable(
      target,
      async (handle) => {
        await handle.write(bytes);
      },
      { mode: 'replace' },
    );
  }

  async openReadStream(
    key: string,
    range?: RangeSpec,
  ): Promise<{ stream: Readable; size: number }> {
    const target = this.resolve(key);
    const stats = await fs.promises.stat(target);

    if (range === undefined) {
      return { stream: fs.createReadStream(target), size: stats.size };
    }

    const end = range.end === undefined ? stats.size - 1 : Math.min(range.end, stats.size - 1);
    return {
      stream: fs.createReadStream(target, { start: range.start, end }),
      size: Math.max(0, end - range.start + 1),
    };
  }

  async stat(key: string): Promise<{ size: number }> {
    const stats = await fs.promises.stat(this.resolve(key));
    return { size: stats.size };
  }

  async removeTemporary(key: string): Promise<void> {
    // Temporary keys are bare filenames inside the upload scratch directory.
    if (key.includes('/') || key.includes('\\') || key.length === 0) {
      throw new Error(`Unsafe temporary key: ${JSON.stringify(key)}`);
    }
    await fs.promises.rm(path.join(this.uploadTmpDir, key), { force: true });
  }

  async remove(key: string): Promise<void> {
    await fs.promises.rm(this.resolve(key), { force: true });
  }
}

/** Present a buffer as a one-chunk async iterable, for tests and the seeder. */
export function streamFromBuffer(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* generate() {
    yield bytes;
  })();
}

/** Present a list of chunks as an async iterable, for tests that stream in pieces. */
export function streamFromChunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  })();
}

/** Drain a read stream into a single Buffer. Used by tests asserting byte equality. */
export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}
