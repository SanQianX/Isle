'use client';

/**
 * One photo, one request -- with progress, and a way out.
 *
 * `fetch` cannot report how much of a request body has been sent, so the
 * upload page could only ever say "上传中…". The plan asks for per-image
 * progress (FRONTEND_UX §3.5, E2E_SCENARIOS UP-05「进度与并发限制可证明」),
 * and a request that never comes back would leave the row spinning forever
 * with no retry button -- on exactly the mobile connections this product is
 * used on.
 *
 * XMLHttpRequest is the only browser API that reports how much of a body has
 * gone out, so it is used here.
 *
 * The watchdog is one timer that watches two different things, because the
 * two phases fail differently:
 *
 *   - while the body is still going out, a pause of `stallTimeoutMs` with no
 *     byte moved means the connection is dead. A slow link is not a stall: a
 *     slow link keeps moving bytes, and every byte resets the clock.
 *   - once the body is fully sent, the server still has to decode the
 *     photograph and render two previews, which legitimately takes a while on
 *     a large file, so a separate and much longer `responseTimeoutMs` applies.
 *
 * One request per photo, exactly as the server contract requires; the caller
 * runs the two-at-a-time pool.
 */

export type UploadOutcome = {
  ok: boolean;
  status: number;
  /** Parsed JSON body when the server sent one, otherwise null. */
  body: { error?: { message?: string } } | null;
  /** True when one of the deadlines cut the request short. */
  timedOut: boolean;
};

export type UploadOptions = {
  url: string;
  form: FormData;
  /** No bytes moved for this long while sending the body. */
  stallTimeoutMs: number;
  /** The body was sent; the server had this long to answer. */
  responseTimeoutMs: number;
  /** Called with 0–100 as the body goes out. */
  onProgress?: (percent: number) => void;
};

/** How often the watchdog looks at the clock. */
const TICK_MS = 500;

export function uploadWithProgress(options: UploadOptions): Promise<UploadOutcome> {
  return new Promise<UploadOutcome>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', options.url, true);
    // The server identifies visitors with a cookie; the request has to carry it.
    xhr.withCredentials = true;

    let settled = false;
    let timedOut = false;
    /** Timestamp of the last byte seen on the way out; 0 means "never moved". */
    let lastUploadActivity = Date.now();
    /** Timestamp the body was handed over; 0 means "still sending". */
    let bodySentAt = 0;

    const finish = (outcome: UploadOutcome): void => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      resolve(outcome);
    };

    const fail = (): void => {
      finish({ ok: false, status: 0, body: null, timedOut });
    };

    /** The connection is dead: cut the request and let the caller retry. */
    const expire = (): void => {
      if (settled) return;
      timedOut = true;
      xhr.abort();
      fail();
    };

    const watchdog = setInterval(() => {
      const now = Date.now();
      if (bodySentAt !== 0) {
        if (now - bodySentAt > options.responseTimeoutMs) expire();
        return;
      }
      if (now - lastUploadActivity > options.stallTimeoutMs) expire();
    }, TICK_MS);

    /** The body is out; from here the server is working, not the network. */
    const markBodySent = (): void => {
      if (bodySentAt !== 0) return;
      bodySentAt = Date.now();
    };

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (event.lengthComputable && event.total > 0) {
        const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
        options.onProgress?.(percent);
        if (event.loaded >= event.total) markBodySent();
      }
      // Any movement at all means the connection is alive.
      lastUploadActivity = Date.now();
    };

    xhr.upload.onload = markBodySent;

    xhr.upload.onerror = fail;

    xhr.onprogress = () => {
      // Response bytes are arriving, so the body is obviously out.
      markBodySent();
    };

    xhr.onreadystatechange = () => {
      // HEADERS_RECEIVED means the server started answering, which also means
      // the body was sent -- even in an engine that never fires upload.onload.
      if (xhr.readyState >= 2) markBodySent();
    };

    xhr.onload = () => {
      markBodySent();
      let body: { error?: { message?: string } } | null = null;
      try {
        body = JSON.parse(xhr.responseText) as { error?: { message?: string } };
      } catch {
        body = null;
      }
      finish({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        body,
        timedOut: false,
      });
    };

    xhr.onerror = fail;
    xhr.onabort = fail;

    xhr.send(options.form);
  });
}
