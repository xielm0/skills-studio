import { useEffect, useState } from 'react';
import type {
  AgentSkillRow,
  AgentsSkillListResult,
  AgentView,
  AgentsResult,
  LibrarySyncPlanItem,
} from '../../../backend/src/shared/ipc';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { SearchField } from '../components/SearchField';
import { SkillStatusTag } from '../components/SkillStatusTag';
import { SyncDiffModal } from '../components/SyncDiffModal';
import { Tabs, type TabItem } from '../components/Tabs';
import { request } from '../ipc/client';
import { navigateAgentSkill } from '../router';
import c from '../styles/common.module.css';
import { shortenHome } from '../utils/path';
import s from './AgentsPage.module.css';

interface PanelState {
  data: AgentsSkillListResult | null;
  loading: boolean;
  error: string | null;
  busyDir: string | null;
  rowErrors: Record<string, string>;
}

const EMPTY_PANEL: PanelState = { data: null, loading: false, error: null, busyDir: null, rowErrors: {} };

/** 点击外部关闭行菜单（与中心库页同一口径）。 */
function useDismiss(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-popover="true"]')) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);
}

/** 行尾 ⋯ 菜单：冲突项可查看差异；删除仍只作用于该 Agent 目录项。 */
function RowMenu({ onDiff, onDelete, onClose }: { onDiff?: () => void; onDelete: () => void; onClose: () => void }) {
  useDismiss(true, onClose);
  return (
    <div className={s.menu} data-popover="true" role="menu" data-testid="agent-row-menu-popover">
      {onDiff ? <button type="button" role="menuitem" onClick={onDiff} data-testid="agent-row-diff">查看差异</button> : null}
      <button
        type="button"
        role="menuitem"
        className={s.menuDanger}
        onClick={onDelete}
        data-testid="agent-row-delete"
      >
        删除
      </button>
    </div>
  );
}

/**
 * Agents（ui.md「Agents」、T13）：
 * - 页面标题固定为 Agents，标题下方 Tab 行只列「已检测且已启用」的 Agent；
 * - 列表只显示该 Agent 目录中实际存在的 Skills，状态列按四态文字标注
 *   （未入库 / 已入库 / 已同步 / 有冲突，与安装 Skills 扫描结果同口径）；
 * - 未入库行提供 [入库]、已入库行提供 [同步]（同一后端动作，差异只是标签），
 *   成功后行变为「已同步」、按钮消失；已同步与有冲突行不给入口；
 * - 行尾 ⋯ 菜单在冲突时提供「查看差异」，并可「删除」该 Agent 目录下的这一项（链接只删链接本身、实体目录删目录，
 *   链接目标不动）；
 * - 行点击进入 `#/agent/<agentId>/<dirName>` 详情。
 */
