import { cookies } from 'next/headers';
import { SiteFooter, SiteHeader } from '@/components/shell/SiteChrome';
import { CreatePlaceForm } from '@/components/forms/CreatePlaceForm';
import { getConfig } from '@/lib/config';
import { resolveVisitor, visitorDisplayLabel } from '@/server/auth/visitor';

export const dynamic = 'force-dynamic';

/** A standalone page, not a dialog: the form is the whole reason to be here. */
export default async function NewPlacePage() {
  const cookieStore = await cookies();
  const config = getConfig();
  const resolved = await resolveVisitor(cookieStore.get(config.visitorCookieName)?.value);

  return (
    <>
      <SiteHeader visitorLabel={visitorDisplayLabel(resolved.visitor)} active="places" />

      <main>
        <div className="wrap form-layout">
          <div className="form-aside">
            <div className="eyebrow">ADD A PLACE</div>
            <h1>
              为一个地方，
              <br />
              留住好风景。
            </h1>
            <p>
              只需要一个地点名字，你就能为这个地方建立照片榜单。以后每个地方都可以有自己的第一名。
            </p>
            <div className="small-divider" />
            <div className="step-hint">
              01　填写地点名称
              <br />
              02　写上所在地区
              <br />
              03　开始分享照片
            </div>
          </div>

          <div className="form-main">
            <CreatePlaceForm />
          </div>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
