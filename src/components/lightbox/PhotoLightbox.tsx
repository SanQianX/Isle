'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { VoteControls } from '@/components/photo/VoteControls';
import { formatBytes, formatMime, formatScore, formatTimestamp } from '@/lib/format';

/**
 * Original-quality photo viewer.
 *
 * The whole point of this screen is that it shows the *uploaded file*, not a
 * thumbnail pretending to be one. So:
 *
 *   - the <img> src is always /original, never a preview,
 *   - a failure shows a retry, and never silently substitutes a preview,
 *   - "1:1" means one image pixel per one CSS pixel (devicePixelRatio
 *     accounted for), which is the only honest definition of 1:1.
 *
 * Keyboard: Escape closes, arrows move, and focus returns to the thumbnail
 * that opened it. History is wired to ?photo=<id> so a link can be shared and
 * the browser Back button closes the viewer rather than leaving the page.
 */

export type LightboxItem = {
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
  preview1200Url: string;
  preview400Url: string;
  originalUrl: string;
  downloadUrl: string;
};

type Props = {
  items: LightboxItem[];
  activeId: string | null;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onVoteApplied?: (result: {
    photoId: string;
    score: number;
    upCount: number;
    downCount: number;
    currentVisitorVote: number;
    rankingMayHaveChanged: boolean;
  }) => void;
};

/** Below this the natural pixel size is smaller than the viewport. */
const MAX_FIT_HEIGHT = 620;

