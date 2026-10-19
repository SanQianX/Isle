'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';
import { formatBytes } from '@/lib/format';

/**
 * Multi-photo upload.
 *
 * The client batches: the server contract is one file per request, so this
 * keeps a fixed number of requests in flight (2, from the shared config) rather
 * than firing thirty at once. Each file keeps its own status and its own retry
 * button, because the contract is that one bad photo must not fail the batch.
 *
 * The EXIF/GPS acknowledgement is a real gate, not decorative copy: originals
 * are archived unchanged and remain downloadable, so a photo's location can be
 * exposed. It has to be seen and accepted before anything is sent.
 */

export type UploadLimits = {
  maxUploadBytes: number;
  maxUploadFiles: number;
  maxConcurrentUploads: number;
  acceptedTypes: readonly string[];
};

type RowStatus = 'queued' | 'uploading' | 'success' | 'failed';

type Row = {
  key: string;
  file: File;
  title: string;
  description: string;
  status: RowStatus;
  error: string | null;
};

let rowCounter = 0;

export function UploadForm({
  placeId,
  placeSlug,
  placeName,
  limits,
}: {
  placeId: string;
  placeSlug: string;
  placeName: string;
  limits: UploadLimits;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [description, setDescription] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const patch = useCallback((key: string, changes: Partial<Row>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...changes } : row)));
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      setRows((current) => {
        const room = limits.maxUploadFiles - current.length;
        if (room <= 0) return current;

        const added: Row[] = [];
        for (const file of Array.from(files).slice(0, room)) {
          rowCounter += 1;
          added.push({
            key: `${rowCounter}`,
            file,
            // Default the title from the filename without its extension.
            title: file.name.replace(/\.[^.]+$/, '').slice(0, 80),
            description: '',
            status: 'queued',
            error: null,
          });
        }
        return [...current, ...added];
      });
    },
    [limits.maxUploadFiles],
  );

  /** Pre-flight: reject obvious problems before spending an upload. */
  const validate = useCallback(
    (file: File): string | null => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowed.includes(file.type)) {
        return `不支持的格式：${file.type || '未知'}。仅支持 JPEG / PNG / WebP`;
      }
      if (file.size > limits.maxUploadBytes) {
        return `文件 ${formatBytes(file.size)} 超过单张 ${formatBytes(limits.maxUploadBytes)} 限制`;
      }
      return null;
    },
    [limits.maxUploadBytes],
  );

  const uploadOne = useCallback(
    async (row: Row): Promise<void> => {
      patch(row.key, { status: 'uploading', error: null });

      const form = new FormData();
      form.append('file', row.file, row.file.name);
      form.append('title', row.title);
      form.append('description', row.description);
      // A stable key makes a retry safe: the server returns the photo it
      // already stored rather than creating a duplicate.
      form.append('idempotencyKey', `${placeId}:${row.key}:${row.file.name}:${row.file.size}`);

      try {
        const response = await fetch(`/api/places/${placeId}/photos`, {
          method: 'POST',
          body: form,
          credentials: 'same-origin',
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          patch(row.key, {
            status: 'failed',
            error: body?.error?.message ?? `上传失败（${response.status}）`,
          });
          return;
        }

        patch(row.key, { status: 'success', error: null });
      } catch {
        patch(row.key, { status: 'failed', error: '网络中断，请重试这一张' });
      }
    },
    [patch, placeId],
  );

  const runQueue = useCallback(
    async (targets: Row[]) => {
      const pending = targets.filter((row) => row.status !== 'success');
      let cursor = 0;

      // A fixed worker pool: two in flight, as the shared config requires.
      const worker = async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const row = pending[index];
          if (row === undefined) return;
          await uploadOne(row);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(limits.maxConcurrentUploads, pending.length) }, worker),
      );
    },
    [limits.maxConcurrentUploads, uploadOne],
  );

  async function submit() {
    if (submitting) return;
    const queued = rows.filter((row) => row.status !== 'success');
    if (queued.length === 0) return;
    if (!acknowledged) return;

    setSubmitting(true);
    // Snapshot with the shared description applied, so an edit mid-flight is
    // not silently lost.
    const targets = queued.map((row) => ({ ...row, description }));
    setRows((current) =>
      current.map((row) => (row.status === 'success' ? row : { ...row, description })),
    );
    await runQueue(targets);
    setSubmitting(false);
  }

  const counts = useMemo(
    () => ({
      success: rows.filter((row) => row.status === 'success').length,
      failed: rows.filter((row) => row.status === 'failed').length,
      pending: rows.filter((row) => row.status !== 'success').length,
    }),
    [rows],
  );

  return (
    <div className="form-card" data-testid="upload-form">
      <div className="form-title">
        添加照片 <span className="muted">（{rows.length} 张）</span>
      </div>

      <div
        className={dragging ? 'dropzone drag' : 'dropzone'}
        role="button"
        tabIndex={0}
        aria-label="选择多张照片"
        data-testid="dropzone"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
        }}
      >
        <div className="upload-mark">＋</div>
        <strong>点击选择照片，或将照片拖到这里</strong>
        <small>
          最多 {limits.maxUploadFiles} 张，单张不超过 {formatBytes(limits.maxUploadBytes)}
          <br />
          支持批量选择 · JPEG / PNG / WebP
          <br />
          照片会按原始比例展示
        </small>
        <input
          ref={inputRef}
          id="fileInput"
          type="file"
          accept={limits.acceptedTypes.join(',')}
          multiple
          hidden
          data-testid="file-input"
          onChange={(event) => {
            if (event.target.files !== null) addFiles(event.target.files);
            // Allow re-picking the same file after a removal.
            event.target.value = '';
          }}
        />
      </div>

      {rows.length > 0 ? (
        <ul className="previews-list" data-testid="upload-rows">
          {rows.map((row) => (
            <li className="upload-row" key={row.key} data-testid={`upload-row-${row.key}`}>
              <div className="preview-image">
                <img src={URL.createObjectURL(row.file)} alt={row.title} />
                <button
                  type="button"
                  aria-label={`移除 ${row.title}`}
                  onClick={() =>
                    setRows((current) => current.filter((item) => item.key !== row.key))
                  }
                >
                  ×
                </button>
              </div>
              <div className="upload-row-info">
                <input
                  className="text-input"
                  value={row.title}
                  maxLength={80}
                  aria-label={`${row.file.name} 的标题`}
                  onChange={(event) => patch(row.key, { title: event.target.value.slice(0, 80) })}
                />
                <div className="upload-row-meta">
                  {formatBytes(row.file.size)} ·{' '}
                  <span className={`upload-status upload-status-${row.status}`}>
                    {row.status === 'queued' ? '等待上传' : null}
                    {row.status === 'uploading' ? '上传中…' : null}
                    {row.status === 'success' ? '已上传' : null}
                    {row.status === 'failed' ? '失败' : null}
                  </span>
                </div>
                {row.error !== null ? (
                  <div
                    className="upload-error"
                    role="alert"
                    data-testid={`upload-error-${row.key}`}
                  >
                    {row.error}
                    <button
                      type="button"
                      className="btn-quiet"
                      onClick={() => {
                        const problem = validate(row.file);
                        if (problem !== null) {
                          patch(row.key, { status: 'failed', error: problem });
                          return;
                        }
                        void runQueue([{ ...row, description, status: 'failed' }]);
                      }}
                    >
                      重试这一张
                    </button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <label className="field" htmlFor="uploadCaption">
        说说这些照片背后的故事（可选）
      </label>
      <textarea
        id="uploadCaption"
        className="text-area"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        maxLength={300}
        placeholder="例如：傍晚从码头走回来，发现海面刚好变成金色。"
        data-testid="upload-description"
      />
      <div className="char-count">{description.length} / 300</div>

      <label className="consent" data-testid="exif-consent">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          data-testid="exif-consent-input"
        />
        <span>
          我知道：<strong>原始照片会被原样保存</strong>
          ，其他访客可以查看和下载；原图可能包含 GPS 位置和设备型号等 EXIF 信息。
        </span>
      </label>

      {rows.length > 0 ? (
        <div className="upload-summary" role="status" data-testid="upload-summary">
          {counts.success} 张成功
          {counts.failed > 0 ? `，${counts.failed} 张失败` : ''}
          {counts.pending > 0 ? `，${counts.pending} 张待上传` : ''}
        </div>
      ) : null}

      <div className="form-bottom">
        <p>
          一次最多 {limits.maxUploadBytes / (1024 * 1024)} MiB 一张，同时上传{' '}
          {limits.maxConcurrentUploads} 张。原图不会被压缩或重新编码。
        </p>
        <button
          className="btn-dark"
          type="button"
          disabled={submitting || !acknowledged || counts.pending === 0}
          onClick={submit}
          data-testid="upload-submit"
        >
          {submitting
            ? '正在上传…'
            : counts.success > 0 && counts.pending === 0
              ? '全部完成'
              : `分享这些照片　↗`}
        </button>
      </div>

      {counts.success > 0 && counts.pending === 0 && !submitting ? (
        <div className="form-bottom">
          <button
            className="btn-outline"
            type="button"
            onClick={() => {
              router.push(`/places/${placeSlug}/ranking`);
              router.refresh();
            }}
            data-testid="upload-view-ranking"
          >
            前往{placeName}照片榜 ↗
          </button>
        </div>
      ) : null}
    </div>
  );
}
