import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/shell/SiteChrome';

/**
 * 404 for an unknown route or slug (FRONTEND_UX §2, NAV-04).
 *
 * It offers a way onward rather than a dead end, and it says nothing about
 * whether the requested thing ever existed.
 */
export default function NotFound() {
  return (
    <>
      <SiteHeader active="places" />
      <main>
        <div className="wrap page-head">
          <div className="page-kicker">404 · 这里没有东西</div>
          <h1>找不到这个地方</h1>
          <p>页面可能已经不存在，或者地址写错了。看看下面这些地方吧。</p>
          <div className="head-links">
            <Link href="/" className="btn-dark">
              ← 回到首页
            </Link>
            <Link href="/places" className="btn-quiet">
              发现地点 ↗
            </Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
