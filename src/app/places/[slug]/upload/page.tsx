import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteFooter, SiteHeader } from '@/components/shell/SiteChrome';
import { UploadForm } from '@/components/forms/UploadForm';
import { getConfig, ALLOWED_IMAGE_MIME_TYPES, describeLimits } from '@/lib/config';
import { resolveVisitor, visitorDisplayLabel } from '@/server/auth/visitor';
import { getPlaceBySlug } from '@/server/services/place';

export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ slug: string }> };

/**
 * Upload photos to a place.
 *
 * A dedicated page rather than a dialog, and the place is fixed by the URL — so
 * it is impossible to send a photo to the wrong destination by forgetting to
 * pick one.
 */
export default async function UploadPage({ params }: PageProps) {
  const { slug } = await params;
  const cookieStore = await cookies();
  const config = getConfig();
  const resolved = await resolveVisitor(cookieStore.get(config.visitorCookieName)?.value);

  const place = await getPlaceBySlug(slug);
  if (place === null) notFound();

  const limits = describeLimits(config);

  return (
    <>
      <SiteHeader visitorLabel={visitorDisplayLabel(resolved.visitor)} active="ranking" />

      <main>
        <div className="wrap form-layout">
          <div className="form-aside">
            <div className="eyebrow">SHARE YOUR MOMENT</div>
            <h1>
              把你眼中的
              <br />
              <span>{place.name}</span>，
              <br />
              分享给大家。
            </h1>
            <p>挑几张真正喜欢的照片。不需要很专业，只要是你拍下的好风景。</p>
            <div className="small-divider" />
            <div className="step-hint">
              01　选择多张照片
              <br />
              02　留下一句话（可选）
              <br />
              03　加入{place.name}的照片榜
            </div>
            <p className="back-link">
              <Link href={`/places/${place.slug}`} className="btn-quiet">
                ← 返回{place.name}
              </Link>
            </p>
          </div>

          <div className="form-main">
            <UploadForm
              placeId={place.id}
              placeSlug={place.slug}
              placeName={place.name}
              limits={{
                maxUploadBytes: limits.maxUploadBytes,
                maxUploadFiles: limits.maxUploadFiles,
                maxConcurrentUploads: limits.maxConcurrentUploads,
                acceptedTypes: ALLOWED_IMAGE_MIME_TYPES,
              }}
            />
          </div>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
