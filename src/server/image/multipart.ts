import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import Busboy from 'busboy';
import { ApiError } from '@/lib/errors';
import { getConfig } from '@/lib/config';

/**
 * Bounded streaming multipart parser (DATA_API_STORAGE §4.2 step 2, ADR-004).
 *
 * `await request.formData()` buffers the whole upload in memory before any check
 * runs, so a nominal 25 MiB cap would still let a hostile client push gigabytes
 * and take the process out. Here the file part is streamed straight to a temp
 * file while its SHA-256 is computed, the running byte total is checked on every
 * chunk, and the request is aborted the moment it crosses the limit.
 */

const HEADER_PREFIX_BYTES = 32;
const MAX_FIELD_BYTES = 8 * 1024;
const MAX_FIELDS = 12;

export type StreamedFile = {
  fieldName: string;
  /** Server-generated temp name. The client's filename never becomes a path. */
  tempKey: string;
  tempPath: string;
  declaredFileName: string;
  declaredMime: string | undefined;
  byteLength: number;
  sha256: string;
  /** Leading bytes, enough for magic-byte sniffing. */
  head: Buffer;
};

export type ParsedUpload = {
  fields: Record<string, string>;
  file: StreamedFile;
};

export type ParseOptions = {
  maxBytes: number;
  maxFiles: number;
  /** Invoked as soon as the temp path is known, so failures can clean it up. */
  onFileCreated?: (tempPath: string) => void;
};

/**
 * Parse exactly one file part plus its scalar fields.
 *
 * Anything else is rejected: the contract is one request per photo, with the
 * client batching by issuing several concurrent requests (DATA_API_STORAGE §3).
 */
