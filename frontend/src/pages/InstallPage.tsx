import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  InstallChannel,
  InstallConflictChannel,
  InstallDiscoveryResult,
  InstallImportResult,
  InstallItemView,
  InstallMarketItem,
  InstallMarketListResult,
  InstallSourcePreviewChannel,
  SkillStatus,
} from '../../../backend/src/shared/ipc';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { SearchField } from '../components/SearchField';
import { SkillStatusTag } from '../components/SkillStatusTag';
import { SkillDiffModal } from '../components/SyncDiffModal';
import { MarketSkillDetailPage } from './MarketSkillDetailPage';
import { SourceSkillDetailPage } from './SourceSkillDetailPage';
import { Tabs, type TabItem } from '../components/Tabs';
import { navigate, navigateInstallPreview, navigateMarketSkill } from '../router';
import { request } from '../ipc/client';
import c from '../styles/common.module.css';
import s from './InstallPage.module.css';

const TABS: TabItem[] = [
  { id: 'market', label: '技能市场' },
  { id: 'git', label: 'Git 地址' },
  { id: 'local', label: '本地目录' },
  { id: 'archive', label: '压缩包' },
  { id: 'scan', label: '扫描本机' },
];

const CHANNEL_LABEL: Record<InstallChannel, string> = {
  market: '技能市场',
  git: 'Git 地址',
  local: '本地目录',
  archive: '压缩包',
  scan: '扫描本机',
};

const EMPTY_COPY: Record<InstallChannel, { title: string; desc?: string }> = {
  market: { title: '正在读取热门榜…' },
  git: { title: '尚未解析仓库' },
  local: { title: '尚未选择目录', desc: '目录可以是单个技能，也可以包含多个。' },
  archive: { title: '尚未读取压缩包' },
  scan: { title: '尚未扫描本机', desc: '导入后不会自动同步到 Agent。' },
};

type MarketMode = 'leaderboard' | 'search';

/** 列表行的统一展示模型（市场与本地发现共用同一套行结构）。 */
interface RowView {
  key: string;
  name: string;
  description: string;
  meta: string;
  valid: boolean;
  invalidReason?: string;
  /** 本地目录 / 压缩包 / 扫描本机的库内状态 */
  status?: SkillStatus;
  /** machine-scan：该技能出现的全部 Agent id（来源筛选） */
  agentIds?: string[];
  scripts: string[];
  source?: string;
  url?: string;
  installs?: number;
  isOfficial?: boolean;
  marketId?: string;
  skillId?: string;
}

/** 扫描本机的筛选条件（其他 Tab 不使用）。 */
interface ScanFilter {
  query: string;
  status: SkillStatus | 'all';
  agentId: string;
}

const EMPTY_SCAN_FILTER: ScanFilter = { query: '', status: 'all', agentId: 'all' };

const STATUS_OPTIONS: Array<{ value: SkillStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'not-in-library', label: '未入库' },
  { value: 'in-library', label: '已入库' },
  { value: 'synced', label: '已同步' },
  { value: 'conflict', label: '有冲突' },
];

