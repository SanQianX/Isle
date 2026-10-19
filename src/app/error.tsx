'use client';

import { useEffect } from 'react';
import Link from 'next/link';

/**
 * Last-resort error boundary.
 *
 * The rule from the contract is simple: never show a visitor a stack trace or a
 * raw exception message. They get a plain apology and a way onward, and the
 * detail goes to the server log where it belongs.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side detail only: no visitor data, no file paths, no cookies.
    console.error('[isle] unhandled page error:', error.message);
  }, [error]);

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: '48px 24px',
        textAlign: 'center',
      }}
    >
      <div>
        <p className="topline">SOMETHING WENT WRONG</p>
        <h1
          style={{
            fontSize: 'clamp(2rem, 6vw, 3.5rem)',
            fontWeight: 580,
            letterSpacing: '-0.07em',
            margin: '18px 0 14px',
          }}
        >
          出了点问题
        </h1>
        <p
          style={{
            color: 'var(--muted)',
            fontSize: '0.875rem',
            lineHeight: 1.9,
            margin: '0 0 28px',
          }}
        >
          这一页没能正常打开。刷新一次通常就好了。
        </p>
        <div style={{ display: 'flex', gap: '18px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn-dark" onClick={reset}>
            重新加载
          </button>
          <Link href="/" className="btn-quiet">
            回到首页 →
          </Link>
        </div>
      </div>
    </main>
  );
}