export async function parseSingleFileUpload(
  request: Request,
  options: ParseOptions,
): Promise<ParsedUpload> {
  const config = getConfig();

  if (request.headers.get('content-type') === null) {
    throw ApiError.badRequest('请求缺少 Content-Type');
  }
  if (request.body === null) {
    throw ApiError.badRequest('请求没有内容');
  }

  // Reject on the declared length before reading a byte. The slack covers
  // multipart framing so a legal 25 MiB file is not refused.
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes + 1024 * 1024) {
    throw ApiError.tooLarge('单张照片不得超过 25 MiB');
  }

  await fs.mkdir(config.uploadTmpDir, { recursive: true });

  return new Promise<ParsedUpload>((resolve, reject) => {
    const fields: Record<string, string> = {};
    let tempPath: string | undefined;
    let settled = false;
    /** The write stream for the current file part, once one has been opened. */
    let sinkRef: ReturnType<typeof createWriteStream> | undefined;
    /** True once busboy has announced a file part. */
    let sawFilePart = false;

    /** Resolves when the file part has been fully written to disk. */
    let fileReady: (() => void) | undefined;
    const fileComplete = new Promise<void>((r) => {
      fileReady = r;
    });
    // Settled by the sink 'finish' handler, read by busboy 'close'. Held in a
    // box so TypeScript can see the write in the callback it actually happens in.
    const fileBox: { value: StreamedFile | undefined } = { value: undefined };

    /**
     * Remove the scratch file, closing the descriptor first.
     *
     * The order is the whole point. An open file cannot be unlinked on Windows
     * (EPERM), and on every platform the descriptor is only released once the
     * last reference to it goes away -- so deleting first and closing later
     * leaks the descriptor even when the unlink succeeds. Destroying the
     * stream and waiting for 'close' makes the removal deterministic instead
     * of a race against the write stream's own teardown.
     */
    const cleanup = async (): Promise<void> => {
      if (sinkRef !== undefined) {
        const target = sinkRef;
        const closed = new Promise<void>((resolveClosed) => {
          if (target.closed) {
            resolveClosed();
            return;
          }
          target.once('close', () => resolveClosed());
        });
        target.destroy();
        await closed;
        sinkRef = undefined;
      }
      if (tempPath !== undefined) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        tempPath = undefined;
      }
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      void cleanup()
        .catch(() => undefined)
        .then(() => {
          fileReady?.();
          reject(error instanceof ApiError ? error : ApiError.badRequest('上传内容无法解析'));
        });
    };

    let busboy: ReturnType<typeof Busboy>;
    try {
      busboy = Busboy({
        headers: Object.fromEntries(request.headers.entries()),
        limits: {
          files: Math.max(1, options.maxFiles),
          fields: MAX_FIELDS,
          fieldSize: MAX_FIELD_BYTES,
          fileSize: options.maxBytes,
        },
      });
    } catch {
      fail(ApiError.badRequest('不是有效的 multipart 请求'));
      return;
    }

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('filesLimit', () => fail(ApiError.badRequest('一次只能上传一张照片')));

    busboy.on('file', (fieldName, stream, info) => {
      if (settled) {
        stream.resume();
        return;
      }
      sawFilePart = true;
      if (fileBox.value !== undefined) {
        // A second part means the client is not honouring one-photo-per-request.
        stream.resume();
        fail(ApiError.badRequest('一次只能上传一张照片'));
        return;
      }

      const hash = createHash('sha256');
      const headChunks: Buffer[] = [];
      let headLength = 0;
      let byteLength = 0;

      // Never a path derived from client input: random name, fixed directory.
      const tempKey = `${randomBytes(16).toString('hex')}.upload`;
      const fileTempPath = path.join(config.uploadTmpDir, tempKey);
      // Tracked separately so the failure path can remove it.
      tempPath = fileTempPath;
      options.onFileCreated?.(fileTempPath);

      const sink = createWriteStream(fileTempPath, { flags: 'wx', mode: 0o600 });
      // Registered so the failure path can close the descriptor before the
      // scratch file is removed.
      sinkRef = sink;

      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        byteLength += chunk.byteLength;

        // busboy also enforces `fileSize`, but checking the running total means
        // a lying Content-Length cannot get past the cap either.
        if (byteLength > options.maxBytes) {
          stream.unpipe?.(sink);
          fail(ApiError.tooLarge('单张照片不得超过 25 MiB'));
          return;
        }

        hash.update(chunk);
        if (headLength < HEADER_PREFIX_BYTES) {
          const slice = chunk.subarray(0, HEADER_PREFIX_BYTES - headLength);
          headChunks.push(slice);
          headLength += slice.byteLength;
        }

        if (!sink.write(chunk)) {
          stream.pause();
          sink.once('drain', () => stream.resume());
        }
      });

      stream.on('limit', () => fail(ApiError.tooLarge('单张照片不得超过 25 MiB')));
      stream.on('error', () => fail(ApiError.badRequest('上传流中断')));
      stream.on('end', () => sink.end());

      sink.on('error', () => fail(ApiError.storageUnavailable()));

      sink.on('finish', () => {
        if (settled) return;
        if (byteLength === 0) {
          fail(ApiError.invalidImage('文件是空的'));
          return;
        }
        fileBox.value = {
          fieldName,
          tempKey,
          tempPath: fileTempPath,
          declaredFileName: info.filename ?? '',
          declaredMime: info.mimeType || undefined,
          byteLength,
          sha256: hash.digest('hex'),
          head: Buffer.concat(headChunks),
        };
        fileReady?.();
      });
    });

    busboy.on('error', () => fail(ApiError.badRequest('上传内容无法解析')));

    busboy.on('close', () => {
      if (settled) return;
      if (!sawFilePart) {
        // The body carried fields but no file. Waiting for a file part that
        // will never arrive would hold the request open forever, so refuse
        // now -- the client sent something we cannot ingest.
        fail(ApiError.badRequest('没有收到照片文件'));
        return;
      }
      // The file part may still be flushing to disk; wait for it before
      // reporting success, otherwise the caller would read a partial file.
      void fileComplete.then(() => {
        if (settled) return;
        const file = fileBox.value;
        if (file === undefined) {
          fail(ApiError.badRequest('没有收到照片文件'));
          return;
        }
        settled = true;
        resolve({ fields, file });
      });
    });

    void (async () => {
      const reader = (request.body as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (settled) {
            await reader.cancel().catch(() => undefined);
            break;
          }
          busboy.write(value);
        }
      } catch {
        fail(ApiError.badRequest('上传流中断'));
        return;
      }
      if (!settled) busboy.end();
    })();
  });
}
