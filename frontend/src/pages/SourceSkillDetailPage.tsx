import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InstallSourcePreviewChannel, InstallSourcePreviewResult, InstallSourceReadFileResult } from '../../../backend/src/shared/ipc';
import { EmptyState } from '../components/EmptyState';
import { FileIcon } from '../components/icons';
import { request } from '../ipc/client';
import c from '../styles/common.module.css';
import d from './SkillDetailPage.module.css';
import s from './MarketSkillDetailPage.module.css';

interface SourceSkillDetailProps {
  channel: InstallSourcePreviewChannel;
  itemKey: string;
  fallbackName: string;
  installed: boolean;
  installing: boolean;
  notice: string;
  onBack: () => void;
  onInstall: () => void;
}

type FileState = { status: 'loading' } | { status: 'error'; error: string } | ({ status: 'ready' } & InstallSourceReadFileResult);

const SOURCE_LABEL: Record<InstallSourcePreviewChannel, string> = {
  git: 'Git 地址', local: '本地目录', archive: '压缩包', scan: '扫描本机',
};

/** 把文件路径转成可见的目录和文件行。 */
function treeRows(files: InstallSourcePreviewResult['files']): Array<{ path: string; name: string; depth: number; directory: boolean }> {
  const rows: Array<{ path: string; name: string; depth: number; directory: boolean }> = [];
  const seen = new Set<string>();
  const sorted = [...files].sort((left, right) => left.path === 'SKILL.md' ? -1 : right.path === 'SKILL.md' ? 1 : left.path.localeCompare(right.path));
  for (const file of sorted) {
    const segments = file.path.split('/');
    for (let index = 1; index < segments.length; index++) {
      const dirPath = segments.slice(0, index).join('/');
      if (seen.has(dirPath)) continue;
      seen.add(dirPath);
      rows.push({ path: dirPath, name: `${segments[index - 1]}/`, depth: index - 1, directory: true });
    }
    rows.push({ path: file.path, name: segments[segments.length - 1], depth: segments.length - 1, directory: false });
  }
  return rows;
}

/** 四个发现来源共用的只读详情，文件正文在选中时才读取。 */
export function SourceSkillDetailPage({ channel, itemKey, fallbackName, installed, installing, notice, onBack, onInstall }: SourceSkillDetailProps) {
  const [preview, setPreview] = useState<InstallSourcePreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const [retry, setRetry] = useState(0);
  const previewRequest = useRef(0);

  /** 加载当前发现条目的文件树；过期 key 显示明确错误。 */
  const loadPreview = useCallback(async () => {
    const current = ++previewRequest.current;
    setLoading(true);
    setError('');
    setPreview(null);
    setActive(null);
    const result = await request('install:sourcePreview', { channel, key: itemKey });
    if (current !== previewRequest.current) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.error.detail ?? result.error.code);
      return;
    }
    setPreview(result.data);
    setFiles({});
    setActive(result.data.files.find((file) => file.path.toLowerCase() === 'skill.md')?.path ?? result.data.files[0]?.path ?? null);
  }, [channel, itemKey]);

  useEffect(() => {
    void loadPreview();
    return () => { previewRequest.current++; };
  }, [loadPreview]);

  useEffect(() => {
    if (!preview || !active || files[active]?.status === 'ready') return;
    let cancelled = false;
    setFiles((current) => ({ ...current, [active]: { status: 'loading' } }));
    void request('install:sourceReadFile', { channel, key: itemKey, path: active }).then((result) => {
      if (cancelled) return;
      const next: FileState = result.ok
        ? { status: 'ready', ...result.data }
        : { status: 'error', error: result.error.detail ?? result.error.code };
      setFiles((current) => ({ ...current, [active]: next }));
    });
    return () => { cancelled = true; };
  }, [preview, active, channel, itemKey, retry]);

  const rows = useMemo(() => treeRows(preview?.files ?? []), [preview]);
  const currentFile = preview?.files.find((file) => file.path === active);
  const currentState = active ? files[active] : undefined;

  return <section className={d.page} data-testid="source-skill-detail">
    <header className={d.header}>
      <button type="button" className={d.back} onClick={onBack}>← 返回</button>
      <h1 className={d.title} title={preview?.name ?? fallbackName}>{preview?.name ?? fallbackName}</h1>
      <span className={d.sourceHint}>{SOURCE_LABEL[channel]}</span>
      <span className={c.toolbarSpacer} />
      <button type="button" className={`${c.btn} ${!installed ? c.btnPrimary : ''}`} disabled={installed || installing || loading || Boolean(error)} onClick={onInstall} data-testid="source-detail-install">
        {installing ? '安装中…' : installed ? '已入库' : '安装'}
      </button>
    </header>
    {notice ? <p className={s.notice} role="status">{notice}</p> : null}
    {loading ? <div className={d.bodyEmpty}><EmptyState title="正在读取 Skill…" /></div>
      : error ? <div className={s.errorBox}><EmptyState title="无法读取技能详情" desc={error} /><button type="button" className={c.btn} onClick={() => void loadPreview()}>重试</button></div>
      : preview ? <div className={d.body}>
        <aside className={d.treePanel} aria-label="文件树" data-testid="source-file-tree">
          <div className={d.treeHead}><span className={d.treeTitle}>文件树</span><span className={d.treeMeta}>{preview.fileCount} 个文件</span></div>
          <div className={d.treeScroll}>{rows.map((row) => row.directory
            ? <div key={`dir:${row.path}`} className={s.directory} style={{ paddingLeft: 14 + row.depth * 16 }} title={row.path}>{row.name}</div>
            : <button key={row.path} type="button" className={`${d.treeRow} ${active === row.path ? d.treeRowActive : ''}`} style={{ paddingLeft: 14 + row.depth * 16 }} title={row.path} onClick={() => setActive(row.path)} data-testid="source-file-row"><FileIcon size={13} /><span className={d.treeName}>{row.name}</span></button>)}</div>
        </aside>
        <div className={d.editorPanel}>
          <div className={d.fileBar}><span className={d.filePath} title={active ?? ''}>{active ?? '未打开文件'}</span><span className={c.toolbarSpacer} /><span className={d.fileMeta}>{currentFile ? `${currentFile.size.toLocaleString('zh-CN')} B` : ''}</span></div>
          <div className={d.editorBody}>
            {!active ? <div className={d.bodyEmpty}><EmptyState title="暂无可查看文件" /></div>
              : !currentState || currentState.status === 'loading' ? <div className={d.bodyEmpty}><EmptyState title="正在读取文件…" /></div>
              : currentState.status === 'error' ? <div className={s.fileError}><EmptyState title="无法读取该文件" desc={currentState.error} /><button type="button" className={c.btn} onClick={() => setRetry((count) => count + 1)}>重试</button></div>
              : currentState.content === null ? <div className={d.readOnlyBox}><p className={d.readOnlyTitle}>无法预览该文件</p><p className={d.readOnlyDesc}>{currentState.reason}</p></div>
              : <pre className={d.preview} data-testid="source-file-content">{currentState.content}</pre>}
          </div>
        </div>
      </div> : null}
  </section>;
}
