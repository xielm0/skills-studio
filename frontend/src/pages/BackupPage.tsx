import { useCallback, useEffect, useState } from 'react';
import type { IpcError, SyncStatusResult } from '../../../backend/src/shared/ipc';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { request } from '../ipc/client';
import c from '../styles/common.module.css';
import s from './BackupPage.module.css';

type Tone = 'ok' | 'error';

/** 操作反馈就地显示在所属卡片下方：commit → 本地卡片，connect/pull/push → 远程卡片 */
interface Feedback {
  tone: Tone;
  text: string;
  scope: 'local' | 'remote';
}

function errorText(error: IpcError | undefined): string {
  if (!error) return '操作失败，请重试';
  return error.detail ?? error.code;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 状态行只放短结果，完整说明在悬停提示里（避免一行被长文案挤成两行）。 */
function operationLabel(status: string): string {
  switch (status) {
    case 'pulled':
      return '已拉取';
    case 'up-to-date':
      return '无变化';
    case 'pushed':
      return '已推送';
    case 'rejected':
      return '被拒绝';
    default:
      return status;
  }
}

function operationText(operation: SyncStatusResult['lastPull']): string {
  if (!operation) return '—';
  return `${formatTime(operation.at)} · ${operationLabel(operation.status)}`;
}

/**
 * 备份 Skills（ui.md「备份 Skills」，两卡片极简版）：
 *  - 本质是 git 操作的快捷方式，复杂操作（查历史、回滚、解冲突）由用户自行用 git 完成；
 *  - 卡片 1「本地备份」：最近一次本地提交（时间 + 版本号）+「本地备份」按钮（git add -A + commit）；
 *  - 卡片 2「远程备份或恢复」：远端地址连接 + Pull / Push；
 *  - 操作结果与错误就地显示在所在卡片下方，不给额外交互入口。
 */
export function BackupPage() {
  const [status, setStatus] = useState<SyncStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'connect' | 'commit' | 'pull' | 'push' | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [editingUrl, setEditingUrl] = useState(false);

  const connected = status?.connected ?? false;
  const gitAvailable = status?.gitAvailable ?? true;
  const operatorBusy = busy !== null;
  const lastCommit = status?.lastCommit ?? null;

  const loadStatus = useCallback(async () => {
    const result = await request('sync:status');
    if (!result.ok) {
      setLoadError(errorText(result.error));
      return;
    }
    setStatus(result.data);
    setUrlDraft((prev) => (prev.trim().length > 0 ? prev : (result.data.remoteUrl ?? '')));
    setLoadError(null);
  }, []);

  useEffect(() => {
    void (async () => {
      await loadStatus();
      setLoading(false);
    })();
  }, [loadStatus]);

  async function connectRemote() {
    if (busy) return;
    const url = urlDraft.trim();
    if (!url) {
      setFeedback({ tone: 'error', text: '请先填写 Git 远端地址', scope: 'remote' });
      return;
    }
    setBusy('connect');
    setFeedback(null);
    try {
      const result = await request('sync:connect', { url });
      if (!result.ok) {
        setFeedback({ tone: 'error', text: errorText(result.error), scope: 'remote' });
        return;
      }
      setStatus(result.data);
      setEditingUrl(false);
      setFeedback({ tone: 'ok', text: result.data.notice ?? '已连接远端', scope: 'remote' });
      await loadStatus();
    } finally {
      setBusy(null);
    }
  }

  /** 本地备份：git add -A + git commit（不触碰远端）。 */
  async function runCommit() {
    if (busy) return;
    setBusy('commit');
    setFeedback(null);
    try {
      const result = await request('sync:commit', {});
      if (!result.ok) {
        setFeedback({ tone: 'error', text: errorText(result.error), scope: 'local' });
        return;
      }
      setFeedback({ tone: 'ok', text: result.data.message, scope: 'local' });
      await loadStatus();
    } finally {
      setBusy(null);
    }
  }

  async function runPull() {
    if (busy || !connected || !gitAvailable) return;
    setBusy('pull');
    setFeedback(null);
    try {
      const result = await request('sync:pull');
      if (!result.ok) {
        setFeedback({ tone: 'error', text: errorText(result.error), scope: 'remote' });
        await loadStatus();
        return;
      }
      setFeedback({ tone: 'ok', text: result.data.message, scope: 'remote' });
      await loadStatus();
    } finally {
      setBusy(null);
    }
  }

  async function runPush() {
    if (busy || !connected || !gitAvailable) return;
    setBusy('push');
    setFeedback(null);
    try {
      const result = await request('sync:push');
      if (!result.ok) {
        setFeedback({ tone: 'error', text: errorText(result.error), scope: 'remote' });
        await loadStatus();
        return;
      }
      // 被拒绝是失败态（远端领先），按错误呈现，避免绿色成功样式误导
      setFeedback({
        tone: result.data.status === 'rejected' ? 'error' : 'ok',
        text: result.data.message,
        scope: 'remote',
      });
      await loadStatus();
    } finally {
      setBusy(null);
    }
  }

  const editable = !connected || editingUrl;

  return (
    <section className={`${c.page} ${c.boundedPage}`}>
      <PageHeader title="备份 Skills" />

      <div className={c.content}>
        {loading ? (
          <div className={s.center} data-testid="sync-loading">
            <EmptyState title="正在读取备份状态…" />
          </div>
        ) : loadError && !status ? (
          <div className={s.errorBox} data-testid="sync-error">
            <p className={s.errorTitle}>无法读取备份状态</p>
            <p className={s.errorText}>{loadError}</p>
            <button
              type="button"
              className={c.btn}
              onClick={() => {
                setLoading(true);
                void loadStatus().then(() => setLoading(false));
              }}
              data-testid="sync-retry"
            >
              重试
            </button>
          </div>
        ) : (
          <>
            {/* 卡片 1：本地备份（git add -A + commit） */}
            <div className={c.card} data-testid="sync-local-card">
              <div className={s.cardHead}>
                <span className={s.cardTitle}>本地备份</span>
                <span className={c.toolbarSpacer} />
                <button
                  type="button"
                  className={`${c.btn} ${c.btnPrimary}`}
                  onClick={() => void runCommit()}
                  disabled={!gitAvailable || operatorBusy}
                  data-testid="sync-commit"
                >
                  {busy === 'commit' ? '正在备份…' : '本地备份'}
                </button>
              </div>
              <div className={s.localMeta} data-testid="sync-last-commit" title={lastCommit?.message}>
                {lastCommit ? (
                  <>
                    <span>最近备份时间：{formatTime(lastCommit.time)}</span>
                    <span className={s.localSha}>{lastCommit.shortSha}</span>
                  </>
                ) : (
                  <span>（尚未备份）</span>
                )}
              </div>
              {feedback?.scope === 'local' ? (
                <div
                  className={`${s.feedback} ${feedback.tone === 'ok' ? s.feedbackOk : s.feedbackError}`}
                  role="status"
                  data-testid="sync-commit-feedback"
                  data-tone={feedback.tone}
                >
                  <div className={s.feedbackText}>{feedback.text}</div>
                </div>
              ) : null}
            </div>

            {/* 卡片 2：远程备份或恢复（连接远端 + Pull / Push） */}
            <div className={c.card} data-testid="sync-remote-card">
              <div className={s.cardHead}>
                <span className={s.cardTitle}>远程备份或恢复</span>
              </div>

              <div className={s.repoRow}>
                <span className={s.label}>Git 仓库</span>
                <input
                  className={`${c.input} ${c.inputGrow}`}
                  value={editable ? urlDraft : (status?.remoteUrl ?? '')}
                  onChange={(event) => {
                    setUrlDraft(event.target.value);
                    if (connected && !editingUrl) setEditingUrl(true);
                  }}
                  placeholder="远端地址（https://…、git@… 或本地仓库路径）"
                  aria-label="Git 远端地址"
                  disabled={!editable || operatorBusy}
                  data-testid="sync-repo-input"
                />
                {connected && !editingUrl ? (
                  <button
                    type="button"
                    className={c.btn}
                    onClick={() => {
                      setUrlDraft(status?.remoteUrl ?? '');
                      setEditingUrl(true);
                    }}
                    disabled={operatorBusy}
                    data-testid="sync-change"
                  >
                    更改
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className={`${c.btn} ${c.btnPrimary}`}
                      onClick={() => void connectRemote()}
                      disabled={operatorBusy || !gitAvailable}
                      data-testid="sync-connect"
                    >
                      {busy === 'connect' ? '连接中…' : connected ? '保存' : '连接'}
                    </button>
                    {connected ? (
                      <button
                        type="button"
                        className={c.btn}
                        onClick={() => {
                          setEditingUrl(false);
                          setUrlDraft(status?.remoteUrl ?? '');
                        }}
                        disabled={operatorBusy}
                        data-testid="sync-cancel-url"
                      >
                        取消
                      </button>
                    ) : null}
                  </>
                )}
              </div>

              <div className={s.statusRow}>
                <span className={s.connection} data-testid="sync-connection">
                  <span className={`${c.dot} ${connected ? c.dotOk : c.dotOff}`} aria-hidden="true" />
                  {connected ? '已连接' : '未连接'}
                </span>
                <span className={c.meta} data-testid="sync-last-pull" title={status?.lastPull?.message}>
                  最近 Pull：{operationText(status?.lastPull ?? null)}
                </span>
                <span className={c.meta} data-testid="sync-last-push" title={status?.lastPush?.message}>
                  最近 Push：{operationText(status?.lastPush ?? null)}
                </span>
                <span className={c.toolbarSpacer} />
                {busy === 'pull' || busy === 'push' ? (
                  <span className={s.progress} role="status" data-testid="sync-progress">
                    {busy === 'pull' ? '正在 Pull…' : '正在 Push…'}
                  </span>
                ) : null}
                <button
                  type="button"
                  className={c.btn}
                  onClick={() => void runPull()}
                  disabled={!connected || !gitAvailable || operatorBusy}
                  data-testid="sync-pull"
                >
                  Pull
                </button>
                <button
                  type="button"
                  className={`${c.btn} ${c.btnPrimary}`}
                  onClick={() => void runPush()}
                  disabled={!connected || !gitAvailable || operatorBusy}
                  data-testid="sync-push"
                >
                  Push
                </button>
              </div>

              {feedback?.scope === 'remote' ? (
                <div
                  className={`${s.feedback} ${feedback.tone === 'ok' ? s.feedbackOk : s.feedbackError}`}
                  role="status"
                  data-testid="sync-feedback"
                  data-tone={feedback.tone}
                >
                  <div className={s.feedbackText}>{feedback.text}</div>
                </div>
              ) : status?.notice ? (
                <p className={s.notice} data-testid="sync-notice">
                  {status.notice}
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
