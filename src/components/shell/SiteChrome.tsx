import Link from 'next/link';

/**
 * Site chrome: header and footer.
 *
 * Server components — neither reads per-visitor state. The header shows the
 * anonymous display label, which the layout resolves server-side and passes in.
 */

export type SiteChromeProps = {
  /** Non-identifying visitor label, e.g. 访客 #a3f182. Null before first visit. */
  visitorLabel?: string | null;
  /** Which nav item is current. */
  active?: 'home' | 'places' | 'ranking';
  /** Hides the nav entirely on the home hero, as the V4.1 prototype does. */
  onHome?: boolean;
  /** Contributes the hero background on the home page. */
  children?: React.ReactNode;
};

export function SiteHeader({ visitorLabel, active, onHome }: SiteChromeProps) {
  return (
    <header className="site-header">
      <div className="wrap header-line">
        {/* No aria-label: an explicit label that does not contain the visible
            text fails WCAG's label-in-name rule. The visible text plus the link
            role already reads as "ISLE · 每一处风景，都值得被看见, link", which
            is the correct name for a home link. */}
        <Link href="/" className="brand">
          ISLE
          <span>·</span>
          <span className="brand-sub">每一处风景，都值得被看见</span>
        </Link>

        <nav className="nav" aria-label="主要导航">
          <Link href="/" className={active === 'home' ? 'active' : undefined}>
            首页
          </Link>
          <Link href="/places" className={active === 'places' ? 'active' : undefined}>
            发现地点
          </Link>
          <Link
            href="/places/guishan-island/ranking"
            className={active === 'ranking' ? 'active' : undefined}
          >
            照片榜
          </Link>
        </nav>

        <div className="header-right">
          {visitorLabel !== null && visitorLabel !== undefined ? (
            <span className="visitor" data-testid="visitor-label">
              {visitorLabel}
            </span>
          ) : null}
          <Link href="/places/guishan-island/upload" className="nav-button">
            ＋ 分享照片
          </Link>
        </div>
      </div>
      {onHome === true ? <div aria-hidden="true" /> : null}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer-top">
          <div>
            <strong>ISLE.</strong>
            <div className="topline" style={{ marginTop: '7px', letterSpacing: '.12em' }}>
              EVERY PLACE. ONE BEST SHOT.
            </div>
          </div>
          <p>
            每个地方都有值得被记住的风景。
            <br />
            在这里，最好看的那张由大家一起选出来。
          </p>
        </div>
        <div className="footer-bottom">
          <span>ISLE / LOCATION PHOTO RANKING</span>
          <span>只让照片发光，页面保持安静。</span>
        </div>
      </div>
    </footer>
  );
}
