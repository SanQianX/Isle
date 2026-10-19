'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Create a place.
 *
 * Two things matter here beyond "it posts":
 *
 *   - A duplicate name returns 409 with the existing slug, so the form offers a
 *     way *through* to that place rather than a dead end.
 *   - The submit button disables while in flight, because a double submit would
 *     create the place twice (or race the duplicate check).
 */

const NAME_MAX = 60;
const REGION_MAX = 80;
const DESCRIPTION_MAX = 300;

type FieldErrors = Partial<Record<'name' | 'region' | 'description', string>>;

export function CreatePlaceForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [description, setDescription] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicateSlug, setDuplicateSlug] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * Validate before sending.
   *
   * The server already rejects a blank name, but only after a round trip. A form
   * that fires a request it knows will fail is both slower and easier to get
   * wrong, and the contract asks for a Chinese validation message rather than a
   * server error page.
   */
  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (name.trim().length === 0) errors.name = '请填写地点名称';
    if (region.trim().length < 2) errors.region = '请填写所在地区';
    if (description.length > DESCRIPTION_MAX)
      errors.description = `介绍最多 ${DESCRIPTION_MAX} 个字`;
    return errors;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const local = validate();
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      setFormError('请检查下面标红的内容');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});
    setDuplicateSlug(null);

    try {
      const response = await fetch('/api/places', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name, region, description }),
      });

      if (response.status === 409) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string; details?: { slug?: string } };
        } | null;
        // `details` lives *inside* the error envelope, not beside it. Reading it
        // from the top level silently yielded no slug, so the "go to the
        // existing place" link never appeared on a genuine conflict.
        setFormError(body?.error?.message ?? '这个地点已经存在');
        setDuplicateSlug(body?.error?.details?.slug ?? null);
        return;
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: {
            message?: string;
            details?: { issues?: Array<{ path: string; message: string }> };
          };
        } | null;
        const issues = body?.error?.details?.issues ?? [];
        if (issues.length > 0) {
          const next: FieldErrors = {};
          for (const issue of issues) {
            const key = issue.path as keyof FieldErrors;
            if (key in next === false) next[key] = issue.message;
          }
          setFieldErrors(next);
          setFormError('请检查下面标红的内容');
        } else {
          setFormError(body?.error?.message ?? '创建失败，请稍后再试');
        }
        return;
      }

      const body = (await response.json()) as { place: { slug: string } };
      router.push(`/places/${body.place.slug}`);
      router.refresh();
    } catch {
      setFormError('网络好像断开了，请检查连接后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form-card" onSubmit={submit} noValidate data-testid="create-place-form">
      <div className="form-title">新地点</div>

      <label className="field" htmlFor="newPlace">
        地点名称
      </label>
      <input
        id="newPlace"
        className="text-input"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={NAME_MAX}
        placeholder="例如：外伶仃岛"
        aria-invalid={fieldErrors.name !== undefined}
        aria-describedby={fieldErrors.name === undefined ? undefined : 'newPlace-error'}
        data-testid="place-name-input"
      />
      {fieldErrors.name !== undefined ? (
        <p className="field-error" id="newPlace-error" role="alert">
          {fieldErrors.name}
        </p>
      ) : null}

      <label className="field" htmlFor="newRegion">
        所在地区
      </label>
      <input
        id="newRegion"
        className="text-input"
        value={region}
        onChange={(event) => setRegion(event.target.value)}
        maxLength={REGION_MAX}
        placeholder="例如：广东 · 珠海"
        aria-invalid={fieldErrors.region !== undefined}
        aria-describedby={fieldErrors.region === undefined ? undefined : 'newRegion-error'}
        data-testid="place-region-input"
      />
      {fieldErrors.region !== undefined ? (
        <p className="field-error" id="newRegion-error" role="alert">
          {fieldErrors.region}
        </p>
      ) : null}

      <label className="field" htmlFor="newDescription">
        一句介绍（可选）
      </label>
      <textarea
        id="newDescription"
        className="text-area"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        maxLength={DESCRIPTION_MAX}
        placeholder="例如：安静的海岛，日落时整片海都是金色的。"
        aria-invalid={fieldErrors.description !== undefined}
        data-testid="place-description-input"
      />
      <div className="char-count">
        {description.length} / {DESCRIPTION_MAX}
      </div>

      {formError !== null ? (
        <div className="form-alert" role="alert" data-testid="place-form-error">
          <span>{formError}</span>
          {duplicateSlug !== null ? (
            <a href={`/places/${duplicateSlug}`} className="btn-quiet">
              前往已存在的地点 →
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="form-bottom">
        <p>新地点会先显示为空相册，上传第一张照片后即可开始投票。</p>
        <button className="btn-dark" type="submit" disabled={submitting} data-testid="place-submit">
          {submitting ? '正在创建…' : '创建地点　↗'}
        </button>
      </div>
    </form>
  );
}
