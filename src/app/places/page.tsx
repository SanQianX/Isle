import { cookies } from 'next/headers';
import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/shell/SiteChrome';
import { getConfig } from '@/lib/config';
import { getPrisma } from '@/server/db/client';
import { resolveVisitor, visitorDisplayLabel } from '@/server/auth/visitor';
import { listPlaces } from '@/server/services/place';
import type { loadLeader } from '@/server/services/photo-query';

export const dynamic = 'force-dynamic';

/**
 * Places index.
 *
 * A place's cover is the current top-ranked photo, shown whole — never cropped to
 * a uniform card. A place with no photos gets a clear way in rather than a
 * stretched grey rectangle pretending to be a photograph.
 */

export default async function PlacesPage() {
  const cookieStore = await cookies();
  const config = getConfig();
  const resolved = await resolveVisitor(cookieStore.get(config.visitorCookieName)?.value);
  const visitorLabel = visitorDisplayLabel(resolved.visitor);

  const places = await listPlaces();

  // One query for every leader rather than N+1.
  const leaders = new Map<string, Awaited<ReturnType<typeof loadLeader>>>();
  if (places.length > 0) {
    const prisma = await getPrisma();
    const topByPlace = await prisma.photo.findMany({
      where: { status: 'READY', placeId: { in: places.map((place) => place.id) } },
      include: { visitor: { select: { displayCode: true } }, votes: { select: { value: true } } },
    });
    for (const place of places) {
      const rows = topByPlace.filter((photo) => photo.placeId === place.id);
      rows.sort((a, b) => {
        const aScore = a.votes.reduce((sum, vote) => sum + vote.value, 0);
        const bScore = b.votes.reduce((sum, vote) => sum + vote.value, 0);
        return bScore - aScore || a.createdAt.getTime() - b.createdAt.getTime();
      });
      const best = rows[0];
      leaders.set(
        place.id,
        best === undefined
          ? null
          : ({
              id: best.id,
              title: best.title,
              width: best.width,
              height: best.height,
              preview1200Url: `/api/photos/${best.id}/preview/1200`,
            } as NonNullable<Awaited<ReturnType<typeof loadLeader>>>),
      );
    }
  }

  return (
    <>
      <SiteHeader visitorLabel={visitorLabel} active="places" />

      <main>
        <div className="wrap page-head">
          <div className="page-kicker">PLACES · 地点档案</div>
          <h1>发现地点</h1>
          <p>一处地方，一本由大家共同完成的风景相册。地点越多，你能发现的美也越多。</p>
          <div className="head-links">
            <Link href="/places/new" className="btn-quiet">
              ＋ 创建新地点 ↗
            </Link>
          </div>
        </div>

        <section className="wrap places-section">
          {places.length === 0 ? (
            <p className="muted">还没有任何地点。</p>
          ) : (
            places.map((place, index) => {
              const leader = leaders.get(place.id) ?? null;
              return (
                <article className="place-feature" key={place.id}>
                  <Link
                    href={`/places/${place.slug}`}
                    className="feature-image photo-media"
                    aria-label={`打开${place.name}地点榜单`}
                  >
                    {leader === null ? (
                      <div className="offline" style={{ display: 'flex' }}>
                        {place.name}还没有照片
                        <br />
                        上传第一张后这里就会出现最美作品
                      </div>
                    ) : (
                      <img
                        src={leader.preview1200Url}
                        alt={`${place.name}的最高票照片：${leader.title}`}
                        width={leader.width}
                        height={leader.height}
                        loading={index < 2 ? 'eager' : 'lazy'}
                      />
                    )}
                  </Link>

                  <div className="feature-text">
                    <div className="feature-number">
                      PLACE / {String(index + 1).padStart(3, '0')}
                    </div>
                    <h2>
                      <Link href={`/places/${place.slug}`}>{place.name}</Link>
                    </h2>
                    <div className="feature-region">⌖ {place.region}</div>
                    <div className="feature-metrics">
                      <span>{place.photoCount} 张照片</span>
                      <span>{place.contributorCount} 位分享者</span>
                    </div>
                    <Link href={`/places/${place.slug}`} className="btn-outline">
                      进入这个地方 <span aria-hidden="true">↗</span>
                    </Link>
                  </div>
                </article>
              );
            })
          )}

          <Link href="/places/new" className="create-row">
            <span className="circle">＋</span>
            <span>添加一个新的地点</span>
            <span style={{ marginLeft: 'auto' }} aria-hidden="true">
              ↗
            </span>
          </Link>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
