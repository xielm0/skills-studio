import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InstallMarketFile, InstallMarketPreviewResult, InstallMarketReadFileResult } from '../../../backend/src/shared/ipc';
import { EmptyState } from '../components/EmptyState';
import { FileIcon } from '../components/icons';
import { request } from '../ipc/client';
import c from '../styles/common.module.css';
import d from './SkillDetailPage.module.css';
import s from './MarketSkillDetailPage.module.css';

interface MarketSkillDetailProps {
  source: string;
  skillId: string;
  marketKey: string;
  fallbackName: string;
  installed: boolean;
  installing: boolean;
  notice: string;
  onBack: () => void;
  onInstall: (name: string) => void;
}

type FileState = { status: 'loading' } | { status: 'error'; error: string } | ({ status: 'ready' } & InstallMarketReadFileResult);

/** 将市场文件清单展开成按目录分组的只读文件树。 */
function treeRows(files: InstallMarketFile[]): Array<{ path: string; name: string; depth: number; directory: boolean; size: number }> {
  const rows: Array<{ path: string; name: string; depth: number; directory: boolean; size: number }> = [];
  const seen = new Set<string>();
  const sorted = [...files].sort((left, right) => left.path === 'SKILL.md' ? -1 : right.path === 'SKILL.md' ? 1 : left.path.localeCompare(right.path));
  for (const file of sorted) {
    const segments = file.path.split('/');
    for (let index = 1; index < segments.length; index++) {
      const path = segments.slice(0, index).join('/');
      if (seen.has(path)) continue;
      seen.add(path);
      rows.push({ path, name: `${segments[index - 1]}/`, depth: index - 1, directory: true, size: 0 });
    }
    rows.push({ path: file.path, name: segments[segments.length - 1], depth: segments.length - 1, directory: false, size: file.size });
  }
  return rows;
}

/** 市场 Skill 只读详情：打开时取文件树，切换文件时才读取对应正文。 */
export function MarketSkillDetailPage({ source, skillId, marketKey, fallbackName, installed, installing, notice, onBack, onInstall }: MarketSkillDetailProps) {
  const [preview, setPreview] = useState<InstallMarketPreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const [fileRetry, setFileRetry] = useState(0);
  const previewRequest = useRef(0);

  /** 重新加载文件树时丢弃旧条目的异步结果。 */
  const loadPreview = useCallback(async () => {
    const current = ++previewRequest.current;
    setLoading(true);
    setError('');
    setPreview(null);
    setActive(null);
    const result = await request('install:marketPreview', { source, skillId });
    if (current !== previewRequest.current) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.error.detail ?? result.error.code);
      return;
    }
    setPreview(result.data);
    setFiles({});
    setActive(result.data.files.find((file) => file.path === 'SKILL.md')?.path ?? result.data.files[0]?.path ?? null);
  }, [source, skillId]);

  useEffect(() => {
    void loadPreview();
    return () => { previewRequest.current++; };
  }, [loadPreview]);

  useEffect(() => {
    if (!active || !preview || files[active]?.status === 'ready') return;
    let cancelled = false;
    setFiles((current) => ({ ...current, [active]: { status: 'loading' } }));
    void request('install:marketReadFile', { source, skillId, path: active }).then((result) => {
      if (cancelled) return;
      const next: FileState = result.ok
        ? { status: 'ready', ...result.data }
        : { status: 'error', error: result.error.detail ?? result.error.code };
      setFiles((current) => ({ ...current, [active]: next }));
    });
    return () => { cancelled = true; };
  }, [active, source, skillId, preview, fileRetry]);

  const rows = useMemo(() => treeRows(preview?.files ?? []), [preview]);
  const activeFile = preview?.files.find((file) => file.path === active);
  const fileState = active ? files[active] : undefined;

  return <section className={d.page} data-testid="market-skill-detail">
    <header className={d.header}>
      <button type="button" className={d.back} onClick={onBack}>← 返回</button>
      <h1 className={d.title} title={preview?.name ?? fallbackName}>{preview?.name ?? fallbackName}</h1>
      <span className={d.sourceHint} title={source}>{source}</span>
      <span className={c.toolbarSpacer} />
      <button type="button" className={`${c.btn} ${!installed ? c.btnPrimary : ''}`} disabled={!marketKey || installing || installed} onClick={() => onInstall(preview?.name ?? fallbackName)} data-testid="market-detail-install">
        {installing ? '安装中…' : installed ? '已入库' : '安装'}
      </button>
    </header>
    {notice ? <p className={s.notice} role="status">{notice}</p> : null}
    {preview?.stale ? <p className={s.warning} role="status">{preview.warning ?? '展示的是缓存内容，可能过期'}</p> : null}
    {loading ? <div className={d.bodyEmpty}><EmptyState title="正在读取市场 Skill…" /></div>
      : error ? <div className={s.errorBox}><EmptyState title="无法读取技能详情" desc={error} /><button type="button" className={c.btn} onClick={() => void loadPreview()}>重试</button></div>
      : preview ? <div className={d.body}>
        <aside className={d.treePanel} aria-label="文件树" data-testid="market-file-tree">
          <div className={d.treeHead}><span className={d.treeTitle}>文件树</span><span className={d.treeMeta}>{preview.fileCount} 个文件</span></div>
          <div className={d.treeScroll}>{rows.map((row) => row.directory
            ? <div key={`dir:${row.path}`} className={s.directory} style={{ paddingLeft: 14 + row.depth * 16 }} title={row.path}>{row.name}</div>
            : <button key={row.path} type="button" className={`${d.treeRow} ${active === row.path ? d.treeRowActive : ''}`} style={{ paddingLeft: 14 + row.depth * 16 }} onClick={() => setActive(row.path)} title={row.path} data-testid="market-file-row"><FileIcon size={13} /><span className={d.treeName}>{row.name}</span></button>)}</div>
        </aside>
        <div className={d.editorPanel}>
          <div className={d.fileBar}><span className={d.filePath} title={active ?? ''}>{active ?? '未打开文件'}</span><span className={c.toolbarSpacer} /><span className={d.fileMeta}>{activeFile ? `${activeFile.size.toLocaleString('zh-CN')} B` : ''}</span></div>
          <div className={d.editorBody}>
            {!active ? <div className={d.bodyEmpty}><EmptyState title="暂无可查看文件" /></div>
              : !fileState || fileState.status === 'loading' ? <div className={d.bodyEmpty}><EmptyState title="正在读取文件…" /></div>
              : fileState.status === 'error' ? <div className={s.fileError}><EmptyState title="无法读取该文件" desc={fileState.error} /><button type="button" className={c.btn} onClick={() => setFileRetry((count) => count + 1)}>重试</button></div>
              : fileState.content === null ? <div className={d.readOnlyBox}><p className={d.readOnlyTitle}>无法预览该文件</p><p className={d.readOnlyDesc}>{fileState.reason}</p></div>
              : <pre className={d.preview} data-testid="market-file-content">{fileState.content}</pre>}
          </div>
        </div>
      </div> : null}
  </section>;
}
