import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteFooter, SiteHeader } from '@/components/shell/SiteChrome';
import { PhotoWall, type WallPhoto } from '@/components/photo/PhotoWall';
import { getConfig } from '@/lib/config';
import { getPrisma } from '@/server/db/client';
import { getFeaturedPlace } from '@/server/services/place';
import { resolveVisitor, visitorDisplayLabel } from '@/server/auth/visitor';
import { tallyVotes } from '@/server/ranking';

export const dynamic = 'force-dynamic';

/**
 * Home — the featured place.
 *
 * Server-rendered from the database on every request. There is no demo data and
 * no placeholder photography: if the place has no photos, it says so.
 */

async function loadPhotos(placeId: string, limit: number) {
  const prisma = await getPrisma();

  const photos = await prisma.photo.findMany({
    where: { placeId, status: 'READY' },
    include: {
      visitor: { select: { displayCode: true } },
      votes: { select: { value: true } },
    },
  });

  return photos
    .map((photo) => {
      const counts =
        tallyVotes(photo.votes.map((vote) => ({ photoId: photo.id, value: vote.value }))).get(
          photo.id,
        ) ?? { upCount: 0, downCount: 0 };

      const wall: WallPhoto = {
        id: photo.id,
        rank: 0,
        width: photo.width,
        height: photo.height,
        title: photo.title,
        description: photo.description,
        uploader: `访客 #${photo.visitor.displayCode}`,
        score: counts.upCount - counts.downCount,
        upCount: counts.upCount,
        downCount: counts.downCount,
        preview400Url: `/api/photos/${photo.id}/preview/400`,
        preview1200Url: `/api/photos/${photo.id}/preview/1200`,
      };

      return {
        wall,
        createdAt: photo.createdAt.getTime(),
      };
    })
    .sort(
      (a, b) =>
        b.wall.score - a.wall.score ||
        b.wall.upCount - a.wall.upCount ||
        a.createdAt - b.createdAt ||
        a.wall.id.localeCompare(b.wall.id),
    )
    .slice(0, limit)
    .map((entry, index) => ({ ...entry.wall, rank: index + 1 }));
}

export default async function HomePage() {
  const cookieStore = await cookies();
  const config = getConfig();

  const rawToken = cookieStore
    .get(config.visitorCookieName)
    ?.value;
  const resolved = await resolveVisitor(rawToken);
  const visitorLabel = visitorDisplayLabel(resolved.visitor);

  const place = await getFeaturedPlace();
  if (place === null) notFound();

  // The home page shows the leader, then the next few.
  const ranked = await loadPhotos(place.id, 4);
  const [leader, ...rest] = ranked;

  const photoCount = place.photoCount;
  const contributorCount = place.contributorCount;
  const totalVotes = ranked.reduce((sum, photo) => sum + photo.score, 0);

  return (
    <>
      <SiteHeader visitorLabel={visitorLabel} active="home" onHome />

      <main>
        <section className="hero-bg">
          <div className="wrap hero-top">
            <div className="breadcrumb">
              <Link href="/places">全部地点</Link>
              <span>／</span>
              <strong>{place.name}</strong>
            </div>
            <div className="hero-id">
              PLACE / <span>{String(1).padStart(3, '0')}</span>
            </div>
          </div>

          <div className="wrap hero">
            <div className="hero-copy">
              <div className="location">
                <span className="pin" aria-hidden="true">
                  ⌖
                </span>
                <span>{place.region}</span>
              </div>
              <h1>{place.name}</h1>
              <p className="hero-tagline">
                一个地方，
                <br />
                许多种好看。
              </p>
              <p className="hero-description">{place.description}</p>

              <div className="hero-actions">
                <Link href={`/places/${place.slug}/upload`} className="btn-dark">
                  我也拍过这里 <span aria-hidden="true">↗</span>
                </Link>
                <Link href={`/places/${place.slug}/ranking`} className="btn-quiet">
                  查看完整榜单 <span aria-hidden="true">→</span>
                </Link>
              </div>

              <div className="hero-stats">
                <div className="stat">
                  <div className="stat-number count">{String(photoCount).padStart(2, '0')}</div>
                  <div className="stat-label">张照片</div>
                </div>
                <div className="stat">
                  <div className="stat-number count">
                    {String(contributorCount).padStart(2, '0')}
                  </div>
                  <div className="stat-label">位分享者</div>
                </div>
                <div className="stat">
                  <div className="stat-number count">{totalVotes}</div>
                  <div className="stat-label">次投票</div>
                </div>
              </div>
            </div>

            <div className="hero-pick">
              {leader === undefined ? (
                <div className="hero-pick-meta">
                  <div>
                    <h2 className="pick-title">这里还没有照片</h2>
                    <div className="pick-artist">等你上传第一张</div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="pick-head">
                    <span className="pick-badge">
                      <i />
                      这里最好看的照片 · 当前第一名
                    </span>
                    <span className="pick-step count">
                      01 / {String(photoCount).padStart(2, '0')}
                    </span>
                  </div>
                  <div className="hero-photo-frame photo-media">
                    <img
                      src={leader.preview1200Url}
                      alt={leader.title}
                      width={leader.width}
                      height={leader.height}
                      fetchPriority="high"
                    />
                  </div>
                  <div className="hero-pick-meta">
                    <div>
                      <h2 className="pick-title">{leader.title}</h2>
                      <div className="pick-artist">{leader.uploader} 分享</div>
                    </div>
                    <div className="pick-vote">
                      <span className="big-score count" data-testid="hero-score">
                        {leader.score > 0 ? `+${leader.score}` : leader.score}
                      </span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="wrap hero-note">
            <span>没有专业评委。只有去过这里的人，和每一张值得分享的照片。</span>
            <span>按照投票分数实时排序</span>
          </div>
        </section>

        {rest.length > 0 ? (
          <section className="wrap section">
            <div className="section-head">
              <div>
                <div className="topline">MORE FROM THIS PLACE</div>
                <h2>
                  {place.name} · 照片榜
                </h2>
              </div>
              <p>
                好看这件事，交给大家决定。
                <br />
                点开照片，认真看每一处细节。
              </p>
            </div>

            <PhotoWall photos={rest} />

            <Link href={`/places/${place.slug}/ranking`} className="section-link">
              查看这个地方的全部照片 <span aria-hidden="true">↗</span>
            </Link>
          </section>
        ) : (
          <section className="wrap section">
            <div className="page-head">
              <div className="page-kicker">{place.name.toUpperCase()} · PHOTO RANKING</div>
              <h1>还没有照片</h1>
              <p>这里还没有照片。上传第一张，这个地方就有了自己的第一名。</p>
              <div className="head-links">
                <Link href={`/places/${place.slug}/upload`} className="btn-dark">
                  ＋ 上传第一张照片
                </Link>
              </div>
            </div>
          </section>
        )}

        <section className="soft-band">
          <div className="wrap soft-inner">
            <div>
              <div className="topline">MAKE THE NEXT PLACE</div>
              <h2>还有哪些地方，值得被记住？</h2>
              <p>
                {place.name}只是第一站。创建新的地点，让更多人把在那里的风景分享出来。
              </p>
            </div>
            <Link href="/places" className="btn-outline">
              发现更多地点 <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