/**
 * Elements a keyboard user can reach with Tab.
 *
 * Visibility is checked rather than assumed: the details panel starts
 * collapsed, and tabbing into a collapsed panel would move focus somewhere the
 * user cannot see.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.getClientRects().length > 0,
  );
}

export function Lightbox({ items, activeId, onClose, onNavigate, onVoteApplied }: Props) {
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      items.findIndex((item) => item.id === activeId),
    ),
  );
  const [showDetails, setShowDetails] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [loadToken, setLoadToken] = useState(0);
  // Read after mount: `window` does not exist while this renders on the server.
  const [pixelRatio, setPixelRatio] = useState(1);
  const triggerRef = useRef<HTMLElement | null>(null);
  const triggerSelectorRef = useRef<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const active = items[index] ?? null;
  // Open-ness comes from the URL, never from `index`. Deriving it from `active`
  // would make the viewer permanently open, because index 0 is always a valid
  // photo — it would cover the page and swallow every click beneath it.
  const isOpen = activeId !== null && active !== null;

  // Follow the URL when it changes from outside (deep link, back button).
  useEffect(() => {
    if (activeId === null) return;
    const found = items.findIndex((item) => item.id === activeId);
    if (found !== -1) setIndex(found);
  }, [activeId, items]);

  const go = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      // Computed outside the state updater on purpose: a side effect inside an
      // updater runs twice under StrictMode, which would push two history
      // entries per arrow key.
      const next = (index + delta + items.length) % items.length;
      const item = items[next];
      if (item === undefined) return;
      setIndex(next);
      setImageFailed(false);
      setZoom(false);
      onNavigate(item.id);
    },
    // `index` is included so the callback always reads the current position.
    [index, items, onNavigate],
  );

  // Lock background scrolling with a single class rather than also poking
  // body.style. Two sources of truth meant WebKit could be left with the class
  // removed but the inline style still applied (or the reverse).
  useEffect(() => {
    if (!isOpen) return;
    document.body.classList.add('is-scroll-locked');
    return () => {
      document.body.classList.remove('is-scroll-locked');
    };
  }, [isOpen]);

  // Remember what opened the viewer so focus can go back there on close.
  //
  // The stored node can be detached by the time we restore: closing navigates
  // the URL, which re-renders the board and may replace the button element. So
  // the selector is kept alongside it, and a fresh lookup is the fallback.
  useEffect(() => {
    if (isOpen) {
      const active = document.activeElement as HTMLElement | null;
      triggerRef.current = active;
      triggerSelectorRef.current = active?.getAttribute('data-testid') ?? null;
      return;
    }

    const stored = triggerRef.current;
    const selector = triggerSelectorRef.current;
    triggerRef.current = null;
    triggerSelectorRef.current = null;

    const target =
      stored !== null && document.contains(stored)
        ? stored
        : selector === null
          ? null
          : document.querySelector<HTMLElement>(`[data-testid="${selector}"]`);

    if (target === null) return;

    // Focus once now, and once more on the next frame. The close also updates
    // the URL, and some engines (WebKit) still hand focus back to the body
    // after the surrounding re-render commits — a single attempt loses it.
    target.focus({ preventScroll: true });

    // Closing also updates the URL, and the router moves focus to the body when
    // that navigation commits -- undoing the restore above. The exact moment is
    // not observable from here, so retry across a short window and stop as soon
    // as focus sticks. Without this the keyboard user is dropped at the top of
    // the page after every close.
    const timers: number[] = [];
    const delays = [0, 60, 180, 400, 800];
    for (const delay of delays) {
      timers.push(
        window.setTimeout(() => {
          if (document.activeElement !== target) target.focus({ preventScroll: true });
        }, delay),
      );
    }

    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [isOpen]);

  // Move focus into the dialog when it opens. Two reasons, not one: a modal
  // that leaves focus behind the overlay is unusable by keyboard, and WebKit
  // only delivers synthesized key events when the document actually holds
  // focus -- so arrow keys would silently do nothing there.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    dialogRef.current?.focus({ preventScroll: true });
  }, [isOpen]);

  // devicePixelRatio is browser-only, so it is read after mount rather than
  // during render -- reading it during SSR throws "window is not defined".
  useEffect(() => {
    setPixelRatio(window.devicePixelRatio || 1);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        go(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(-1);
      } else if (event.key === 'Tab') {
        // The viewer is a modal dialog, so Tab has to cycle within it.
        //
        // Without this, Shift+Tab from the first control lands on a button in
        // the page *behind* the overlay -- a vote button the user cannot see,
        // on a control that is not part of the dialog they opened. Forward Tab
        // ran off the end of the document and dropped focus on <body>, from
        // where the next press landed in the background page as well. The
        // `aria-modal` attribute promised the rest of the page was inert; the
        // implementation was not keeping that promise.
        const dialog = dialogRef.current;
        if (dialog === null) return;

        const focusable = focusableWithin(dialog);
        const first = focusable.at(0);
        const last = focusable.at(-1);
        if (first === undefined || last === undefined) {
          // Nothing inside to focus; keep focus on the dialog itself rather
          // than letting it escape.
          event.preventDefault();
          dialog.focus({ preventScroll: true });
          return;
        }

        const active = document.activeElement;
        const activeIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;

        if (event.shiftKey) {
          // -1 means focus is on the dialog itself, which carries
          // tabindex="-1" and is where focus lands when the viewer opens.
          // That is before the first control, so it wraps to the last.
          if (activeIndex <= 0) {
            event.preventDefault();
            last.focus({ preventScroll: true });
          }
        } else if (activeIndex === -1 || activeIndex === focusable.length - 1) {
          event.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [go, isOpen, onClose]);

  // Touch swipe, but only while not zoomed: panning a 1:1 image must not flip it.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    if (touch === undefined) return;
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    if (zoom || touchStart.current === null) return;
    const touch = event.changedTouches[0];
    if (touch === undefined) return;
    const dx = touch.clientX - touchStart.current.x;
    const dy = touch.clientY - touchStart.current.y;
    touchStart.current = null;
    // Horizontal intent only, so vertical scrolling is never hijacked.
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx > 0 ? 1 : -1);
  };

  if (!isOpen || active === null) return null;

  const displayWidth = Math.min(active.width, MAX_FIT_HEIGHT * (active.width / active.height));
  const naturalWidth = Math.round(active.width / pixelRatio);

  return (
    <div
      className="lightbox open"
      role="dialog"
      aria-modal="true"
      aria-label={`原始照片查看：${active.title}`}
      tabIndex={-1}
      ref={dialogRef}
      data-testid="lightbox"
    >
      <div className="lightbox-head">
        <span className="lb-brand">
          {active.mime === 'image/jpeg' ? 'ORIGINAL' : 'ORIGINAL FILE'}
        </span>
        <div className="lb-tools">
          <button
            type="button"
            onClick={() => setZoom((value) => !value)}
            aria-pressed={zoom}
            data-testid="lightbox-zoom"
          >
            {zoom ? '适应屏幕' : '1:1 查看'}
          </button>
          <button
            type="button"
            onClick={() => setShowDetails((value) => !value)}
            aria-expanded={showDetails}
            data-testid="lightbox-details-toggle"
          >
            照片信息 ↗
          </button>
          <a
            href={active.downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="lightbox-download"
          >
            下载原图 ↗
          </a>
          <button
            type="button"
            className="lb-close"
            onClick={onClose}
            aria-label="关闭原图"
            data-testid="lightbox-close"
          >
            ×
          </button>
        </div>
      </div>

      <div
        className={zoom ? 'lb-stage zoom' : 'lb-stage'}
        ref={stageRef}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <button
          type="button"
          className="lb-arrow prev"
          onClick={() => go(-1)}
          aria-label="上一张"
          data-testid="lightbox-prev"
        >
          ‹
        </button>

        {imageFailed ? (
          <div className="lb-unavailable lb-error-shown" data-testid="lightbox-error">
            原始文件当前无法加载，请检查网络后重试。
            <br />
            我们不会用缩略图冒充原图。
            <button
              type="button"
              className="btn-quiet"
              data-testid="lightbox-retry"
              onClick={() => {
                // Both states must move: bumping the key alone remounts an
                // <img> that does not exist, because the error branch is what is
                // currently rendered. Without clearing `imageFailed` the viewer
                // can never recover.
                setImageFailed(false);
                setLoadToken((token) => token + 1);
              }}
            >
              重新加载
            </button>
          </div>
        ) : (
          <img
            // Keyed on the retry token so "reload" actually re-requests.
            key={`${active.id}:${loadToken}`}
            src={active.originalUrl}
            alt={active.title}
            className="lb-original"
            style={zoom ? undefined : { width: `${Math.round(displayWidth)}px` }}
            data-testid="lightbox-original-image"
            onError={() => setImageFailed(true)}
            onLoad={() => setImageFailed(false)}
          />
        )}

        <button
          type="button"
          className="lb-arrow next"
          onClick={() => go(1)}
          aria-label="下一张"
          data-testid="lightbox-next"
        >
          ›
        </button>
      </div>

      <div className="lb-footer">
        <div className="lb-work">
          <div className="lb-title">{active.title}</div>
          <div className="lb-sub">
            访客 #{active.uploaderDisplayCode} · 排名 {String(active.rank).padStart(2, '0')} /{' '}
            {String(items.length).padStart(2, '0')}
          </div>
          {active.description !== '' ? (
            <div className="lb-sub" style={{ marginTop: '6px' }}>
              {active.description}
            </div>
          ) : null}
        </div>
        <div className="lb-end">
          <span className="lb-position">
            {String(active.rank).padStart(2, '0')} / {String(items.length).padStart(2, '0')}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span className="lb-score count" data-testid="lightbox-score">
              {formatScore(active.score)}
            </span>
            <VoteControls
              photoId={active.id}
              score={active.score}
              upCount={active.upCount}
              downCount={active.downCount}
              currentVote={active.currentVisitorVote}
              variant="inline"
              onVoteApplied={onVoteApplied}
            />
          </div>
        </div>
      </div>

      <aside className={showDetails ? 'lb-detail open' : 'lb-detail'} aria-hidden={!showDetails}>
        <div className="topline" style={{ color: '#93b7a5', marginBottom: '18px' }}>
          ABOUT THIS PHOTO
        </div>
        <h3>{active.title}</h3>
        <p>{active.description !== '' ? active.description : '这位访客没有写说明。'}</p>
        <dl>
          <dt>原始尺寸</dt>
          <dd data-testid="detail-dimensions">
            {active.width} × {active.height}
          </dd>
          <dt>格式</dt>
          <dd data-testid="detail-format">{formatMime(active.mime)}</dd>
          <dt>文件大小</dt>
          <dd data-testid="detail-bytes">{formatBytes(active.bytes)}</dd>
          <dt>上传者</dt>
          <dd>访客 #{active.uploaderDisplayCode}</dd>
          <dt>上传时间</dt>
          <dd>{formatTimestamp(active.createdAt)}</dd>
          <dt>1:1 显示宽度</dt>
          <dd data-testid="detail-natural-width">{naturalWidth} CSS px</dd>
        </dl>
        <div className="lb-credit">
          <p>
            原图按上传时的字节原样保存，未压缩、未重新编码、未剥离 EXIF。若原图包含 GPS
            信息，其他访客下载后仍可读取。
          </p>
          <a href={active.downloadUrl} target="_blank" rel="noopener noreferrer">
            下载原始文件 ↗
          </a>
        </div>
      </aside>
    </div>
  );
}