export function AgentsPage({ initialAgent }: { initialAgent?: string | null }) {
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [panels, setPanels] = useState<Record<string, PanelState>>({});
  const [openError, setOpenError] = useState<string | null>(null);
  /** 当前展开 ⋯ 菜单的行（dirName）；同一时刻只允许一个 */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [diffFor, setDiffFor] = useState<LibrarySyncPlanItem | null>(null);
  /** 名称搜索：前端本地过滤，不改变后端返回顺序与同步计数 */
  const [query, setQuery] = useState('');

  const tabs: AgentView[] = (agents ?? []).filter((agent) => agent.enabled && agent.installed);
  const panel = (active ? panels[active] : null) ?? EMPTY_PANEL;

  useEffect(() => {
    let alive = true;
    void request('agents:list').then((result) => {
      if (!alive) return;
      if (!result.ok) {
        setAgents([]);
        setAgentsError(result.error.detail ?? result.error.code);
        return;
      }
      const data = result.data as AgentsResult;
      const detected = data.agents.filter((agent) => agent.enabled && agent.installed);
      setAgents(data.agents);
      const preferred = initialAgent && detected.some((agent) => agent.id === initialAgent)
        ? initialAgent
        : detected[0]?.id ?? null;
      setActive(preferred);
    });
    return () => {
      alive = false;
    };
    // 只在挂载时读取一次 Agent 配置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadSkills(agentId: string) {
    setPanels((prev) => ({
      ...prev,
      [agentId]: {
        ...(prev[agentId] ?? EMPTY_PANEL),
        loading: true,
        error: null,
        rowErrors: {},
        busyDir: null,
      },
    }));
    const result = await request('agents:listSkills', { agentId });
    setPanels((prev) => {
      const current = prev[agentId] ?? EMPTY_PANEL;
      if (!result.ok) {
        return {
          ...prev,
          [agentId]: { ...current, loading: false, error: result.error.detail ?? result.error.code },
        };
      }
      return { ...prev, [agentId]: { ...current, data: result.data, loading: false, error: null } };
    });
  }

  async function openDiff(agentId: string, row: AgentSkillRow) {
    setMenuFor(null);
    if (!row.matchingSkillId) return;
    const result = await request('library:planSyncToAgents', { skillIds: [row.matchingSkillId], agentIds: [agentId] });
    const item = result.ok ? result.data.items[0] : null;
    if (item?.status === 'conflict') { setDiffFor(item); return; }
    const reason = result.ok ? '目标内容已变化，请刷新后重试' : result.error.detail ?? result.error.code;
    setPanels((prev) => ({ ...prev, [agentId]: { ...(prev[agentId] ?? EMPTY_PANEL), rowErrors: { ...(prev[agentId]?.rowErrors ?? {}), [row.dirName]: reason } } }));
  }

  async function resolveDiff(item: LibrarySyncPlanItem, choice: 'overwrite' | 'skip'): Promise<boolean> {
    const result = await request('agents:resolveConflict', {
      skillId: item.skillId, agentId: item.agentId, choice,
      fingerprint: item.fingerprint ?? '', sourceHash: item.sourceHash ?? '',
    });
    if (!result.ok || (result.data.status !== 'deployed' && result.data.status !== 'skipped')) {
      const reason = result.ok ? result.data.reason ?? '处理失败' : result.error.detail ?? result.error.code;
      setPanels((prev) => ({ ...prev, [item.agentId]: { ...(prev[item.agentId] ?? EMPTY_PANEL), rowErrors: { ...(prev[item.agentId]?.rowErrors ?? {}), [item.dirName]: reason } } }));
      return false;
    }
    setDiffFor(null);
    if (result.data.status === 'deployed') await loadSkills(item.agentId);
    return true;
  }

  /**
   * 进入页面或切换 Tab 都实时读取该 Agent 目录（`agent-skills.list` 内部就是 readdirSync）。
   * 不做「重新扫描」按钮：中心库索引由后端文件监视 + 轮询自动重建（library.ts 的 startWatching）。
   */
  useEffect(() => {
    if (!active) return;
    void loadSkills(active);
    // loadSkills 只依赖 IPC；这里按 active 触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /**
   * 同一后端动作（`agents:adopt`：复制进库 → 原位建链）按行状态换标签：
   * 未入库叫「入库」（新收录），已入库叫「同步」（库内复用后建链）。
   * 失败原因按当前动作加前缀，避免从「同步」触发却提示「入库失败」。
   */
  async function adopt(agentId: string, row: AgentSkillRow, action: '入库' | '同步') {
    setPanels((prev) => ({
      ...prev,
      [agentId]: { ...(prev[agentId] ?? EMPTY_PANEL), busyDir: row.dirName },
    }));
    const result = await request('agents:adopt', { agentId, dirName: row.dirName });
    setPanels((prev) => {
      const current = prev[agentId] ?? EMPTY_PANEL;
      const rowErrors = { ...current.rowErrors };
      if (!result.ok) {
        rowErrors[row.dirName] = result.error.detail ?? result.error.code;
        return { ...prev, [agentId]: { ...current, busyDir: null, rowErrors } };
      }
      if (result.data.status === 'failed') {
        const reason = result.data.reason ?? '原位置保持不变';
        const detail = reason.replace(/^(入库|同步)失败[：:]\s*/, '');
        rowErrors[row.dirName] = `${action}失败：${detail}`;
        return { ...prev, [agentId]: { ...current, busyDir: null, rowErrors } };
      }
      delete rowErrors[row.dirName];
      const data = current.data;
      return {
        ...prev,
        [agentId]: {
          ...current,
          busyDir: null,
          rowErrors,
          data: data
            ? {
                ...data,
                items: data.items.map((item) =>
                  item.dirName === row.dirName
                    ? {
                        ...item,
                        isManagedLink: true,
                        linkedSkillId: result.data.skillId ?? null,
                        inLibrary: true,
                        inLibrarySameContent: true,
                        status: 'synced',
                      }
                    : item,
                ),
              }
            : data,
        },
      };
    });
  }

  /**
   * 行菜单「删除」：删掉该 Agent 目录下的这一项（链接＝撤下、实体目录＝删目录）。
   * 成功后本地移除该行，失败原因落在行内（与入库/同步失败同一位置）。
   */
  async function removeRow(agentId: string, row: AgentSkillRow) {
    setMenuFor(null);
    setPanels((prev) => ({
      ...prev,
      [agentId]: { ...(prev[agentId] ?? EMPTY_PANEL), busyDir: row.dirName },
    }));
    const result = await request('agents:removeSkill', { agentId, dirName: row.dirName });
    setPanels((prev) => {
      const current = prev[agentId] ?? EMPTY_PANEL;
      const rowErrors = { ...current.rowErrors };
      if (!result.ok) {
        rowErrors[row.dirName] = `删除失败：${result.error.detail ?? result.error.code}`;
        return { ...prev, [agentId]: { ...current, busyDir: null, rowErrors } };
      }
      if (result.data.status === 'failed') {
        const detail = (result.data.reason ?? '目标未被删除').replace(/^删除失败[：:]\s*/, '');
        rowErrors[row.dirName] = `删除失败：${detail}`;
        return { ...prev, [agentId]: { ...current, busyDir: null, rowErrors } };
      }
      delete rowErrors[row.dirName];
      const data = current.data;
      return {
        ...prev,
        [agentId]: {
          ...current,
          busyDir: null,
          rowErrors,
          data: data
            ? { ...data, items: data.items.filter((item) => item.dirName !== row.dirName) }
            : data,
        },
      };
    });
  }

  /** 打开当前 Agent 的 skills 目录；失败原因留在工具行右侧，不弹窗。 */
  async function openFolder(agentId: string) {
    setOpenError(null);
    const result = await request('agents:openFolder', { agentId });
    if (!result.ok) setOpenError(`打开文件夹失败：${result.error.detail ?? result.error.code}`);
    else if (!result.data.ok) setOpenError(`打开文件夹失败：${result.data.error ?? '未知原因'}`);
  }

  if (agents == null) {
    return (
      <section className={`${c.page} ${c.boundedPage}`}>
        <PageHeader title="Agents" />
        <div className={`${c.content} ${c.contentFlush}`}>
          <div className={s.centered}>
            <EmptyState title="正在读取 Agent 配置…" />
          </div>
        </div>
      </section>
    );
  }

  if (tabs.length === 0) {
    return (
      <section className={`${c.page} ${c.boundedPage}`}>
        <PageHeader title="Agents" />
        <div className={`${c.content} ${c.contentFlush}`}>
          <div className={s.centered} data-testid="agents-empty">
            <EmptyState
              title="未检测到已启用的 Agent"
              desc={
                agentsError
                  ? `读取 Agent 配置失败：${agentsError}`
                  : '在「设置」中启用 Agent 并确认其 Skills 目录存在。'
              }
            />
          </div>
        </div>
      </section>
    );
  }

  const tabItems: TabItem[] = tabs.map((agent) => ({ id: agent.id, label: agent.name }));
  const items = panel.data?.items ?? [];
  const greenCount = items.filter((item) => item.isManagedLink).length;
  // 名称搜索：大小写不敏感的子串匹配；过滤保持后端顺序（group → 名称升序）
  const needle = query.trim().toLowerCase();
  const visibleItems = needle
    ? items.filter((item) => item.name.toLowerCase().includes(needle))
    : items;
  const activeAgent = tabs.find((agent) => agent.id === (active ?? tabs[0].id)) ?? tabs[0];
  const skillsDir = activeAgent?.skillsDir ?? '';

  return (
    <section className={`${c.page} ${c.boundedPage}`}>
      <PageHeader title="Agents" />

      <div className={c.tabsRow}>
        <Tabs
          items={tabItems}
          active={active ?? tabs[0].id}
          onChange={(id) => {
            setActive(id);
            setOpenError(null);
            setMenuFor(null);
            setQuery('');
          }}
          ariaLabel="Agent 切换"
        />
      </div>

      <div className={c.toolbar}>
        <span className={s.path} title={skillsDir || undefined}>
          {skillsDir ? shortenHome(skillsDir) : '—'}
        </span>
        <span className={s.sep} aria-hidden="true">
          |
        </span>
        <span className={c.toolbarHint} data-testid="agents-sync-hint">
          {panel.data ? `${greenCount}/${items.length} 已同步` : panel.loading ? '正在扫描…' : '—'}
        </span>
        <span className={c.toolbarSpacer} />
        {openError ? (
          <span className={s.toolbarError} title={openError} data-testid="agents-open-error">
            {openError}
          </span>
        ) : null}
        <SearchField
          wrapperClassName={s.search}
          placeholder="搜索 Skill 名称"
          aria-label="搜索 Skill 名称"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="agents-search"
        />
        <button
          type="button"
          className={c.btn}
          onClick={() => void openFolder(activeAgent.id)}
          data-testid="agents-open-folder"
        >
          打开文件夹
        </button>
      </div>

      <div className={c.content}>
        <table className={c.table}>
          <colgroup>
            <col style={{ width: '160px' }} />
            <col />
            <col style={{ width: '92px' }} />
            <col style={{ width: '96px' }} />
            <col style={{ width: '42px' }} />
          </colgroup>
          <thead>
            <tr>
              <th className={s.firstCol}>Skill 名称</th>
              <th>描述</th>
              <th className={s.centerCol}>状态</th>
              <th className={s.centerCol}>操作</th>
              <th className={s.centerCol} />
            </tr>
          </thead>
          <tbody className={c.tableBody}>
            {panel.error ? (
              <tr className={s.emptyRow}>
                <td colSpan={5} className={c.tableEmptyCell}>
                  <div className={s.tableEmpty} data-testid="agent-error">
                    <EmptyState
                      title="无法读取该 Agent 的 Skills"
                      desc={`${panel.error}。请确认目录可读后切换到其他 Tab 再切回。`}
                    />
                  </div>
                </td>
              </tr>
            ) : panel.loading && panel.data == null ? (
              <tr className={s.emptyRow}>
                <td colSpan={5} className={c.tableEmptyCell}>
                  <div className={s.tableEmpty}>
                    <EmptyState title="正在扫描该 Agent 的 Skills…" />
                  </div>
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr className={s.emptyRow}>
                <td colSpan={5} className={c.tableEmptyCell}>
                  <div className={s.tableEmpty} data-testid="agent-empty">
                    <EmptyState
                      title="该 Agent 暂无 Skills"
                      desc={
                        panel.data?.exists === false
                          ? `未找到目录：${panel.data.skillsDir || '（未配置）'}。可在「设置」中修改路径。`
                          : '该目录中还没有技能。'
                      }
                    />
                  </div>
                </td>
              </tr>
            ) : visibleItems.length === 0 ? (
              <tr className={s.emptyRow}>
                <td colSpan={5} className={c.tableEmptyCell}>
                  <div className={s.tableEmpty} data-testid="agents-search-empty">
                    <EmptyState
                      title="没有匹配的 Skills"
                      desc={`没有名称包含“${query.trim()}”的 Skill，共 ${items.length} 个。清空搜索词查看全部。`}
                    />
                  </div>
                </td>
              </tr>
            ) : (
              visibleItems.map((row) => {
                const busy = panel.busyDir === row.dirName;
                const rowError = panel.rowErrors[row.dirName];
                return (
                  <tr
                    key={row.dirName}
                    className={s.row}
                    tabIndex={0}
                    onClick={() => active && navigateAgentSkill(active, row.dirName)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' && active) navigateAgentSkill(active, row.dirName);
                    }}
                    data-testid="agent-skill-row"
                    data-dir-name={row.dirName}
                    data-managed={row.isManagedLink ? 'true' : 'false'}
                    data-status={row.status}
                  >
                    <td className={s.firstCol}>
                      <p className={c.cellName} title={row.name}>
                        {row.name}
                      </p>
                      {rowError ? (
                        <p className={s.rowError} data-testid="agent-row-error">
                          {rowError}
                        </p>
                      ) : null}
                    </td>
                    <td className={s.descCol}>
                      <p className={s.desc} title={row.description || '暂无描述'}>
                        {row.description || '暂无描述'}
                      </p>
                    </td>
                    <td className={s.centerCol}>
                      <SkillStatusTag status={row.status} />
                    </td>
                    <td className={s.centerCol} onClick={(event) => event.stopPropagation()}>
                      {row.status === 'not-in-library' ? (
                        <button
                          type="button"
                          className={c.btn}
                          onClick={() => active && void adopt(active, row, '入库')}
                          disabled={busy}
                          data-testid="agent-adopt"
                        >
                          {busy ? '入库中…' : '入库'}
                        </button>
                      ) : row.status === 'in-library' ? (
                        <button
                          type="button"
                          className={c.btn}
                          onClick={() => active && void adopt(active, row, '同步')}
                          disabled={busy}
                          data-testid="agent-sync"
                        >
                          {busy ? '同步中…' : '同步'}
                        </button>
                      ) : (
                        <span className={c.cellMeta}>—</span>
                      )}
                    </td>
                    <td className={`${s.centerCol} ${s.actionsCol}`} onClick={(event) => event.stopPropagation()}>
                      <div className={s.menuAnchor} data-popover="true">
                        <button
                          type="button"
                          className={s.moreButton}
                          aria-label={`${row.name} 的操作菜单`}
                          onClick={() => setMenuFor(menuFor === row.dirName ? null : row.dirName)}
                          disabled={busy}
                          data-testid="agent-row-menu"
                        >
                          ⋯
                        </button>
                        {menuFor === row.dirName && active ? (
                          <RowMenu
                            onDiff={row.status === 'conflict' ? () => void openDiff(active, row) : undefined}
                            onDelete={() => void removeRow(active, row)}
                            onClose={() => setMenuFor(null)}
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {diffFor ? <SyncDiffModal item={diffFor} onClose={() => setDiffFor(null)} onDecision={(choice) => resolveDiff(diffFor, choice)} /> : null}
    </section>
  );
}