/** 扫描本机结果按「搜索词 + 状态 + 来源 Agent」过滤；其他通道原样返回。 */
function filterRows(rows: RowView[], filter: ScanFilter): RowView[] {
  const query = filter.query.trim().toLowerCase();
  if (query.length === 0 && filter.status === 'all' && filter.agentId === 'all') return rows;
  return rows.filter((row) => {
    if (query.length > 0) {
      const haystack = `${row.name} ${row.description}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filter.status !== 'all' && row.status !== filter.status) return false;
    if (filter.agentId !== 'all' && !(row.agentIds ?? []).includes(filter.agentId)) return false;
    return true;
  });
}

interface ChannelState {
  input: string;
  /** 选择器选中的目录 / 文件（扫描与读取的参数） */
  pickedPath: string;
  items: RowView[];
  selected: string[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  submitting: boolean;
  result: InstallImportResult | null;
  mode: MarketMode;
  activeQuery: string;
  stale: boolean;
  warning?: string;
  fetchedAt?: string;
}

function initialState(): ChannelState {
  return {
    input: '',
    pickedPath: '',
    items: [],
    selected: [],
    loading: false,
    loaded: false,
    error: null,
    submitting: false,
    result: null,
    mode: 'leaderboard',
    activeQuery: '',
    stale: false,
  };
}

function initialTabs(): Record<InstallChannel, ChannelState> {
  return {
    market: initialState(),
    git: initialState(),
    local: initialState(),
    archive: initialState(),
    scan: initialState(),
  };
}

function errorText(error: { code: string; detail?: string } | undefined): string {
  if (!error) return '操作失败';
  return error.detail ?? error.code;
}

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}

function baseName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

function marketRows(data: InstallMarketListResult): RowView[] {
  return data.items.map((item: InstallMarketItem) => ({
    key: item.key,
    name: item.name,
    description: item.description || '',
    meta: `${item.source}${item.isOfficial ? ' · 官方' : ''}`,
    valid: true,
    scripts: [],
    source: item.source,
    url: item.url,
    installs: item.installs,
    isOfficial: item.isOfficial,
    marketId: item.id,
    skillId: item.id.slice(item.source.length + 1),
  }));
}

function discoveryRows(data: InstallDiscoveryResult): RowView[] {
  return data.items.map((item: InstallItemView) => ({
    key: item.key,
    name: item.name,
    description: item.description,
    meta: item.agentLabel
      ? `来自 ${item.agentLabel}`
      : item.relPath === '.'
        ? '目录根'
        : item.relPath,
    valid: item.valid,
    invalidReason: item.invalidReason,
    status: item.status,
    agentIds: item.agentIds,
    scripts: item.scriptManifest.executableScripts,
  }));
}

function isConflictChannel(channel: InstallChannel): channel is InstallConflictChannel {
  return channel === 'local' || channel === 'archive' || channel === 'scan';
}

function SourceDiffModal({ channel, row, onClose, onResolved }: {
  channel: InstallConflictChannel;
  row: RowView;
  onClose: () => void;
  onResolved: (status: 'overwritten' | 'skipped') => void;
}) {
  const hashes = useRef<{ sourceHash: string; targetHash: string } | null>(null);
  return <SkillDiffModal
    title={`${row.name} · 差异`}
    sourceLabel={channel === 'archive' ? '压缩包版本' : '本地版本'}
    targetLabel="中心库版本"
    footerHint={`${channel === 'archive' ? '压缩包' : '本地库'} → 中心库，覆盖或跳过将应用于整个 Skill`}
    comparisonKey={row.key}
    loadDiff={async (relPath) => {
      const result = await request('install:scanDiff', { channel, key: row.key, relPath, ...hashes.current });
      if (!result.ok) throw new Error(result.error.detail ?? '读取差异失败');
      if (!relPath && !result.data.stale) hashes.current = { sourceHash: result.data.sourceHash, targetHash: result.data.targetHash };
      return result.data;
    }}
    onClose={onClose}
    onDecision={async (choice, snapshot) => {
      const result = await request('install:resolveScanConflict', {
        channel, key: row.key, choice, sourceHash: snapshot.sourceHash ?? '', targetHash: snapshot.targetHash ?? '',
      });
      if (!result.ok) throw new Error(result.error.detail ?? '处理冲突失败');
      onResolved(result.data.status);
      return true;
    }}
  />;
}

/** 市场冲突（同名不同内容）：与本地目录 / 压缩包 / 扫描本机共用同一个差异弹窗。 */
function MarketDiffModal({ row, onClose, onResolved }: {
  row: RowView;
  onClose: () => void;
  onResolved: (status: 'overwritten' | 'skipped') => void;
}) {
  const hashes = useRef<{ sourceHash: string; targetHash: string } | null>(null);
  return <SkillDiffModal
    title={`${row.name} · 差异`}
    sourceLabel="技能市场版本"
    targetLabel="中心库版本"
    footerHint="技能市场 → 中心库，覆盖或跳过将应用于整个 Skill"
    comparisonKey={row.key}
    loadDiff={async (relPath) => {
      const result = await request('install:marketDiff', { key: row.key, relPath, ...hashes.current });
      if (!result.ok) throw new Error(result.error.detail ?? '读取差异失败');
      if (!relPath && !result.data.stale) hashes.current = { sourceHash: result.data.sourceHash, targetHash: result.data.targetHash };
      return result.data;
    }}
    onClose={onClose}
    onDecision={async (choice, snapshot) => {
      const result = await request('install:marketResolveConflict', {
        key: row.key, choice, sourceHash: snapshot.sourceHash ?? '', targetHash: snapshot.targetHash ?? '',
      });
      if (!result.ok) throw new Error(result.error.detail ?? '处理冲突失败');
      onResolved(result.data.status);
      return true;
    }}
  />;
}

/** 安装 Skills（ui.md）：五 Tab 各自保留状态，发现列表多选导入，不自动部署。 */
export function InstallPage({ market, marketKey, installPreview }: { market?: { source: string; skillId: string }; marketKey?: string | null; installPreview?: { channel: InstallSourcePreviewChannel; key: string } }) {
  const [tab, setTab] = useState<InstallChannel>('market');
  const [tabs, setTabs] = useState<Record<InstallChannel, ChannelState>>(initialTabs);
  const [installingMarketKey, setInstallingMarketKey] = useState<string | null>(null);
  /** 详情页的安装提示（列表行提示见 marketRowNotice） */
  const [marketNotice, setMarketNotice] = useState('');
  /** 列表行内安装提示：按条目 key 记录，结果落在该行「描述」列下方 */
  const [marketRowNotice, setMarketRowNotice] = useState<Record<string, { kind: 'ok' | 'error'; text: string; code?: string }>>({});
  const [installedMarketUrls, setInstalledMarketUrls] = useState<string[]>([]);
  const marketRequestId = useRef(0);
  const lastMarketInput = useRef<string | null>(null);
  const marketTimer = useRef<number | null>(null);
  /** 首次进入「扫描本机」已自动扫描；之后沿用结果，刷新走工具栏「重新扫描」 */
  const scanAutoRan = useRef(false);
  /** 扫描本机专用的筛选与来源下拉选项（其他 Tab 不受影响） */
  const [scanFilter, setScanFilter] = useState<ScanFilter>(EMPTY_SCAN_FILTER);
  const [scanAgents, setScanAgents] = useState<Array<{ id: string; label: string }>>([]);
  const [conflictMenuFor, setConflictMenuFor] = useState<string | null>(null);
  const [sourceDiffFor, setSourceDiffFor] = useState<{ channel: InstallConflictChannel; row: RowView } | null>(null);
  const [marketDiffFor, setMarketDiffFor] = useState<RowView | null>(null);

  useEffect(() => {
    if (!conflictMenuFor) return;
    const onDown = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest('[data-popover="true"]')) return;
      setConflictMenuFor(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [conflictMenuFor]);

  const state = tabs[tab];

  const patch = useCallback((channel: InstallChannel, partial: Partial<ChannelState>) => {
    setTabs((prev) => ({ ...prev, [channel]: { ...prev[channel], ...partial } }));
  }, []);

  const loadMarket = useCallback(
    async (query: string, force = false) => {
      const requestId = ++marketRequestId.current;
      const activeQuery = query.trim();
      const searching = activeQuery.length > 0;
      patch('market', { loading: true, error: null, stale: false, warning: undefined, mode: searching ? 'search' : 'leaderboard', activeQuery });
      const result = searching
        ? await request('install:marketSearch', { query: activeQuery, force })
        : await request('install:marketLeaderboard', { force });
      if (requestId !== marketRequestId.current) return;
      if (!result.ok) {
        patch('market', {
          loading: false,
          loaded: true,
          items: [],
          selected: [],
          error: errorText(result.error),
        });
        return;
      }
      patch('market', {
        loading: false,
        loaded: true,
        error: null,
        items: marketRows(result.data),
        selected: [],
        mode: searching ? 'search' : 'leaderboard',
        activeQuery,
        stale: result.data.stale,
        warning: result.data.warning,
        fetchedAt: result.data.fetchedAt,
      });
    },
    [patch],
  );

  useEffect(() => {
    if (installingMarketKey !== null) return;
    const inputKey = tabs.market.input;
    if (lastMarketInput.current === inputKey) return;
    const timer = window.setTimeout(() => {
      lastMarketInput.current = inputKey;
      void loadMarket(tabs.market.input);
    }, tabs.market.input.trim() ? 450 : 0);
    marketTimer.current = timer;
    return () => window.clearTimeout(timer);
  }, [tabs.market.input, loadMarket, installingMarketKey]);

  const refreshInstalledMarket = useCallback(async () => {
    const result = await request('library:list', { sourceType: 'market' });
    if (result.ok) setInstalledMarketUrls(result.data.items.map((item) => item.source?.origin).filter((value): value is string => Boolean(value)));
  }, []);

  useEffect(() => { void refreshInstalledMarket(); }, [refreshInstalledMarket]);

  async function runDiscovery(channel: Exclude<InstallChannel, 'market'>) {
    const current = tabs[channel];
    if (channel === 'git' && current.input.trim().length === 0) {
      patch(channel, { error: '请先填写 Git 仓库地址' });
      return;
    }
    if ((channel === 'local' || channel === 'archive') && current.pickedPath.length === 0) {
      patch(channel, {
        error: channel === 'local' ? '请先选择目录' : '请先选择压缩包文件',
      });
      return;
    }

    patch(channel, { loading: true, error: null, items: [], selected: [], result: null });
    const outcome =
      channel === 'git'
        ? await request('install:gitParse', { url: current.input.trim() })
        : channel === 'local'
          ? await request('install:localScan', { dirPath: current.pickedPath })
          : channel === 'archive'
            ? await request('install:zipRead', { zipPath: current.pickedPath })
            : await request('install:agentScan');

    if (!outcome.ok) {
      patch(channel, { loading: false, loaded: true, items: [], error: errorText(outcome.error) });
      return;
    }
    patch(channel, {
      loading: false,
      loaded: true,
      error: null,
      items: discoveryRows(outcome.data),
      selected: channel === 'git' ? outcome.data.items.filter((item) => item.valid).map((item) => item.key) : [],
    });
    if (channel === 'scan') {
      setScanAgents(outcome.data.agentOptions ?? []);
      setScanFilter(EMPTY_SCAN_FILTER);
    }
  }

  /** 首次进入「扫描本机」自动扫描一次，不必用户再点「重新扫描」；之后切回沿用上次结果与筛选。 */
  useEffect(() => {
    if (tab !== 'scan' || scanAutoRan.current) return;
    scanAutoRan.current = true;
    void runDiscovery('scan');
  }, [tab]);

  async function pickDirectoryForInstall() {
    const result = await request('app:pickDirectory', { title: '选择要扫描的目录' });
    if (!result.ok) {
      patch('local', { error: errorText(result.error) });
      return;
    }
    if (result.data.path) patch('local', { pickedPath: result.data.path, error: null });
  }

  async function pickZipForInstall() {
    const result = await request('app:pickFile', { title: '选择技能压缩包' });
    if (!result.ok) {
      patch('archive', { error: errorText(result.error) });
      return;
    }
    if (result.data.path) patch('archive', { pickedPath: result.data.path, error: null });
  }

  function toggleRow(channel: InstallChannel, key: string) {
    const current = tabs[channel];
    const selected = current.selected.includes(key)
      ? current.selected.filter((item) => item !== key)
      : [...current.selected, key];
    patch(channel, { selected });
  }

  /** 当前 Tab 可见行：扫描本机按筛选条件收窄，其他 Tab 原样。 */
  function rowsOf(channel: InstallChannel): RowView[] {
    const list = tabs[channel].items;
    return channel === 'scan' ? filterRows(list, scanFilter) : list;
  }

  function toggleAll(channel: InstallChannel) {
    const current = tabs[channel];
    const selectable = rowsOf(channel).filter((item) => item.valid).map((item) => item.key);
    const all = selectable.length > 0 && selectable.every((key) => current.selected.includes(key));
    patch(channel, { selected: all ? [] : selectable });
  }

  async function doImport(channel: InstallChannel, keys: string[]) {
    patch(channel, { submitting: true, error: null });
    const result = await request('install:import', {
      channel,
      items: keys.map((key) => ({ key })),
    });
    if (!result.ok) {
      patch(channel, { submitting: false, error: errorText(result.error) });
      return;
    }
    patch(channel, {
      submitting: false,
      result: result.data,
      selected: [],
    });
  }

  async function beginImport(channel: InstallChannel) {
    const keys = tabs[channel].selected.filter((key) => {
      const row = tabs[channel].items.find((item) => item.key === key);
      return row?.valid !== false;
    });
    if (keys.length === 0) return;
    await doImport(channel, keys);
  }

  /** 详情页单项安装：沿用现有导入接口，保留列表的勾选和其他结果。 */
  async function installOneSource(channel: InstallSourcePreviewChannel, key: string) {
    patch(channel, { submitting: true, error: null });
    const result = await request('install:import', { channel, items: [{ key }] });
    if (!result.ok) {
      patch(channel, { submitting: false, error: errorText(result.error) });
      return;
    }
    setTabs((previous) => {
      const current = previous[channel];
      const items = [...(current.result?.items ?? []).filter((item) => item.key !== key), ...result.data.items];
      const summary = { imported: 0, skipped: 0, failed: 0 };
      for (const item of items) summary[item.status]++;
      return { ...previous, [channel]: { ...current, submitting: false, error: null, result: { channel, items, summary } } };
    });
  }

  function setRowNotice(key: string, notice: { kind: 'ok' | 'error'; text: string; code?: string } | null) {
    setMarketRowNotice((previous) => {
      const next = { ...previous };
      if (notice) next[key] = notice;
      else delete next[key];
      return next;
    });
  }

  async function importMarket(row: RowView) {
    setInstallingMarketKey(row.key);
    setMarketNotice('');
    setRowNotice(row.key, null);
    const result = await request('install:import', { channel: 'market', items: [{ key: row.key }] });
    setInstallingMarketKey(null);
    if (!result.ok) {
      setRowNotice(row.key, { kind: 'error', text: errorText(result.error) });
      if (market) setMarketNotice(`${row.name}：${errorText(result.error)}`);
      return;
    }
    const item = result.data.items[0];
    if (item?.status === 'imported' || item?.status === 'skipped') {
      if (row.url) setInstalledMarketUrls((urls) => [...new Set([...urls, row.url as string])]);
      void refreshInstalledMarket();
      setRowNotice(row.key, { kind: 'ok', text: '已入库' });
      if (market) setMarketNotice(`${row.name} 已入库`);
    } else {
      setRowNotice(row.key, { kind: 'error', text: item?.reason ?? '安装失败', code: item?.code });
      if (market) setMarketNotice(`${row.name}：${item?.reason ?? '安装失败'}`);
    }
  }

  function retry(channel: InstallChannel) {
    switch (channel) {
      case 'market':
        void loadMarket(tabs.market.input, true);
        break;
      case 'git':
      case 'local':
      case 'archive':
      case 'scan':
        void runDiscovery(channel);
        break;
      default:
        break;
    }
  }

  const visibleRows = useMemo(
    () => (tab === 'scan' ? filterRows(state.items, scanFilter) : state.items),
    [tab, state.items, scanFilter],
  );
  const selectableKeys = useMemo(
    () => visibleRows.filter((item) => item.valid).map((item) => item.key),
    [visibleRows],
  );
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((key) => state.selected.includes(key));

  const resultByKey = useMemo(() => {
    const map = new Map<string, InstallImportResult['items'][number]>();
    for (const item of state.result?.items ?? []) map.set(item.key, item);
    return map;
  }, [state.result]);

  const conflictItems = (state.result?.items ?? []).filter((item) => item.code === 'NAME_CONFLICT');
  const failedItems = (state.result?.items ?? []).filter((item) => item.status === 'failed' && item.code !== 'NAME_CONFLICT');

  if (market) {
    const row = tabs.market.items.find((item) => item.source === market.source && item.skillId === market.skillId);
    const key = row?.key ?? marketKey ?? '';
    const url = row?.url ?? `https://www.skills.sh/${market.source.includes('/') ? market.source : `site/${market.source}`}/${market.skillId}`;
    return <MarketSkillDetailPage
      source={market.source}
      skillId={market.skillId}
      marketKey={key}
      fallbackName={row?.name ?? market.skillId}
      installed={installedMarketUrls.includes(url)}
      installing={installingMarketKey === key}
      notice={marketNotice}
      onBack={() => navigate('install')}
      onInstall={(name) => void importMarket(row ?? { key, name, description: '', meta: '', valid: true, scripts: [], url })}
    />;
  }

  if (installPreview) {
    const { channel, key } = installPreview;
    const row = tabs[channel].items.find((item) => item.key === key);
    const outcome = tabs[channel].result?.items.find((item) => item.key === key);
    const installed = outcome?.status === 'imported' || outcome?.status === 'skipped' || row?.status === 'in-library' || row?.status === 'synced';
    const notice = tabs[channel].error ?? (outcome?.status === 'failed' ? outcome.reason ?? '安装失败' : outcome?.status === 'imported' ? `${row?.name ?? outcome.name} 已入库` : '');
    return <SourceSkillDetailPage
      channel={channel}
      itemKey={key}
      fallbackName={row?.name ?? key}
      installed={installed}
      installing={tabs[channel].submitting}
      notice={notice}
      onBack={() => navigate('install')}
      onInstall={() => void installOneSource(channel, key)}
    />;
  }

  return (
    <section className={`${c.page} ${c.boundedPage}`}>
      <PageHeader title="安装 Skills" />

      <div className={c.tabsRow}>
        <Tabs items={TABS} active={tab} onChange={(id) => setTab(id as InstallChannel)} ariaLabel="安装来源" />
      </div>

      <div className={c.toolbar}>
        {tab === 'market' ? (
          <>
            <span className={s.marketLabel}>{state.mode === 'search' ? '搜索结果' : '热门榜'}</span>
            <SearchField
              wrapperClassName={s.search}
              placeholder="搜索 Skills"
              aria-label="搜索市场 Skills"
              value={state.input}
              onChange={(event) => {
                const input = event.target.value;
                marketRequestId.current++;
                patch('market', { input, loading: true, error: null, stale: false, warning: undefined, mode: input.trim() ? 'search' : 'leaderboard', activeQuery: input.trim() });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  if (marketTimer.current !== null) window.clearTimeout(marketTimer.current);
                  lastMarketInput.current = state.input;
                  void loadMarket(state.input);
                }
              }}
              data-testid="install-market-search"
            />
          </>
        ) : null}

        {tab === 'git' ? (
          <>
            <span className={c.toolbarLabel}>Git 地址</span>
            <input
              className={`${c.input} ${c.inputGrow}`}
              placeholder="仓库地址（https://… / git@… / 本地仓库路径）"
              aria-label="Git 仓库地址"
              value={state.input}
              onChange={(event) => patch('git', { input: event.target.value })}
              onKeyDown={(event) => { if (event.key === 'Enter') void runDiscovery('git'); }}
              data-testid="install-git-url"
            />
            <button type="button" className={c.btn} onClick={() => void runDiscovery('git')} disabled={state.loading || !state.input.trim()} data-testid="install-git-parse">
              {state.loading ? '正在克隆…' : '克隆并预览'}
            </button>
          </>
        ) : null}

        {tab === 'local' ? (
          <>
            <button
              type="button"
              className={c.btn}
              onClick={() => void pickDirectoryForInstall()}
              data-testid="install-local-pick"
            >
              选择目录
            </button>
            <span
              className={`${s.pathHint} ${state.pickedPath ? '' : c.toolbarHint}`}
              title={state.pickedPath}
              data-testid="install-local-path"
            >
              {state.pickedPath || '未选择目录'}
            </span>
            <span className={c.toolbarSpacer} />
            <button
              type="button"
              className={c.btn}
              onClick={() => void runDiscovery('local')}
              disabled={state.loading || state.pickedPath.length === 0}
              data-testid="install-local-scan"
            >
              {state.loading ? '正在扫描…' : '扫描'}
            </button>
          </>
        ) : null}

        {tab === 'archive' ? (
          <>
            <button
              type="button"
              className={c.btn}
              onClick={() => void pickZipForInstall()}
              data-testid="install-archive-pick"
            >
              选择文件
            </button>
            <span
              className={`${s.pathHint} ${state.pickedPath ? '' : c.toolbarHint}`}
              title={state.pickedPath}
              data-testid="install-archive-file"
            >
              {state.pickedPath ? baseName(state.pickedPath) : '未选择文件'}
            </span>
            <span className={c.toolbarSpacer} />
            <button
              type="button"
              className={c.btn}
              onClick={() => void runDiscovery('archive')}
              disabled={state.loading || state.pickedPath.length === 0}
              data-testid="install-archive-read"
            >
              {state.loading ? '正在读取…' : '读取'}
            </button>
          </>
        ) : null}

        {tab === 'scan' ? (
          <>
            <button
              type="button"
              className={c.btn}
              onClick={() => void runDiscovery('scan')}
              disabled={state.loading}
              data-testid="install-scan-rescan"
            >
              {state.loading ? '正在扫描…' : '重新扫描'}
            </button>
            <span className={c.toolbarSpacer} />
            <SearchField
              wrapperClassName={s.search}
              placeholder="搜索名称 / 描述"
              aria-label="搜索扫描结果"
              value={scanFilter.query}
              onChange={(event) =>
                setScanFilter((prev) => ({ ...prev, query: event.target.value }))
              }
              data-testid="install-scan-search"
            />
            {/* 顺序与表头「来源 → 状态」一致（2026-10-28 用户定） */}
            <select
              className={`${c.input} ${s.filterSelect}`}
              aria-label="按来源 Agent 筛选"
              value={scanFilter.agentId}
              onChange={(event) =>
                setScanFilter((prev) => ({ ...prev, agentId: event.target.value }))
              }
              data-testid="install-scan-agent"
            >
              <option value="all">全部来源</option>
              {scanAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                </option>
              ))}
            </select>
            <select
              className={`${c.input} ${s.filterSelect}`}
              aria-label="按状态筛选"
              value={scanFilter.status}
              onChange={(event) =>
                setScanFilter((prev) => ({
                  ...prev,
                  status: event.target.value as SkillStatus | 'all',
                }))
              }
              data-testid="install-scan-status"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      {tab === 'market' && state.mode === 'search' ? (
        <p className={s.marketStatus} role="status" data-testid="install-market-status">
          {state.loading ? `正在搜索“${state.activeQuery}”…` : state.error ? `搜索“${state.activeQuery}”失败` : `“${state.activeQuery}”的搜索结果：${state.items.length} 个 Skills`}
        </p>
      ) : null}

      {state.stale ? (
        <p className={s.stale} role="status" data-testid="install-stale-warning">
          {state.warning ?? '当前展示的是缓存内容，可能过期'}
        </p>
      ) : null}

      {tab === 'market' ? (
        <div className={`${c.content} ${c.contentFlush}`}>
          {state.loading ? <div className={s.center}><p className={c.hint}>{state.mode === 'search' ? `正在搜索“${state.activeQuery}”…` : '正在读取技能市场…'}</p></div>
            : state.error ? <div className={s.errorBox} data-testid="install-error"><p className={s.errorTitle}>读取失败</p><p className={s.errorText}>{state.error}</p><button type="button" className={c.btn} onClick={() => retry('market')} data-testid="install-retry">重试</button></div>
            : state.items.length === 0 ? <div className={s.center}><EmptyState title={state.mode === 'search' ? `没有找到与“${state.activeQuery}”相关的 Skills` : '没有找到 Skills'} /></div>
            : <table className={`${c.table} ${s.table}`} data-testid="install-list">
                <colgroup><col style={{ width: 64 }} /><col style={{ width: '18%' }} /><col /><col style={{ width: '22%' }} /><col style={{ width: 96 }} /><col style={{ width: 60 }} /></colgroup>
                <thead><tr><th className={s.numCol}>No</th><th>Skill 名称</th><th>描述</th><th>来源</th><th className={s.statusCol}>状态</th><th className={s.actionsCol} aria-label="操作" /></tr></thead>
                <tbody className={c.tableBody}>{state.items.map((row, index) => {
                  const installed = Boolean(row.url && installedMarketUrls.includes(row.url));
                  const notice = marketRowNotice[row.key];
                  return <tr key={row.key} className={s.row} data-testid="install-row" data-item-key={row.key} data-item-name={row.name} data-market-id={row.marketId}>
                    <td className={s.numCol}>{index + 1}</td>
                    <td><button type="button" className={`${c.cellName} ${s.nameLink}`} title={row.name} onClick={() => row.source && row.skillId && navigateMarketSkill(row.source, row.skillId, row.key)} data-testid="install-market-detail-link">{row.name}</button></td>
                    <td className={s.descCell}>
                      <p className={s.desc} title={row.description || '（无描述）'}>{row.description || '（无描述）'}</p>
                      {notice ? <p className={`${s.rowNotice} ${notice.kind === 'ok' ? s.rowNoticeOk : s.rowNoticeError}`} role="status" data-testid="install-market-row-notice">{notice.text}</p> : null}
                    </td>
                    <td>
                      <p className={s.sourceLine} title={row.source}>
                        {row.source}
                        {row.isOfficial ? ' · 官方' : ''}
                      </p>
                      <p className={s.installLine}>安装量 {formatNumber(row.installs ?? 0)}</p>
                    </td>
                    <td className={s.statusCol}><button type="button" className={c.btn} disabled={installingMarketKey !== null || installed} onClick={() => void importMarket(row)} data-testid="install-market-item">{installingMarketKey === row.key ? '安装中…' : installed ? '已入库' : '安装'}</button></td>
                    <td className={s.actionsCol}>
                      {notice?.code === 'NAME_CONFLICT' && !installed ? (
                        <div className={s.menuAnchor} data-popover="true">
                          <button type="button" className={s.moreButton} aria-label={`${row.name} 的操作菜单`} onClick={() => setConflictMenuFor(conflictMenuFor === row.key ? null : row.key)} data-testid="install-market-row-menu">⋯</button>
                          {conflictMenuFor === row.key ? <div className={s.rowMenu} role="menu">
                            <button type="button" role="menuitem" onClick={() => { setConflictMenuFor(null); setMarketDiffFor(row); }} data-testid="install-market-row-diff">查看差异</button>
                          </div> : null}
                        </div>
                      ) : null}
                    </td>
                  </tr>;
                })}</tbody>
              </table>}
        </div>
      ) : null}

      {tab !== 'market' ? <div className={`${c.content} ${c.contentFlush}`}>
        {state.loading ? (
          <div className={s.center}>
            <p className={c.hint}>
              {tab === 'git' ? '正在克隆并读取仓库…' : tab === 'local'
                    ? '正在扫描目录…'
                    : tab === 'archive'
                      ? '正在读取压缩包…'
                      : '正在扫描本机 Agent 目录…'}
            </p>
          </div>
        ) : state.error ? (
          <div className={s.errorBox} data-testid="install-error">
            <p className={s.errorTitle}>读取失败</p>
            <p className={s.errorText}>{state.error}</p>
            <button type="button" className={c.btn} onClick={() => retry(tab)} data-testid="install-retry">
              重试
            </button>
          </div>
        ) : state.items.length === 0 ? (
          <div className={s.center}>
            <EmptyState
              title={state.loaded ? `没有发现${CHANNEL_LABEL[tab]}中的 Skills` : EMPTY_COPY[tab].title}
              desc={
                state.loaded
                  ? tab === 'scan'
                      ? '确认 Agent 已启用且目录中有技能。'
                      : '检查所选位置是否包含 SKILL.md。'
                  : EMPTY_COPY[tab].desc
              }
            />
          </div>
        ) : visibleRows.length === 0 ? (
          <div className={s.center} data-testid="install-filter-empty">
            <EmptyState title="没有符合筛选条件的 Skills" desc="调整搜索词或筛选条件后重试。" />
          </div>
        ) : (
          <table className={`${c.table} ${s.table}`} data-testid="install-list">
            <colgroup>
              <col style={{ width: 44 }} />
              <col style={{ width: '12.5%' }} />
              <col />
              <col style={{ width: '16%' }} />
              <col style={{ width: 144 }} />
              {isConflictChannel(tab) ? <col style={{ width: 60 }} /> : null}
            </colgroup>
            <thead>
              <tr>
                <th className={s.checkCol}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={selectableKeys.length === 0 || state.submitting}
                    onChange={() => toggleAll(tab)}
                    aria-label="全选当前结果"
                    data-testid="install-select-all"
                  />
                </th>
                <th>Skill 名称</th>
                <th>描述</th>
                <th>来源</th>
                <th className={s.statusCol}>状态</th>
                {isConflictChannel(tab) ? <th className={s.actionsCol} aria-label="操作" /> : null}
              </tr>
            </thead>
            <tbody className={c.tableBody}>
              {visibleRows.map((row) => {
                const outcome = resultByKey.get(row.key);
                const displayStatus: SkillStatus | null =
                  outcome == null
                    ? row.status ?? null
                    : outcome.status === 'imported'
                      ? 'in-library'
                      : outcome.status === 'skipped'
                        ? row.status === 'synced' ? 'synced' : 'in-library'
                        : outcome.code === 'NAME_CONFLICT' ? 'conflict' : null;
                const selected = state.selected.includes(row.key);
                const scriptCount = row.scripts.length;
                return (
                  <tr
                    key={row.key}
                    className={`${s.row} ${selected ? s.rowSelected : ''}`}
                    data-testid="install-row"
                    data-item-key={row.key}
                    data-item-name={row.name}
                  >
                    <td className={s.checkCol}>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={!row.valid || state.submitting}
                        onChange={() => toggleRow(tab, row.key)}
                        aria-label={`选择 ${row.name}`}
                        data-testid="install-row-checkbox"
                      />
                    </td>
                    <td>
                      {row.valid ? <button type="button" className={s.nameLink} title={row.name} onClick={() => navigateInstallPreview(tab as InstallSourcePreviewChannel, row.key)} data-testid="install-source-detail-link">{row.name}</button>
                        : <span className={`${c.cellName} ${s.nameCell}`} title={row.name}>{row.name}</span>}
                      {!row.valid || scriptCount > 0 ? (
                        <div className={s.badges}>
                          {!row.valid ? (
                            <span className={s.badgeDanger} data-testid="install-invalid-badge">
                              不是技能目录
                            </span>
                          ) : null}
                          {scriptCount > 0 ? (
                            <span className={s.badgeScript} title={row.scripts.join('\n')}>
                              含脚本 {scriptCount}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td className={s.descCell}>
                      {row.valid ? <button type="button" className={s.descLink} title={row.description || '（无描述）'} onClick={() => navigateInstallPreview(tab as InstallSourcePreviewChannel, row.key)} data-testid="install-source-description-link">{row.description || '（无描述）'}</button>
                        : <p className={s.desc} title={row.description || '（无描述）'}>{row.description || '（无描述）'}</p>}
                      {!row.valid && row.invalidReason ? (
                        <p className={s.reason}>{row.invalidReason}</p>
                      ) : null}
                      {outcome?.status === 'failed' && outcome.code !== 'NAME_CONFLICT' && outcome.reason ? (
                        <p className={s.failReason}>导入失败：{outcome.reason}</p>
                      ) : null}
                    </td>
                    <td>
                      <span className={c.cellMeta}>{row.meta}</span>
                    </td>
                    <td className={s.statusCol}>
                      {!row.valid ? (
                        <span className={c.hint}>跳过</span>
                      ) : displayStatus != null ? (
                        <SkillStatusTag status={displayStatus} />
                      ) : outcome == null ? (
                        <span className={c.hint}>待导入</span>
                      ) : (
                        <span className={s.stateError}>导入失败</span>
                      )}
                    </td>
                    {isConflictChannel(tab) ? <td className={s.actionsCol}>
                      {displayStatus === 'conflict' ? <>
                        <div className={s.menuAnchor} data-popover="true">
                          <button type="button" className={s.moreButton} aria-label={`${row.name} 的操作菜单`} onClick={() => setConflictMenuFor(conflictMenuFor === row.key ? null : row.key)} data-testid="install-scan-row-menu">⋯</button>
                          {conflictMenuFor === row.key ? <div className={s.rowMenu} role="menu">
                            <button type="button" role="menuitem" onClick={() => { setConflictMenuFor(null); setSourceDiffFor({ channel: tab, row }); }} data-testid="install-scan-row-diff">查看差异</button>
                          </div> : null}
                        </div>
                      </> : null}
                    </td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div> : null}
      {sourceDiffFor ? <SourceDiffModal channel={sourceDiffFor.channel} row={sourceDiffFor.row} onClose={() => setSourceDiffFor(null)} onResolved={(status) => {
        const { channel, row } = sourceDiffFor;
        setSourceDiffFor(null);
        setTabs((prev) => {
          const current = prev[channel];
          const items = current.items.map((item) => item.key === row.key
            ? { ...item, status: status === 'overwritten' ? 'in-library' as const : 'conflict' as const } : item);
          const remaining = current.result?.items.filter((item) => item.key !== row.key) ?? [];
          const result = current.result ? {
            ...current.result,
            items: remaining,
            summary: {
              imported: remaining.filter((item) => item.status === 'imported').length,
              skipped: remaining.filter((item) => item.status === 'skipped').length,
              failed: remaining.filter((item) => item.status === 'failed').length,
            },
          } : null;
          return { ...prev, [channel]: { ...current, items, result, selected: current.selected.filter((key) => key !== row.key) } };
        });
      }} /> : null}

      {marketDiffFor ? <MarketDiffModal row={marketDiffFor} onClose={() => setMarketDiffFor(null)} onResolved={(status) => {
        const resolvedRow = marketDiffFor;
        setMarketDiffFor(null);
        setConflictMenuFor(null);
        // 跳过：中心库不变，冲突仍在（⋯ 保留）；覆盖：内容换成市场版本，来源记为该市场条目
        if (status !== 'overwritten') return;
        if (resolvedRow.url) setInstalledMarketUrls((urls) => [...new Set([...urls, resolvedRow.url as string])]);
        setRowNotice(resolvedRow.key, { kind: 'ok', text: '已入库' });
        void refreshInstalledMarket();
      }} /> : null}

      {tab !== 'market' && state.result ? (
        <div className={s.resultBar} role="status" data-testid="install-result">
          <span className={s.resultSummary}>
            已入库 {state.result.summary.imported} · 跳过 {state.result.summary.skipped} · 冲突 {conflictItems.length} · 失败 {failedItems.length}
          </span>
          {failedItems.length > 0 ? (
            <ul className={s.failList}>
              {failedItems.map((item) => (
                <li key={item.key}>
                  {item.name}：{item.reason ?? '导入失败'}
                </li>
              ))}
            </ul>
          ) : conflictItems.length === 0 ? (
            <span className={c.hint}>导入的 Skill 尚未同步，可在中心库中按需同步到 Agent。</span>
          ) : null}
        </div>
      ) : null}

      {tab !== 'market' ? <div className={s.footer}>
        <span className={c.toolbarHint} data-testid="install-selected-count">
          已选 {state.selected.length} 个
        </span>
        <span className={c.toolbarSpacer} />
        <button
          type="button"
          className={`${c.btn} ${c.btnPrimary}`}
          onClick={() => void beginImport(tab)}
          disabled={state.selected.length === 0 || state.submitting || state.loading}
          data-testid="install-import"
        >
          {state.submitting ? '正在导入…' : `导入选中项${state.selected.length > 0 ? `（${state.selected.length}）` : ''}`}
        </button>
      </div> : null}

    </section>
  );
}
