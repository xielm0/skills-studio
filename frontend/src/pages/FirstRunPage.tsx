import { useEffect, useMemo, useState } from 'react';
import type {
  AgentView,
  FirstRunImportResult,
  FirstRunScanResult,
  IpcError,
  InitialStateResult,
} from '../../../backend/src/shared/ipc';
import { request } from '../ipc/client';
import { navigate } from '../router';
import c from '../styles/common.module.css';
import s from './FirstRunPage.module.css';

interface FirstRunPageProps {
  initialState: InitialStateResult;
  /** 更改中心库位置成功后同步外壳显示 */
  onLibraryPathChange: (libraryPath: string) => void;
  /** 首启完成 → 外壳切到主页 */
  onComplete: () => void;
}

function errorText(error: IpcError | undefined): string {
  if (!error) return '操作失败';
  return error.detail ?? error.code;
}

/**
 * 首次启动（ui.md「首次启动」）：
 * 欢迎 → 确认中心库位置 → 扫描已检测 Agent → 默认全选 → 导入选中项 → 进入主页。
 * 首启只执行一次（flag 由主进程持久化）；「从备份恢复」进入备份页。
 */
export function FirstRunPage({ initialState, onLibraryPathChange, onComplete }: FirstRunPageProps) {
  const [libraryPath, setLibraryPath] = useState(initialState.libraryPath);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<FirstRunScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<FirstRunImportResult | null>(null);

  useEffect(() => {
    let alive = true;
    void request('agents:list').then((result) => {
      if (!alive) return;
      if (result.ok) setAgents(result.data.agents);
      setAgentsLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const detected = useMemo(() => agents.filter((a) => a.installed && a.enabled), [agents]);
  const allKeys = useMemo(() => scan?.items.map((item) => item.key) ?? [], [scan]);
  const allSelected = allKeys.length > 0 && allKeys.every((key) => selected.has(key));

  async function changeLocation() {
    if (picking) return;
    setError(null);
    setNotice(null);
    setPicking(true);
    try {
      const picked = await request('app:pickDirectory', { title: '选择中心技能库位置', defaultPath: libraryPath });
      if (!picked.ok) {
        setError(errorText(picked.error));
        return;
      }
      if (!picked.data.path) return;
      const target = picked.data.path;
      const result = await request('library:changeDirectory', { targetDir: target, policy: 'empty' });
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      if (result.data.status === 'moved') {
        setLibraryPath(result.data.libraryPath);
        onLibraryPathChange(result.data.libraryPath);
        setNotice('中心库位置已更新');
        // 位置变了：上一次扫描结果（若有）不再可靠
        setScan(null);
        setSelected(new Set());
        setImported(null);
        return;
      }
      if (result.data.status === 'needs-policy' || result.data.errorCode === 'TARGET_NOT_EMPTY') {
        setError('所选目录不是空目录：请选择空目录作为中心技能库位置');
        return;
      }
      setError(result.data.error ?? '更改位置失败');
    } finally {
      setPicking(false);
    }
  }

  async function startScan() {
    if (scanning) return;
    setError(null);
    setNotice(null);
    setScanning(true);
    setImported(null);
    try {
      const result = await request('firstRun:scan');
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      setScan(result.data);
      // ui.md：扫描结果默认全选
      setSelected(new Set(result.data.items.map((item) => item.key)));
    } finally {
      setScanning(false);
    }
  }

  function toggleAll(next: boolean) {
    setSelected(next ? new Set(allKeys) : new Set());
  }

  function toggleItem(key: string) {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (copy.has(key)) copy.delete(key);
      else copy.add(key);
      return copy;
    });
  }

  async function importSelected() {
    if (importing || selected.size === 0) return;
    setError(null);
    setImporting(true);
    try {
      const result = await request('firstRun:import', { keys: [...selected] });
      if (!result.ok) {
        setError(errorText(result.error));
        return;
      }
      setImported(result.data);
      setNotice(null);
    } finally {
      setImporting(false);
    }
  }

  async function finish() {
    const result = await request('firstRun:complete');
    if (!result.ok) {
      setError(errorText(result.error));
      return;
    }
    onComplete();
  }

  const failures = imported?.items.filter((item) => item.status === 'failed') ?? [];

  return (
    <div className={s.root}>
      <div className={s.sheet}>
        <h1 className={s.welcome}>欢迎使用 Skills 工作台</h1>
        <p className={s.lead}>
          把散落在各个 Agent 目录里的 Skills 收进一个中心库，再统一同步到需要的 Agent。
        </p>

        <section className={s.block}>
          <h2 className={s.blockTitle}>中心技能库</h2>
          <div className={s.pathRow}>
            <code className={s.path} title={libraryPath}>
              {libraryPath}
            </code>
            <button
              type="button"
              className={c.btn}
              onClick={() => void changeLocation()}
              disabled={picking}
              data-testid="first-run-change-location"
            >
              {picking ? '选择中…' : '更改位置'}
            </button>
          </div>
        </section>

        <p className={s.detected}>
          {agentsLoaded
            ? detected.length > 0
              ? `已检测到的 Agent：${detected.map((a) => a.name).join('、')}`
              : '未检测到已安装的 Agent：跳过扫描后可在设置中配置 Agent 目录。'
            : '正在检测本机 Agent…'}
        </p>

        <div className={s.actions}>
          <button
            type="button"
            className={`${c.btn} ${c.btnPrimary}`}
            onClick={() => void startScan()}
            disabled={scanning}
            data-testid="first-run-start"
          >
            {scanning ? '正在扫描…' : '扫描本机 Skills 开始'}
          </button>
          <button type="button" className={c.btn} onClick={() => navigate('backup')} data-testid="first-run-restore">
            从备份恢复
          </button>
        </div>

        {notice ? <p className={s.notice}>{notice}</p> : null}
        {error ? <p className={s.error}>{error}</p> : null}

        {scan ? (
          <section className={s.block} data-testid="first-run-scan">
            <div className={s.scanHead}>
              <h2 className={s.blockTitle}>扫描结果</h2>
              <span className={s.scanCount}>共 {scan.items.length} 个 · 来自 {scan.agentCount} 个 Agent</span>
            </div>

            {scan.items.length === 0 ? (
              <div className={s.emptyBlock}>
                <p className={s.empty}>
                  已检测的 Agent 目录中没有发现 Skills。你可以直接进入主页，稍后在「安装 Skills」中扫描本机。
                </p>
                <button
                  type="button"
                  className={`${c.btn} ${c.btnPrimary}`}
                  onClick={() => void finish()}
                  data-testid="first-run-finish"
                >
                  进入主页
                </button>
              </div>
            ) : (
              <>
                <label className={s.selectAll}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(event) => toggleAll(event.target.checked)}
                    data-testid="first-run-select-all"
                  />
                  全选（默认全选）
                </label>
                <ul className={s.list}>
                  {scan.items.map((item) => (
                    <li key={item.key} className={s.listRow}>
                      <label className={s.listLabel}>
                        <input
                          type="checkbox"
                          checked={selected.has(item.key)}
                          onChange={() => toggleItem(item.key)}
                          disabled={imported != null}
                        />
                        <span className={s.itemName}>{item.name}</span>
                        <span className={s.itemDesc}>{item.description || '（无描述）'}</span>
                        <span className={s.itemFrom}>来自 {item.agentLabel}</span>
                        {item.inLibrary ? <span className={s.itemTag}>已入库</span> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className={s.scanFooter}>
              <span className={s.selectedCount}>
                已选 {selected.size} 个
                {importing ? ' · 正在导入…' : ''}
              </span>
              <span className={s.scanFooterActions}>
                {scan.items.length > 0 && selected.size === 0 && imported == null ? (
                  <button type="button" className={c.btnGhost} onClick={() => void finish()}>
                    跳过导入，进入主页
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`${c.btn} ${c.btnPrimary}`}
                  onClick={() => void importSelected()}
                  disabled={importing || selected.size === 0 || imported != null}
                  data-testid="first-run-import"
                >
                  导入选中项
                </button>
              </span>
            </div>

            {imported ? (
              <div className={s.result} data-testid="first-run-result">
                <p className={s.resultSummary}>
                  已入库 {imported.summary.imported} 个 · 跳过 {imported.summary.skipped} 个 · 失败{' '}
                  {imported.summary.failed} 个
                </p>
                {failures.length > 0 ? (
                  <ul className={s.failureList}>
                    {failures.map((failure) => (
                      <li key={failure.key}>
                        导入失败：{failure.name}
                        {failure.agentLabel ? `（来自 ${failure.agentLabel}）` : ''} · {failure.reason ?? '未知原因'}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className={s.resultHint}>导入不会自动同步到 Agent，可在主页或 Skills 中心库中按需同步。</p>
                <div className={s.resultActions}>
                  <button
                    type="button"
                    className={`${c.btn} ${c.btnPrimary}`}
                    onClick={() => void finish()}
                    data-testid="first-run-finish"
                  >
                    进入主页
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
