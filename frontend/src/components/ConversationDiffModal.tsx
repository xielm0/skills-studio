import { useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from 'diff';
import type { ConversationFileChangeResult, ConversationFileChangeView } from '../../../backend/src/shared/ipc';
import { request } from '../ipc/client';
import { Modal } from './Modal';
import s from './ConversationDiffModal.module.css';

type Row = { before?: string; after?: string; beforeLine?: number; afterLine?: number; changed: boolean };

function lines(text: string): string[] {
  if (!text) return [];
  const result = text.split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}

function pairedLines(before: string, after: string): Row[] {
  const rows: Row[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({
        before: removed[i], after: added[i],
        beforeLine: i < removed.length ? beforeLine++ : undefined,
        afterLine: i < added.length ? afterLine++ : undefined,
        changed: true,
      });
    }
    removed = [];
    added = [];
  };
  for (const part of diffLines(before, after)) {
    const partLines = lines(part.value);
    if (part.removed) removed.push(...partLines);
    else if (part.added) added.push(...partLines);
    else {
      flush();
      for (const text of partLines) rows.push({ before: text, after: text, beforeLine: beforeLine++, afterLine: afterLine++, changed: false });
    }
  }
  flush();
  return rows;
}

function visibleRows(rows: Row[], expanded: boolean): Array<Row | { folded: number }> {
  if (expanded) return rows;
  const visible: Array<Row | { folded: number }> = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].changed) { visible.push(rows[index++]); continue; }
    let end = index;
    while (end < rows.length && !rows[end].changed) end++;
    if (end - index > 9) {
      visible.push(...rows.slice(index, index + 3), { folded: end - index - 6 }, ...rows.slice(end - 3, end));
    } else visible.push(...rows.slice(index, end));
    index = end;
  }
  return visible;
}

function unavailable(side: ConversationFileChangeResult['before'], label: 'before' | 'after'): string {
  if (!side.exists) return label === 'before' ? '修改前无此文件' : '修改后无此文件';
  if (side.reason === 'TOO_LARGE') return '文件过大，无法逐行展示';
  if (side.reason === 'BINARY') return '二进制文件，无法逐行展示';
  return '此文件无法逐行展示';
}

export function ConversationDiffModal({ sessionId, runId, files, onClose }: {
  sessionId: string;
  runId: string;
  files: ConversationFileChangeView[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(files[0]?.relPath ?? '');
  const [detail, setDetail] = useState<ConversationFileChangeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const beforePane = useRef<HTMLDivElement>(null);
  const afterPane = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);
  const syncScroll = (side: 'before' | 'after') => {
    if (syncingScroll.current) return;
    const current = (side === 'before' ? beforePane : afterPane).current;
    const other = (side === 'before' ? afterPane : beforePane).current;
    if (!current || !other) return;
    syncingScroll.current = true;
    other.scrollTop = current.scrollTop;
    requestAnimationFrame(() => { syncingScroll.current = false; });
  };
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    setExpanded(false);
    for (const pane of [beforePane.current, afterPane.current]) {
      if (pane) pane.scrollTop = pane.scrollLeft = 0;
    }
    void request('conversation:fileChange', { sessionId, runId, relPath: selected }).then((result) => {
      if (!active) return;
      if (result.ok) setDetail(result.data);
      else setError(result.error.detail ?? '读取文件差异失败');
    });
    return () => { active = false; };
  }, [sessionId, runId, selected]);
  const rows = useMemo(() => detail &&
    (detail.before.content != null || !detail.before.exists) &&
    (detail.after.content != null || !detail.after.exists)
    ? pairedLines(detail.before.content ?? '', detail.after.content ?? '') : null, [detail]);
  const shown = useMemo(() => rows ? visibleRows(rows, expanded) : null, [rows, expanded]);
  const totals = files.reduce((count, file) => ({
    added: count.added + (file.added ?? 0), removed: count.removed + (file.removed ?? 0),
    unknown: count.unknown || file.added == null || file.removed == null,
  }), { added: 0, removed: 0, unknown: false });
  const renderSide = (side: 'before' | 'after') => {
    if (error) return side === 'before' ? <p className={s.note}>{error}</p> : null;
    if (!detail) return side === 'before' ? <p className={s.note}>正在读取差异…</p> : null;
    const snapshot = detail[side];
    if (!shown) return <pre className={s.unavailable}>{snapshot.content ?? unavailable(snapshot, side)}</pre>;
    return <div className={s.code}>{shown.map((row, index) => 'folded' in row ? (
      <button type="button" key={`fold-${index}`} className={s.fold} onClick={() => setExpanded(true)}>{row.folded} 行未修改 · 展开</button>
    ) : <div key={index} className={`${s.codeLine} ${row.changed ? side === 'before' ? s.deleted : s.inserted : ''}`}>
      <span className={s.lineNo}>{side === 'before' ? row.beforeLine : row.afterLine}</span>
      <span className={s.lineText}>{row[side]}</span>
    </div>)}</div>;
  };

  return <Modal title={`已编辑 ${files.length} 个文件`} desc={`+${totals.unknown ? '?' : totals.added}  −${totals.unknown ? '?' : totals.removed} · 运行结束时的净改动`}
    onClose={onClose} width={1200} fullscreen={fullscreen} closeIcon testId="conversation-diff-modal"
    headerActions={<button type="button" className={s.fullscreenButton} onClick={() => setFullscreen((value) => !value)}
      aria-label={fullscreen ? '退出全屏' : '全屏展示'} title={fullscreen ? '退出全屏' : '全屏展示'} aria-pressed={fullscreen}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {fullscreen ? <path d="M2 14 7 9M3 9h4v4M14 2 9 7M9 3v4h4" /> : <path d="M7 9 2 14M2 10v4h4M9 7l5-5M10 2h4v4" />}
      </svg>
    </button>}>
    <div className={`${s.layout} ${fullscreen ? s.layoutFullscreen : ''}`}>
      <aside className={s.files} aria-label="变更文件">
        <div className={s.filesTitle}>差异文件</div>
        {files.map((file) => <button type="button" key={file.relPath} className={`${s.file} ${selected === file.relPath ? s.selected : ''}`}
          onClick={() => setSelected(file.relPath)} title={file.relPath}>
          <span className={s.path}>{file.relPath}</span>
          <span className={s.count}><span className={s.added}>+{file.added ?? '?'}</span> <span className={s.removed}>−{file.removed ?? '?'}</span></span>
        </button>)}
      </aside>
      <div className={s.comparison}>
        <div ref={beforePane} className={s.pane} onScroll={() => syncScroll('before')}>
          <div className={s.paneTitle}>修改前</div>{renderSide('before')}
        </div>
        <div ref={afterPane} className={s.pane} onScroll={() => syncScroll('after')}>
          <div className={s.paneTitle}>修改后</div>{renderSide('after')}
        </div>
      </div>
    </div>
  </Modal>;
}
