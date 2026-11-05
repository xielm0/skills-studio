import { useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from 'diff';
import type { LibraryReadFileResult, LibrarySyncDecision, LibrarySyncDiffResult, LibrarySyncPlanItem } from '../../../backend/src/shared/ipc';
import { request } from '../ipc/client';
import { Modal } from './Modal';
import c from '../styles/common.module.css';
import s from './SyncDiffModal.module.css';

type FileEntry = LibrarySyncDiffResult['files'][number];
type DiffRow = { source?: string; target?: string; sourceLine?: number; targetLine?: number; changed: boolean };

function lines(value: string): string[] {
  if (!value) return [];
  const parts = value.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

/** Pair removed and added lines within each changed hunk for side-by-side reading. */
function pairedLines(source: string, target: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let sourceLine = 1;
  let targetLine = 1;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({
        source: removed[i], target: added[i],
        sourceLine: i < removed.length ? sourceLine++ : undefined,
        targetLine: i < added.length ? targetLine++ : undefined,
        changed: true,
      });
    }
    removed = [];
    added = [];
  };
  for (const part of diffLines(source, target)) {
    const partLines = lines(part.value);
    if (part.removed) removed.push(...partLines);
    else if (part.added) added.push(...partLines);
    else {
      flush();
      for (const text of partLines) rows.push({ source: text, target: text, sourceLine: sourceLine++, targetLine: targetLine++, changed: false });
    }
  }
  flush();
  return rows;
}

function unavailable(file: LibraryReadFileResult | null): string {
  if (!file) return '此版本中无此文件';
  if (file.reason === 'BINARY') return '二进制文件，无法逐行显示';
  if (file.reason === 'TOO_LARGE') return '文件过大，无法逐行显示';
  return '链接或非普通文件，无法逐行显示';
}

