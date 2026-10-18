/**
 * Placeholder home for Phase 01.
 *
 * Phase 06 replaces this with the real featured-place hero reading from the
 * database. Phase 01's acceptance only requires that the app builds, that
 * `GET /api/health` answers 200, and that Playwright can open the home page
 * against a real server build with no fatal console errors.
 */
export default function HomePage() {
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
        <p
          style={{
            fontSize: '0.6875rem',
            letterSpacing: '0.16em',
            fontWeight: 650,
            color: 'var(--muted)',
          }}
        >
          ISLE · 屿集
        </p>
        <h1
          style={{
            fontSize: 'clamp(3rem, 9vw, 6rem)',
            fontWeight: 580,
            letterSpacing: '-0.08em',
            lineHeight: 1,
            margin: '20px 0 16px',
          }}
        >
          每一处风景
          <br />
          都值得被看见
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: '0.875rem', lineHeight: 1.9, margin: 0 }}>
          工程骨架已就绪。地点、照片与榜单将在后续阶段接入真实数据库与磁盘存储。
        </p>
      </div>
    </main>
  );
}
