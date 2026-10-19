import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteFooter, SiteHeader } from '@/components/shell/SiteChrome';
import { RankingBoard } from '@/components/photo/RankingBoard';
import { getConfig } from '@/lib/config';
import { resolveVisitor, visitorDisplayLabel } from '@/server/auth/visitor';
import { getPlaceBySlug } from '@/server/services/place';
import { loadRankedPhotos } from '@/server/services/photo-query';

export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ slug: string }> };

/**
 * The full ranking.
 *
 * The whole point of this page is that the order is meaningful, so the client
 * is handed the complete ranked list and re-sorts locally after a vote. That is
 * what lets the leaderboard respond immediately without a round trip, and what
 * keeps focus and scroll position anchored rather than snapping to the top.
 */
export default async function RankingPage({ params }: PageProps) {
  const { slug } = await params;
  const cookieStore = await cookies();
  const config = getConfig();
  const resolved = await resolveVisitor(cookieStore.get(config.visitorCookieName)?.value);

  const place = await getPlaceBySlug(slug);
  if (place === null) notFound();

  const { photos, summary } = await loadRankedPhotos(place.id, resolved.visitor.id);

  const items = photos.map((photo) => ({
    id: photo.id,
    rank: photo.rank,
    title: photo.title,
    description: photo.description,
    width: photo.width,
    height: photo.height,
    bytes: photo.bytes,
    mime: photo.mime,
    createdAt: photo.createdAt.toISOString(),
    uploaderDisplayCode: photo.uploaderDisplayCode,
    score: photo.score,
    upCount: photo.upCount,
    downCount: photo.downCount,
    currentVisitorVote: photo.currentVisitorVote,
    preview400Url: photo.preview400Url,
    preview1200Url: photo.preview1200Url,
    originalUrl: photo.originalUrl,
    downloadUrl: photo.downloadUrl,
  }));

  return (
    <>
      <SiteHeader visitorLabel={visitorDisplayLabel(resolved.visitor)} active="ranking" />

      <main>
        <div className="wrap page-head">
          <div className="page-kicker">{place.region}</div>
          <h1>{place.name} · 照片榜</h1>
          <p>
            从大家分享的照片里选出最好看的一张。你的一票会改变这里的排名。 共 {summary.photoCount}{' '}
            张照片，{summary.contributorCount} 位分享者。
          </p>
          <div className="head-links">
            <Link href={`/places/${place.slug}/upload`} className="btn-dark">
              ＋ 上传我的照片
            </Link>
            <Link href={`/places/${place.slug}`} className="btn-quiet">
              返回地点首页 ↗
            </Link>
          </div>
        </div>

        <div className="wrap rank-page">
          <RankingBoard
            placeId={place.id}
            placeName={place.name}
            placeSlug={place.slug}
            items={items}
          />
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
