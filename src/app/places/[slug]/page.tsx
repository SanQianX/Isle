import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteFooter, SiteHeader } from '@/components/shell/SiteChrome';
import { PhotoWall } from '@/components/photo/PhotoWall';
import { VoteControls } from '@/components/photo/VoteControls';
import { formatScore } from '@/lib/format';
import { getConfig } from '@/lib/config';
import { resolveVisitor, visitorDisplayLabel } from '@/server/auth/visitor';
import { getPlaceBySlug } from '@/server/services/place';
import { loadTopPhotos } from '@/server/services/photo-query';
import { toWallPhoto } from '@/lib/wall-photo';

export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ slug: string }> };

/** A place landing page: who it is, what is on top, and a way in to everything. */
export default async function PlacePage({ params }: PageProps) {
  const { slug } = await params;
  const cookieStore = await cookies();
  const config = getConfig();
  const resolved = await resolveVisitor(cookieStore.get(config.visitorCookieName)?.value);

  const place = await getPlaceBySlug(slug);
  if (place === null) notFound();

  const { photos, summary } = await loadTopPhotos(place.id, resolved.visitor.id, 7);
  const [leader, ...rest] = photos;

  return (
    <>
      <SiteHeader visitorLabel={visitorDisplayLabel(resolved.visitor)} active="places" />

      <main>
        <div className="wrap page-head">
          <div className="page-kicker">{place.region}</div>
          <h1>{place.name}</h1>
          <p>{place.description}</p>
          <div className="head-links">
            <Link href={`/places/${place.slug}/upload`} className="btn-dark">
              ＋ 上传我的照片
            </Link>
            <Link href={`/places/${place.slug}/ranking`} className="btn-quiet">
              查看完整榜单 ↗
            </Link>
          </div>
        </div>

        <div className="wrap rank-page">
          {leader === undefined ? (
            <div className="feature-empty">
              <div>
                <h3>还没有照片</h3>
                <p>上传第一张照片，这个地方就有了自己的第一名。</p>
              </div>
              <Link href={`/places/${place.slug}/upload`} className="btn-outline">
                上传第一张 ↗
              </Link>
            </div>
          ) : (
            <>
              <div className="rank-feature">
                <button className="photo-tap" type="button" aria-label="查看第一名照片原图">
                  <div className="photo-media">
                    <img
                      src={leader.preview1200Url}
                      alt={leader.title}
                      width={leader.width}
                      height={leader.height}
                      fetchPriority="high"
                    />
                  </div>
                </button>
                <div>
                  <div className="feature-number">
                    CURRENT NO.01 / {String(summary.photoCount).padStart(2, '0')}
                  </div>
                  <div className="feature-position">
                    01
                    <span style={{ fontSize: '18px', verticalAlign: 'top', color: 'var(--muted)' }}>
                      　/ 第一名
                    </span>
                  </div>
                  <h2>{leader.title}</h2>
                  <p>
                    访客 #{leader.uploaderDisplayCode} 分享于{place.name}
                    <br />
                    {leader.description}
                  </p>
                  <div className="big-vote">
                    <strong className="count" data-testid="place-leader-score">
                      {formatScore(leader.score)}
                    </strong>
                    <VoteControls
                      photoId={leader.id}
                      score={leader.score}
                      upCount={leader.upCount}
                      downCount={leader.downCount}
                      currentVote={leader.currentVisitorVote}
                      variant="hero"
                    />
                  </div>
                </div>
              </div>

              {rest.length > 0 ? (
                <>
                  <div className="ranking-mini">
                    <strong>其余照片</strong>
                    <span>按净票数排序 · 同分先比赞成票，再比上传时间</span>
                  </div>
                  <PhotoWall photos={rest.map(toWallPhoto)} />
                </>
              ) : null}
            </>
          )}
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
