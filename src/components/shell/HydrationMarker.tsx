'use client';

import { useEffect } from 'react';

/**
 * Marks the document as hydrated.
 *
 * Server Components render identical markup on both sides, so a test can type
 * into a form before React takes over and silently see nothing happen — the
 * value goes into the DOM but never reaches component state. Exposing an
 * explicit signal lets tests wait for interactivity instead of guessing with a
 * sleep, which is exactly the kind of timing assumption that makes a suite
 * flaky.
 *
 * It is a data attribute on <html>: no visual output, no layout effect, and it
 * costs one effect after hydration.
 */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true';
  }, []);
  return null;
}