function formatMtime(value: string | null | undefined): string {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

export function SyncDiffModal({ item, onClose, onDecision }: {
  item: LibrarySyncPlanItem;
  onClose: () => void;
  onDecision: (choice: LibrarySyncDecision['choice']) => Promise<boolean>;
}) {
  return <SkillDiffModal
    title={`${item.dirName} → ${item.agentName} · 差异`}
    sourceLabel="中心库版本"
    targetLabel={`${item.agentName} 当前版本`}
    footerHint={`中心库 → ${item.agentName}，覆盖或跳过将应用于整个 Skill`}
    comparisonKey={`${item.skillId}\0${item.agentId}\0${item.fingerprint}\0${item.sourceHash}`}
    loadDiff={async (relPath) => {
      const result = await request('library:syncDiff', {
        skillId: item.skillId, agentId: item.agentId,
        fingerprint: item.fingerprint ?? '', sourceHash: item.sourceHash ?? '', relPath,
      });
      if (!result.ok) throw new Error(result.error.detail ?? '读取差异失败');
      return result.data;
    }}
    onClose={onClose}
    onDecision={(choice) => onDecision(choice)}
  />;
}

export interface SkillDiffSnapshot extends LibrarySyncDiffResult {
  sourceHash?: string;
  targetHash?: string;
}

export function SkillDiffModal({ title, sourceLabel, targetLabel, comparisonKey, footerHint = '覆盖或跳过将应用于整个 Skill', loadDiff, onClose, onDecision }: {
  title: string;
  sourceLabel: string;
  targetLabel: string;
  comparisonKey: string;
  /** 页脚提示；调用方需带上覆盖方向（如「本地库 → 中心库」），各处方向不同。 */
  footerHint?: string;
  loadDiff: (relPath?: string) => Promise<SkillDiffSnapshot>;
  onClose: () => void;
  onDecision: (choice: LibrarySyncDecision['choice'], snapshot: SkillDiffSnapshot) => Promise<boolean>;
}) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [snapshot, setSnapshot] = useState<SkillDiffSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<LibrarySyncDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const sourcePane = useRef<HTMLDivElement>(null);
  const targetPane = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);
  const loadDiffRef = useRef(loadDiff);
  loadDiffRef.current = loadDiff;

  const syncScroll = (from: 'source' | 'target') => {
    if (syncingScroll.current) return;
    const current = (from === 'source' ? sourcePane : targetPane).current;
    const other = (from === 'source' ? targetPane : sourcePane).current;
    if (!current || !other) return;
    syncingScroll.current = true;
    other.scrollTop = current.scrollTop;
    other.scrollLeft = current.scrollLeft;
    requestAnimationFrame(() => { syncingScroll.current = false; });
  };

  useEffect(() => {
    let active = true;
    void loadDiffRef.current().then((result) => {
      if (!active) return;
      if (result.stale) setError('内容已变化，请关闭后重新检查');
      else {
        setSnapshot(result);
        setFiles(result.files);
        setSelected(result.files[0]?.relPath ?? null);
      }
    }).catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [comparisonKey]);

  useEffect(() => {
    if (selected == null) return;
    let active = true;
    setDetail(null);
    if (sourcePane.current) sourcePane.current.scrollTop = sourcePane.current.scrollLeft = 0;
    if (targetPane.current) targetPane.current.scrollTop = targetPane.current.scrollLeft = 0;
    void loadDiffRef.current(selected).then((result) => {
      if (!active) return;
      if (result.stale) setError('内容已变化，请关闭后重新检查');
      else setDetail(result);
    }).catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [selected, comparisonKey]);

  const rows = useMemo(() => detail?.source?.content != null || detail?.target?.content != null
    ? pairedLines(detail.source?.content ?? '', detail.target?.content ?? '') : null, [detail]);

  const decide = async (choice: LibrarySyncDecision['choice']) => {
    setBusy(true);
    try {
      const completed = snapshot != null && await onDecision(choice, snapshot);
      if (!completed) setError('处理未完成，请重新查看差异');
    } catch (err) {
      setError(err instanceof Error ? err.message : '处理失败');
    } finally {
      setBusy(false);
    }
  };

  const renderCell = (file: LibraryReadFileResult | null, side: 'source' | 'target') => {
    if (file?.content == null) return <div className={s.unavailable}>{unavailable(file)}</div>;
    if (rows == null) return <div className={s.unavailable}>另一侧无法逐行显示</div>;
    return <div className={s.code}>{rows.map((row, index) => <div key={index} className={`${s.codeLine} ${row.changed ? side === 'source' ? s.sourceChanged : s.targetChanged : ''}`}>
      <span className={s.lineNo}>{side === 'source' ? row.sourceLine : row.targetLine}</span>
      <span className={s.lineText}>{side === 'source' ? row.source : row.target}</span>
    </div>)}</div>;
  };

  return <Modal
    title={title}
    onClose={() => { if (!busy) onClose(); }}
    width={1100}
    fullscreen={fullscreen}
    closeIcon
    headerActions={<button type="button" className={s.fullscreenButton} onClick={() => setFullscreen((current) => !current)} aria-label={fullscreen ? '退出全屏' : '全屏展示'} title={fullscreen ? '退出全屏' : '全屏展示'} aria-pressed={fullscreen}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {fullscreen ? <path d="M2 14 7 9M3 9h4v4M14 2 9 7M9 3v4h4" /> : <path d="M7 9 2 14M2 10v4h4M9 7l5-5M10 2h4v4" />}
      </svg>
    </button>}
    testId="library-sync-diff-modal"
    footer={<>
    <span className={s.footerHint}>{footerHint}</span>
    <button type="button" className={c.btn} onClick={() => void decide('skip')} disabled={busy || Boolean(error)}>跳过</button>
    <button type="button" className={`${c.btn} ${c.btnPrimary}`} onClick={() => void decide('overwrite')} disabled={busy || Boolean(error)}>覆盖</button>
  </>}>
    <div className={`${s.layout} ${fullscreen ? s.layoutFullscreen : ''}`}>
      <aside className={s.files} aria-label="差异文件">
        <div className={s.filesTitle}>差异文件</div>
        {files == null && !error ? <p className={s.message}>正在比较…</p> : null}
        {files?.length === 0 ? <p className={s.message}>没有可显示的文件差异（内容一致，或仅行尾符不同）</p> : null}
        {files?.map((file) => <button type="button" key={file.relPath} className={`${s.file} ${selected === file.relPath ? s.fileSelected : ''}`} onClick={() => { setError(null); setSelected(file.relPath); }} title={file.relPath}>
          <span className={file.status === 'added' ? s.added : file.status === 'removed' ? s.removed : s.modified}>{file.status === 'added' ? '+' : file.status === 'removed' ? '−' : '~'}</span>
          <span className={s.fileName}>{file.relPath === '__agent_root_file__' ? 'Agent 同名文件' : file.relPath}</span>
        </button>)}
      </aside>
      <div className={s.comparison}>
        <div ref={sourcePane} className={s.column} onScroll={() => syncScroll('source')}><div className={s.columnTitle}>{sourceLabel}<span className={s.mtime} title={snapshot?.sourceMtime ?? undefined}>mtime {formatMtime(snapshot?.sourceMtime)}</span></div>{error ? <div className={s.unavailable}>{error}</div> : selected && detail ? renderCell(detail.source, 'source') : null}</div>
        <div ref={targetPane} className={s.column} onScroll={() => syncScroll('target')}><div className={s.columnTitle}>{targetLabel}<span className={s.mtime} title={snapshot?.targetMtime ?? undefined}>mtime {formatMtime(snapshot?.targetMtime)}</span></div>{error ? null : selected && detail ? renderCell(detail.target, 'target') : null}</div>
      </div>
    </div>
  </Modal>;
}
