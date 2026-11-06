import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentView,
  LibraryFacetsResult,
  LibraryRemovePlanResult,
  LibrarySkillRow,
  LibrarySyncDecision,
  LibrarySyncPlanItem,
} from '../../../backend/src/shared/ipc';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { SkillDiffModal, SyncDiffModal } from '../components/SyncDiffModal';
import { AgentIcon } from '../components/icons';
import { SearchField } from '../components/SearchField';
import { navigate, navigateSkill } from '../router';
import { request } from '../ipc/client';
import { getAgentIconSrc } from '../utils/agent-icons';
import c from '../styles/common.module.css';
import s from './LibraryPage.module.css';

type ViewMode = 'list' | 'grid';
type MenuKey = 'edit' | 'evaluate' | 'report' | 'update' | 'delete';

interface Filters {
  group: string;
  sourceType: string;
  agentId: string;
}

const EMPTY_FILTERS: Filters = { group: '', sourceType: '', agentId: '' };

function errorText(error: { code: string; detail?: string } | undefined): string {
  if (!error) return '操作失败';
  return error.detail ?? error.code;
}

/** 点击外部关闭浮层。 */
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

/* ────────────────────────── 行内浮层 ────────────────────────── */

function MenuPopover({
  hasReport,
  updateAvailable,
  onSelect,
  onClose,
}: {
  hasReport: boolean;
  updateAvailable: boolean;
  onSelect: (key: MenuKey) => void;
  onClose: () => void;
}) {
  useDismiss(true, onClose);
  return (
    <div className={s.menu} data-popover="true" role="menu" data-testid="library-row-menu-popover">
      <button type="button" role="menuitem" onClick={() => onSelect('edit')} data-testid="menu-edit">
        优化
      </button>
      <button type="button" role="menuitem" onClick={() => onSelect('evaluate')} data-testid="menu-evaluate">
        评测
      </button>
      {hasReport ? (
        <button type="button" role="menuitem" onClick={() => onSelect('report')} data-testid="menu-report">
          评测查看
        </button>
      ) : null}
      {updateAvailable ? (
        <button type="button" role="menuitem" onClick={() => onSelect('update')} data-testid="menu-update">
          查看更新
        </button>
      ) : null}
      <div className={s.menuDivider} role="presentation" />
      <button
        type="button"
        role="menuitem"
        className={s.menuDanger}
        onClick={() => onSelect('delete')}
        data-testid="menu-delete"
      >
        删除
      </button>
    </div>
  );
}

function GroupPopover({
  row,
  facets,
  onToggle,
  onAdd,
  onClose,
}: {
  row: LibrarySkillRow;
  facets: LibraryFacetsResult | null;
  onToggle: (group: string, next: boolean) => void;
  onAdd: (group: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  useDismiss(true, onClose);
  return (
    <div className={s.popover} data-popover="true" data-testid="library-group-popover">
      <div className={s.checkList}>
        {(facets?.groups ?? []).length === 0 ? <p className={c.hint}>还没有 Group，可在下方新建。</p> : null}
        {(facets?.groups ?? []).map((g) => (
          <label key={g.value} className={s.checkRow}>
            <input
              type="checkbox"
              checked={row.groups.includes(g.value)}
              onChange={(event) => onToggle(g.value, event.target.checked)}
            />
            <span>{g.label}</span>
          </label>
        ))}
      </div>
      <form
        className={s.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          const name = draft.trim();
          if (!name) return;
          onAdd(name);
          setDraft('');
        }}
      >
        <input
          className={c.input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="新 Group 名"
          aria-label="新 Group 名"
        />
        <button type="submit" className={c.btn} disabled={draft.trim().length === 0}>
          添加
        </button>
      </form>
    </div>
  );
}

function AgentPopover({
  row,
  agents,
  onToggle,
  onClose,
}: {
  row: LibrarySkillRow;
  agents: AgentView[];
  onToggle: (agentId: string, next: boolean) => void;
  onClose: () => void;
}) {
  useDismiss(true, onClose);
  const enabled = agents.filter((a) => a.enabled);
  return (
    <div className={`${s.popover} ${s.agentPopover}`} data-popover="true" data-testid="library-agent-popover">
      <div className={s.checkList}>
        {enabled.length === 0 ? <p className={c.hint}>没有启用中的 Agent，请先在设置中启用。</p> : null}
        {enabled.map((agent) => {
          const checked = row.deployedAgents.includes(agent.id);
          return (
            <label key={agent.id} className={s.checkRow}>
              <input type="checkbox" checked={checked} onChange={(event) => onToggle(agent.id, event.target.checked)} />
              <span>{agent.name}</span>
              {!agent.installed ? <span className={s.checkHint}>目录不存在</span> : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/* ────────────────────────── 行与网格 ────────────────────────── */

interface RowHandlers {
  onOpen: (row: LibrarySkillRow) => void;
  onMenu: (row: LibrarySkillRow, open: boolean) => void;
  onGroupEditor: (row: LibrarySkillRow, open: boolean) => void;
  onAgentEditor: (row: LibrarySkillRow, open: boolean) => void;
  onToggleGroup: (row: LibrarySkillRow, group: string, next: boolean) => void;
  onAddGroup: (row: LibrarySkillRow, group: string) => void;
  onToggleAgent: (row: LibrarySkillRow, agentId: string, next: boolean) => void;
  onSelect: (key: MenuKey, row: LibrarySkillRow) => void;
  onToggleSelected: (skillId: string) => void;
}

interface RowNotice {
  skillId: string;
  text: string;
}

interface TableProps {
  rows: LibrarySkillRow[];
  agents: AgentView[];
  facets: LibraryFacetsResult | null;
  /** 行内反馈（同步 / Group 变更结果，4 秒后自动消失） */
  rowNotice: RowNotice | null;
  multi: boolean;
  selected: Set<string>;
  onToggleSelected: (skillId: string) => void;
  onToggleAll: () => void;
  allSelected: boolean;
  menuFor: string | null;
  groupFor: string | null;
  agentFor: string | null;
  handlers: RowHandlers;
}

function agentLabel(agents: AgentView[], id: string): string {
  return agents.find((a) => a.id === id)?.name ?? id;
}

const GROUP_COLORS = [
  s.tagColor0, s.tagColor1, s.tagColor2, s.tagColor3,
  s.tagColor4, s.tagColor5, s.tagColor6, s.tagColor7,
  s.tagColor8, s.tagColor9, s.tagColor10, s.tagColor11,
];

function groupColorClass(name: string): string {
  let color = 0;
  for (const char of name) color = (color * 7 + (char.codePointAt(0) ?? 0)) % GROUP_COLORS.length;
  return GROUP_COLORS[color];
}

function AgentMarks({ ids, agents, onClick }: { ids: string[]; agents: AgentView[]; onClick: () => void }) {
  return ids.map((id) => {
    const name = agentLabel(agents, id);
    const iconSrc = getAgentIconSrc(id, name);
    return (
      <button
        key={id}
        type="button"
        className={s.agentIconButton}
        onClick={onClick}
        data-testid="library-agent-trigger"
        aria-label={`管理 ${name} 的同步`}
        title={`${name}：已同步`}
      >
        {iconSrc ? <img src={iconSrc} alt="" /> : <AgentIcon size={16} />}
      </button>
    );
  });
}

function SkillTable({
  rows,
  agents,
  facets,
  rowNotice,
  multi,
  selected,
  onToggleSelected,
  onToggleAll,
  allSelected,
  menuFor,
  groupFor,
  agentFor,
  handlers,
}: TableProps) {
  return (
    <table className={`${c.table} ${s.table}`} data-testid="library-list">
      <colgroup>
        {multi ? <col style={{ width: '4%' }} /> : null}
        <col style={{ width: '16%' }} />
        <col style={{ width: multi ? '45.5%' : '46.5%' }} />
        <col style={{ width: multi ? '11%' : '12%' }} />
        <col style={{ width: multi ? '9%' : '10%' }} />
        <col style={{ width: multi ? '10%' : '11%' }} />
        <col style={{ width: '42px' }} />
      </colgroup>
      <thead>
        <tr>
          {multi ? (
            <th className={s.checkCol}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                aria-label="全选当前筛选结果"
                data-testid="library-select-all"
              />
            </th>
          ) : null}
          <th className={s.firstCol}>Skill 名称</th>
          <th>描述</th>
          <th>Group 标签</th>
          <th>来源</th>
          <th>同步 Agent</th>
          <th className={`${c.cellActions} ${s.actionsHead}`}>
            <span className={c.srOnly}>操作</span>
          </th>
        </tr>
      </thead>
      <tbody className={c.tableBody}>
        {rows.map((row) => {
          const groupOpen = groupFor === row.skillId;
          const agentOpen = agentFor === row.skillId;
          return (
            <tr
              key={row.skillId}
              className={`${s.row} ${selected.has(row.skillId) ? s.rowSelected : ''} ${
                menuFor === row.skillId ? s.rowActive : ''
              }`}
              data-testid="library-row"
              data-skill-name={row.name}
            >
              {multi ? (
                <td className={s.checkCol} onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(row.skillId)}
                    onChange={() => onToggleSelected(row.skillId)}
                    aria-label={`选择 ${row.name}`}
                    data-testid="library-row-checkbox"
                  />
                </td>
              ) : null}

              <td className={s.firstCol}>
                <div className={s.nameRow}>
                  <div className={s.nameTitle}>
                    <button type="button" className={s.nameLink} onClick={() => handlers.onOpen(row)} title={row.name}>
                      {row.name}
                    </button>
                    {row.updateAvailable ? <span className={s.badgeUpdate}>有更新</span> : null}
                  </div>
                  {row.missingName ? <span className={s.badge}>缺少 name</span> : null}
                  {row.missing ? <span className={s.badgeDanger}>已丢失</span> : null}
                  {rowNotice?.skillId === row.skillId ? (
                    <span className={s.rowNotice} role="status" title={rowNotice.text}>
                      {rowNotice.text}
                    </span>
                  ) : null}
                </div>
              </td>
              <td className={s.descCol}>
                <button
                  type="button"
                  className={s.descLink}
                  onClick={() => handlers.onOpen(row)}
                  title={row.description || '（无描述）'}
                >
                  {row.description || '（无描述）'}
                </button>
              </td>

              <td className={s.tagCell}>
                  <div
                    className={s.tagRow}
                    onClick={(event) => event.stopPropagation()}
                    role="presentation"
                  >
                    {row.groups.length === 0 ? (
                      <button
                        type="button"
                        className={s.tagAdd}
                        onClick={() => handlers.onGroupEditor(row, !groupOpen)}
                        aria-label={`为 ${row.name} 添加 Group`}
                        data-testid="library-group-trigger"
                      >
                        ＋
                      </button>
                    ) : null}
                    <div className={`${c.tagList} ${s.inlineTags}`} title={row.groups.join('、')}>
                      {row.groups.map((group) => (
                        <button
                          key={group}
                          type="button"
                          className={`${s.tagButton} ${groupColorClass(group)}`}
                          onClick={() => handlers.onGroupEditor(row, !groupOpen)}
                          data-testid="library-group-trigger"
                          title={`管理 ${row.name} 的 Group`}
                        >
                          {group}
                        </button>
                      ))}
                    </div>
                    {groupOpen ? (
                      <GroupPopover
                        row={row}
                        facets={facets}
                        onToggle={(group, next) => handlers.onToggleGroup(row, group, next)}
                        onAdd={(group) => handlers.onAddGroup(row, group)}
                        onClose={() => handlers.onGroupEditor(row, false)}
                      />
                    ) : null}
                  </div>
              </td>

              <td>
                <span className={`${c.cellMeta} ${s.sourceLabel}`} title={row.source?.detail ?? '来源未知'}>
                  {row.source?.label ?? '未知'}
                </span>
              </td>

              <td>
                <div
                  className={s.agentCell}
                  onClick={(event) => event.stopPropagation()}
                  role="presentation"
                >
                  {row.deployedAgents.length === 0 ? (
                    <button
                      type="button"
                      className={s.agentEmpty}
                      onClick={() => handlers.onAgentEditor(row, !agentOpen)}
                      data-testid="library-agent-trigger"
                    >
                      尚未同步
                    </button>
                  ) : (
                    <AgentMarks ids={row.deployedAgents} agents={agents} onClick={() => handlers.onAgentEditor(row, !agentOpen)} />
                  )}
                  {agentOpen ? (
                    <AgentPopover
                      row={row}
                      agents={agents}
                      onToggle={(agentId, next) => handlers.onToggleAgent(row, agentId, next)}
                      onClose={() => handlers.onAgentEditor(row, false)}
                    />
                  ) : null}
                </div>
              </td>

              <td className={`${c.cellActions} ${s.actionsCell}`} onClick={(event) => event.stopPropagation()}>
                <div className={s.menuAnchor} data-popover="true">
                  <button
                    type="button"
                    className={s.moreButton}
                    aria-label={`${row.name} 的操作菜单`}
                    onClick={() => handlers.onMenu(row, menuFor !== row.skillId)}
                    data-testid="library-row-menu"
                  >
                    ⋯
                  </button>
                  {menuFor === row.skillId ? (
                    <MenuPopover
                      hasReport={row.hasReport}
                      updateAvailable={row.updateAvailable}
                      onSelect={(key) => handlers.onSelect(key, row)}
                      onClose={() => handlers.onMenu(row, false)}
                    />
                  ) : null}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SkillGrid({
  rows,
  agents,
  facets,
  rowNotice,
  multi,
  selected,
  handlers,
  menuFor,
  groupFor,
  agentFor,
}: {
  rows: LibrarySkillRow[];
  agents: AgentView[];
  facets: LibraryFacetsResult | null;
  rowNotice: RowNotice | null;
  multi: boolean;
  selected: Set<string>;
  handlers: RowHandlers;
  menuFor: string | null;
  groupFor: string | null;
  agentFor: string | null;
}) {
  return (
    <div className={s.grid} data-testid="library-grid">
      {rows.map((row) => {
        const groupOpen = groupFor === row.skillId;
        const agentOpen = agentFor === row.skillId;
        return (
          <article
            key={row.skillId}
            className={`${s.card} ${selected.has(row.skillId) ? s.cardSelected : ''} ${
              menuFor === row.skillId ? s.cardActive : ''
            }`}
            data-testid="library-card"
            data-skill-name={row.name}
          >
            <div className={s.cardTop} onClick={(event) => event.stopPropagation()} role="presentation">
              {multi ? (
                <input
                  type="checkbox"
                  checked={selected.has(row.skillId)}
                  onChange={() => handlers.onToggleSelected(row.skillId)}
                  aria-label={`选择 ${row.name}`}
                  data-testid="library-row-checkbox"
                />
              ) : null}
              <h3 className={s.cardName}>
                <button type="button" className={s.cardLink} onClick={() => handlers.onOpen(row)} title={row.name}>{row.name}</button>
              </h3>
              {row.updateAvailable ? <span className={s.badgeUpdate}>有更新</span> : null}
              <span className={s.cardSpacer} />
              <div className={s.menuAnchor}>
                <button
                  type="button"
                  className={s.moreButton}
                  aria-label={`${row.name} 的操作菜单`}
                  onClick={() => handlers.onMenu(row, menuFor !== row.skillId)}
                  data-testid="library-row-menu"
                >
                  ⋯
                </button>
                {menuFor === row.skillId ? (
                  <MenuPopover
                    hasReport={row.hasReport}
                    updateAvailable={row.updateAvailable}
                    onSelect={(key) => handlers.onSelect(key, row)}
                    onClose={() => handlers.onMenu(row, false)}
                  />
                ) : null}
              </div>
            </div>

            <p className={s.cardDesc}>
              <button type="button" className={s.cardDescLink} onClick={() => handlers.onOpen(row)} title={row.description || '（无描述）'}>{row.description || '（无描述）'}</button>
            </p>
            {rowNotice?.skillId === row.skillId ? (
              <p className={s.rowNotice} role="status">
                {rowNotice.text}
              </p>
            ) : null}

            <div className={s.cardMeta} onClick={(event) => event.stopPropagation()} role="presentation">
              <div className={s.tagRow}>
                {row.groups.length === 0 ? (
                  <button
                    type="button"
                    className={s.tagAdd}
                    onClick={() => handlers.onGroupEditor(row, !groupOpen)}
                    aria-label={`为 ${row.name} 添加 Group`}
                    data-testid="library-group-trigger"
                  >
                    ＋
                  </button>
                ) : null}
                <div className={`${c.tagList} ${s.inlineTags}`} title={row.groups.join('、')}>
                  {row.groups.map((group) => (
                    <button
                      key={group}
                      type="button"
                      className={`${s.tagButton} ${groupColorClass(group)}`}
                      onClick={() => handlers.onGroupEditor(row, !groupOpen)}
                      data-testid="library-group-trigger"
                    >
                      {group}
                    </button>
                  ))}
                </div>
                {groupOpen ? (
                  <GroupPopover
                    row={row}
                    facets={facets}
                    onToggle={(group, next) => handlers.onToggleGroup(row, group, next)}
                    onAdd={(group) => handlers.onAddGroup(row, group)}
                    onClose={() => handlers.onGroupEditor(row, false)}
                  />
                ) : null}
              </div>

              <div className={s.cardFooter}>
                <span className={c.cellMeta} title={row.source?.detail ?? '来源未知'}>
                  {row.source?.label ?? '未知'}
                </span>
                <div className={s.agentCell}>
                  {row.deployedAgents.length === 0 ? (
                    <button
                      type="button"
                      className={s.agentEmpty}
                      onClick={() => handlers.onAgentEditor(row, !agentOpen)}
                      data-testid="library-agent-trigger"
                    >
                      尚未同步
                    </button>
                  ) : (
                    <AgentMarks ids={row.deployedAgents} agents={agents} onClick={() => handlers.onAgentEditor(row, !agentOpen)} />
                  )}
                  {agentOpen ? (
                    <AgentPopover
                      row={row}
                      agents={agents}
                      onToggle={(agentId, next) => handlers.onToggleAgent(row, agentId, next)}
                      onClose={() => handlers.onAgentEditor(row, false)}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

/* ────────────────────────── 页面 ────────────────────────── */

export function LibraryPage({ folder }: { folder: string }) {
  const folderRef = useRef(folder);
  folderRef.current = folder;
  const [rows, setRows] = useState<LibrarySkillRow[] | null>(null);
  const [facets, setFacets] = useState<LibraryFacetsResult | null>(null);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [view, setView] = useState<ViewMode>('list');
  const [multi, setMulti] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [groupFor, setGroupFor] = useState<string | null>(null);
  const [agentFor, setAgentFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<RowNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [checkingUpdates, setCheckingUpdates] = useState(true);
  const [reportView, setReportView] = useState<{ name: string; text: string } | null>(null);
  const [updateFor, setUpdateFor] = useState<LibrarySkillRow | null>(null);
  const [removePlan, setRemovePlan] = useState<{
    entries: Array<{ row: LibrarySkillRow; plan: LibraryRemovePlanResult }>;
    batch: boolean;
    busy: boolean;
  } | null>(null);
  const [batchGroupOpen, setBatchGroupOpen] = useState(false);
  const [batchGroupName, setBatchGroupName] = useState('');
  const [batchSyncOpen, setBatchSyncOpen] = useState(false);
  const [batchMenuOpen, setBatchMenuOpen] = useState(false);
  const [batchAgents, setBatchAgents] = useState<Set<string>>(new Set());
  const [syncReview, setSyncReview] = useState<{
    conflicts: Array<LibrarySyncPlanItem & { feedback?: string }>;
    busyKey: string | null;
  } | null>(null);
  const [syncDiffFor, setSyncDiffFor] = useState<LibrarySyncPlanItem | null>(null);

  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  // 文件夹切换只重置当前列表状态，不重新执行首次进入时的全库对账与来源检查。
  useLayoutEffect(() => {
    setRows(null);
    setFacets(null);
    setQuery('');
    setFilters(EMPTY_FILTERS);
    setSelected(new Set());
    setMulti(false);
    setMenuFor(null);
    setGroupFor(null);
    setAgentFor(null);
  }, [folder]);

  // 打开中心库时先对账库内目录，再检查来源变化；检查只读，列表随后显示更新状态。
  useEffect(() => {
    let alive = true;
    void (async () => {
      await request('library:rescan');
      if (!alive) return;
      refresh();
      await request('library:checkUpdates');
      if (!alive) return;
      setCheckingUpdates(false);
      refresh();
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useDismiss(batchMenuOpen, () => setBatchMenuOpen(false));

  useEffect(() => {
    let alive = true;
    const filter = {
      folder,
      query: query.trim() || undefined,
      group: filters.group || undefined,
      sourceType: filters.sourceType || undefined,
      agentId: filters.agentId || undefined,
    };
    void request('library:list', filter).then((result) => {
      if (!alive || folderRef.current !== folder) return;
      if (result.ok) {
        setRows(result.data.items);
        setError(null);
      } else {
        setRows([]);
        setError(errorText(result.error));
      }
    });
    return () => {
      alive = false;
    };
  }, [folder, query, filters, reloadKey]);

  useEffect(() => {
    let alive = true;
    void Promise.all([request('library:facets', { folder }), request('agents:list')]).then(([facetResult, agentsResult]) => {
      if (!alive || folderRef.current !== folder) return;
      if (facetResult.ok) setFacets(facetResult.data);
      if (agentsResult.ok) setAgents(agentsResult.data.agents);
    });
    return () => {
      alive = false;
    };
  }, [folder, reloadKey]);

  // 筛选变化后只保留当前可见的选中项（ui.md：批量操作仅作用于已选项）
  useEffect(() => {
    if (rows == null) return;
    setSelected((prev) => {
      const visible = new Set(rows.map((r) => r.skillId));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const visibleIds = useMemo(() => (rows ?? []).map((r) => r.skillId), [rows]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const hasFilters = query.trim().length > 0 || filters.group !== '' || filters.sourceType !== '' || filters.agentId !== '';

  useEffect(() => {
    if (rowNotice == null) return;
    const timer = window.setTimeout(() => setRowNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [rowNotice]);

  function toggleSelected(skillId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visibleIds));
  }

  function exitMulti() {
    setMulti(false);
    setSelected(new Set());
    setBatchGroupOpen(false);
    setBatchSyncOpen(false);
    setBatchMenuOpen(false);
    setSyncReview(null);
    setSyncDiffFor(null);
  }

  function syncKey(item: { skillId: string; agentId: string }): string {
    return `${item.skillId}\0${item.agentId}`;
  }

  async function startSync(skillIds: string[], agentIds: string[]) {
    setSyncReview(null);
    setSyncDiffFor(null);
    setNotice(null);
    const plan = await request('library:planSyncToAgents', { skillIds, agentIds });
    if (!plan.ok) {
      setNotice(`检查同步目标失败：${errorText(plan.error)}`);
      return;
    }
    setBatchSyncOpen(false);
    setAgentFor(null);
    const result = await request('library:syncToAgents', { skillIds, agentIds, decisions: [] });
    if (!result.ok) {
      setNotice(`同步失败：${errorText(result.error)}`);
      return;
    }
    const { summary, ignoredAgents } = result.data;
    setBatchAgents(new Set());
    refresh();
    if (summary.conflict > 0) {
      const checked = await request('library:planSyncToAgents', { skillIds, agentIds });
      const conflicts = (checked.ok ? checked.data.items : plan.data.items).filter((item) => item.status === 'conflict');
      if (conflicts.length > 0) setSyncReview({ conflicts, busyKey: null });
    } else {
      const ignored = ignoredAgents.length ? `；${ignoredAgents.map((a) => a.reason).join('、')}` : '';
      setNotice(`已同步 ${summary.deployed} 项，无需同步 ${summary.already} 项，跳过 ${summary.skipped} 项，失败 ${summary.failed} 项${ignored}`);
    }
  }

  async function resolveSyncConflict(item: LibrarySyncPlanItem, choice: LibrarySyncDecision['choice']): Promise<boolean> {
    if (!syncReview || syncReview.busyKey) return false;
    const key = syncKey(item);
    setSyncReview((current) => current ? { ...current, busyKey: key } : null);
    const decision: LibrarySyncDecision = {
      skillId: item.skillId,
      agentId: item.agentId,
      choice,
      fingerprint: item.fingerprint ?? '',
      sourceHash: item.sourceHash ?? '',
    };
    const result = await request('library:syncToAgents', {
      skillIds: [item.skillId], agentIds: [item.agentId], decisions: [decision],
    });
    if (!result.ok) {
      setSyncReview((current) => current ? {
        ...current, busyKey: null,
        conflicts: current.conflicts.map((entry) => syncKey(entry) === key
          ? { ...entry, feedback: errorText(result.error) } : entry),
      } : null);
      return false;
    }
    const outcome = result.data.items[0];
    if (outcome?.status === 'deployed' || outcome?.status === 'already' || outcome?.status === 'skipped') {
      setSyncReview((current) => {
        if (!current) return null;
        const conflicts = current.conflicts.filter((entry) => syncKey(entry) !== key);
        return conflicts.length ? { conflicts, busyKey: null } : null;
      });
      refresh();
      setSyncDiffFor(null);
      return true;
    }
    const checked = await request('library:planSyncToAgents', { skillIds: [item.skillId], agentIds: [item.agentId] });
    const updated = checked.ok ? checked.data.items[0] : null;
    setSyncReview((current) => current ? {
      ...current, busyKey: null,
      conflicts: current.conflicts.map((entry) => syncKey(entry) === key
        ? { ...(updated?.status === 'conflict' ? updated : entry), feedback: outcome?.reason ?? '同步未完成，请重试' }
        : entry),
    } : null);
    return false;
  }

  async function prefill(mode: 'improve' | 'evaluate', row: LibrarySkillRow) {
    setMenuFor(null);
    const result = await request('conversation:prefill', { mode, skillId: row.skillId });
    if (!result.ok) {
      setNotice(`${mode === 'improve' ? '优化' : '评测'}入口暂不可用：${errorText(result.error)}`);
      return;
    }
    navigate('chat', { session: result.data.sessionId });
  }

  async function openReport(row: LibrarySkillRow) {
    setMenuFor(null);
    const result = await request('library:report', { skillId: row.skillId });
    if (!result.ok) {
      setNotice(`读取评测结果失败：${errorText(result.error)}`);
      return;
    }
    if (!result.data.exists) {
      setNotice('该 Skill 还没有评测结果文件');
      refresh();
      return;
    }
    setReportView({ name: row.name, text: result.data.text ?? '' });
  }


  async function openRemove(row: LibrarySkillRow) {
    setMenuFor(null);
    const result = await request('library:removePlan', { skillId: row.skillId });
    if (!result.ok) {
      setNotice(`无法读取删除影响：${errorText(result.error)}`);
      return;
    }
    setRemovePlan({ entries: [{ row, plan: result.data }], batch: false, busy: false });
  }

  async function openBatchRemove() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const targets = (rows ?? []).filter((row) => ids.includes(row.skillId));
    const entries: Array<{ row: LibrarySkillRow; plan: LibraryRemovePlanResult }> = [];
    for (const row of targets) {
      const result = await request('library:removePlan', { skillId: row.skillId });
      if (result.ok) entries.push({ row, plan: result.data });
    }
    if (entries.length === 0) {
      setNotice('未能读取所选 Skills 的删除影响');
      return;
    }
    setRemovePlan({ entries, batch: true, busy: false });
  }

  async function confirmRemove() {
    if (!removePlan) return;
    setRemovePlan({ ...removePlan, busy: true });
    let removedLinks = 0;
    const failures: string[] = [];
    for (const entry of removePlan.entries) {
      const result = await request('library:remove', { skillId: entry.row.skillId, confirm: true });
      if (result.ok) removedLinks += result.data.removedLinks;
      else failures.push(`${entry.row.name}：${errorText(result.error)}`);
    }
    setRemovePlan(null);
    setSelected(new Set());
    refresh();
    if (failures.length === 0) {
      setNotice(
        `已删除 ${removePlan.entries.length} 个 Skill，撤下 ${removedLinks} 个受管理链接`,
      );
    } else {
      setError(`部分删除失败：${failures.join('；')}`);
    }
  }

  async function toggleGroup(row: LibrarySkillRow, group: string, next: boolean) {
    const result = await request('library:setGroups', {
      skillId: row.skillId,
      add: next ? [group] : [],
      remove: next ? [] : [group],
    });
    if (!result.ok) {
      setRowNotice({ skillId: row.skillId, text: `Group 更新失败：${errorText(result.error)}` });
      return;
    }
    setRowNotice({
      skillId: row.skillId,
      text: `Group 已更新：${result.data.groups.length === 0 ? '未分组' : result.data.groups.join('、')}`,
    });
    setRows((current) => current?.map((item) => item.skillId === row.skillId
      ? { ...item, groups: result.data.groups }
      : item).filter((item) => !filters.group || item.groups.includes(filters.group)) ?? null);
    refresh();
  }

  async function addGroup(row: LibrarySkillRow, group: string) {
    const result = await request('library:setGroups', { skillId: row.skillId, add: [group] });
    if (!result.ok) {
      setRowNotice({ skillId: row.skillId, text: `Group 更新失败：${errorText(result.error)}` });
      return;
    }
    setRowNotice({ skillId: row.skillId, text: `已添加 Group：${group}` });
    setRows((current) => current?.map((item) => item.skillId === row.skillId
      ? { ...item, groups: result.data.groups }
      : item).filter((item) => !filters.group || item.groups.includes(filters.group)) ?? null);
    refresh();
  }

  async function toggleAgent(row: LibrarySkillRow, agentId: string, next: boolean) {
    const name = agentLabel(agents, agentId);
    if (next) {
      await startSync([row.skillId], [agentId]);
    } else {
      const result = await request('library:unsyncFromAgents', {
        skillIds: [row.skillId],
        agentIds: [agentId],
      });
      if (!result.ok) {
        setRowNotice({ skillId: row.skillId, text: `撤下失败：${errorText(result.error)}` });
        return;
      }
      const item = result.data.items[0];
      setRowNotice({
        skillId: row.skillId,
        text:
          item?.status === 'removed' || item?.status === 'noop'
            ? `已从 ${name} 撤下`
            : `撤下未完成：${item?.reason ?? '目标已被替换，未删除'}`,
      });
    }
    refresh();
  }

  async function applyBatchGroups(mode: 'add' | 'remove') {
    const group = batchGroupName.trim();
    if (!group || selected.size === 0) return;
    const result = await request('library:batchGroups', {
      skillIds: [...selected],
      add: mode === 'add' ? [group] : [],
      remove: mode === 'remove' ? [group] : [],
    });
    if (!result.ok) {
      setNotice(`批量 Group 更新失败：${errorText(result.error)}`);
      return;
    }
    const failed = result.data.items.filter((item) => item.error);
    setBatchGroupOpen(false);
    setBatchGroupName('');
    refresh();
    setNotice(
      failed.length === 0
        ? `已对 ${result.data.items.length} 个 Skill ${mode === 'add' ? '加入' : '移出'} Group「${group}」`
        : `${result.data.items.length - failed.length} 个成功，${failed.length} 个失败（${failed[0].error ?? ''}）`,
    );
  }

  async function applyBatchSync() {
    if (batchAgents.size === 0 || selected.size === 0) return;
    await startSync([...selected], [...batchAgents]);
  }

  function handleMenu(key: MenuKey, row: LibrarySkillRow) {
    switch (key) {
      case 'edit':
        void prefill('improve', row);
        break;
      case 'evaluate':
        void prefill('evaluate', row);
        break;
      case 'report':
        void openReport(row);
        break;
      case 'update':
        setMenuFor(null);
        setUpdateFor(row);
        break;
      case 'delete':
        setMenuFor(null);
        setGroupFor(null);
        setAgentFor(null);
        void openRemove(row);
        break;
      default:
        break;
    }
  }

  const handlers: RowHandlers = {
    onOpen: (row) => {
      if (row.missing) {
        setNotice(`「${row.name}」的技能目录已丢失，无法打开详情`);
        return;
      }
      navigateSkill(row.skillId, folder);
    },
    onMenu: (row, open) => {
      setMenuFor(open ? row.skillId : null);
      if (open) {
        setGroupFor(null);
        setAgentFor(null);
      }
    },
    onGroupEditor: (row, open) => {
      setGroupFor(open ? row.skillId : null);
      if (open) {
        setMenuFor(null);
        setAgentFor(null);
      }
    },
    onAgentEditor: (row, open) => {
      setAgentFor(open ? row.skillId : null);
      if (open) {
        setMenuFor(null);
        setGroupFor(null);
      }
    },
    onToggleGroup: (row, group, next) => void toggleGroup(row, group, next),
    onAddGroup: (row, group) => void addGroup(row, group),
    onToggleAgent: (row, agentId, next) => void toggleAgent(row, agentId, next),
    onSelect: handleMenu,
    onToggleSelected: toggleSelected,
  };

  const total = rows?.length ?? null;

  return (
    <section className={`${c.page} ${c.boundedPage}`}>
      <PageHeader title="Skills 中心库" actions={<span className={c.hint}>{checkingUpdates ? '正在检查来源更新… · ' : ''}共 {total ?? '—'} 个 Skills</span>} />

      <div className={c.toolbar}>
        <SearchField
          wrapperClassName={s.search}
          placeholder="搜索名称 / 描述"
          aria-label="搜索 Skills"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="library-search"
        />
        <div className={`${c.chips} ${s.filterChips}`}>
          <button
            type="button"
            className={`${c.chip} ${!hasFilters ? c.chipActive : ''}`}
            onClick={() => {
              setQuery('');
              setFilters(EMPTY_FILTERS);
            }}
          >
            全部
          </button>
          <select
            className={`${c.chip} ${s.filterSelect} ${filters.group ? c.chipActive : ''}`}
            value={filters.group}
            onChange={(event) => setFilters({ ...filters, group: event.target.value })}
            aria-label="按 Group 筛选"
          >
            <option value="">Group：全部</option>
            {(facets?.groups ?? []).map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}（{g.count}）
              </option>
            ))}
          </select>
          <select
            className={`${c.chip} ${s.filterSelect} ${filters.sourceType ? c.chipActive : ''}`}
            value={filters.sourceType}
            onChange={(event) => setFilters({ ...filters, sourceType: event.target.value })}
            aria-label="按来源筛选"
          >
            <option value="">来源：全部</option>
            {(facets?.sources ?? []).map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}（{item.count}）
              </option>
            ))}
          </select>
          <select
            className={`${c.chip} ${s.filterSelect} ${filters.agentId ? c.chipActive : ''}`}
            value={filters.agentId}
            onChange={(event) => setFilters({ ...filters, agentId: event.target.value })}
            aria-label="按同步 Agent 筛选"
          >
            <option value="">同步 Agent：全部</option>
            {(facets?.agents ?? []).map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}（{item.count}）
              </option>
            ))}
          </select>
        </div>

        <span className={c.toolbarSpacer} />

        <div className={c.segmented} role="group" aria-label="查看方式">
          <button
            type="button"
            className={`${c.segment} ${view === 'grid' ? c.segmentActive : ''}`}
            onClick={() => setView('grid')}
            data-testid="library-view-grid"
          >
            网格
          </button>
          <button
            type="button"
            className={`${c.segment} ${view === 'list' ? c.segmentActive : ''}`}
            onClick={() => setView('list')}
            data-testid="library-view-list"
          >
            列表
          </button>
        </div>

        <button
          type="button"
          className={c.btn}
          onClick={() => (multi ? exitMulti() : setMulti(true))}
          data-testid="library-multi-toggle"
        >
          {multi ? '退出多选' : '多选'}
        </button>
      </div>

      {multi ? (
        <div className={s.batchBar} data-testid="library-batch-bar">
          <span className={s.batchCount}>已选 {selected.size} 个</span>
          <button
            type="button"
            className={c.btn}
            disabled={selected.size === 0}
            onClick={() => setBatchGroupOpen(true)}
          >
            加入 / 移出 Group
          </button>
          <button
            type="button"
            className={c.btn}
            disabled={selected.size === 0}
            onClick={() => setBatchSyncOpen(true)}
          >
            同步到 Agents
          </button>
          <div className={s.batchMore}>
            <button
              type="button"
              className={c.btn}
              disabled={selected.size === 0}
              onClick={() => setBatchMenuOpen((open) => !open)}
              data-testid="library-batch-menu"
              aria-label="更多批量操作"
            >
              ⋯
            </button>
            {batchMenuOpen ? (
              <div className={s.menu} data-popover="true" role="menu" style={{ top: '100%', right: 0 }}>
                <button
                  type="button"
                  role="menuitem"
                  className={s.menuDanger}
                  onClick={() => {
                    setBatchMenuOpen(false);
                    void openBatchRemove();
                  }}
                  data-testid="library-batch-delete"
                >
                  批量删除
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {notice ? (
        <p className={s.notice} role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className={s.error} role="alert">
          {error}
        </p>
      ) : null}

      {syncReview ? (
        <section className={s.syncReview} aria-label="同步冲突" data-testid="library-sync-review">
          {syncReview.conflicts.map((item) => (
            <div key={syncKey(item)} className={s.syncReviewRow}>
              <span className={s.syncTarget} title={`${item.dirName} → ${item.agentName}`}><b>{item.dirName}</b> → {item.agentName}</span>
              <span className={s.syncPrompt} title={item.feedback ?? '内容有差异，请选择处理方式'}>{item.feedback ?? '内容有差异，请选择处理方式'}</span>
              <div className={s.syncChoices}>
                <button type="button" className={c.btn} disabled={syncReview.busyKey !== null} onClick={() => setSyncDiffFor(item)}>差异</button>
                <button type="button" className={c.btn} disabled={syncReview.busyKey !== null} onClick={() => void resolveSyncConflict(item, 'overwrite')}>{syncReview.busyKey === syncKey(item) ? '处理中…' : '覆盖'}</button>
                <button type="button" className={c.btn} disabled={syncReview.busyKey !== null} onClick={() => void resolveSyncConflict(item, 'skip')}>跳过</button>
                <button type="button" className={s.syncDismiss} disabled={syncReview.busyKey !== null} aria-label={`关闭 ${item.dirName} 到 ${item.agentName} 的提示`} title="关闭这条提示" onClick={() => setSyncReview((current) => {
                  if (!current) return null;
                  const conflicts = current.conflicts.filter((entry) => syncKey(entry) !== syncKey(item));
                  return conflicts.length ? { ...current, conflicts } : null;
                })}>×</button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {syncDiffFor ? <SyncDiffModal
        item={syncDiffFor}
        onClose={() => setSyncDiffFor(null)}
        onDecision={(choice) => resolveSyncConflict(syncDiffFor, choice)}
      /> : null}

      <div className={`${c.content} ${c.contentFlush}`}>
        {rows == null ? (
          <div className={s.tableEmpty}>
            <EmptyState title="正在读取中心库…" />
          </div>
        ) : rows.length === 0 ? (
          <div className={s.tableEmpty}>
            <EmptyState
              title={hasFilters ? '没有符合条件的 Skills' : folder ? '此文件夹暂无 Skills' : '暂无 Skills'}
              desc={
                hasFilters || folder ? undefined : '从「安装 Skills」导入，或在「Agents」中收录本机技能。'
              }
            />
          </div>
        ) : view === 'list' ? (
          <SkillTable
            rows={rows}
            agents={agents}
            facets={facets}
            rowNotice={rowNotice}
            multi={multi}
            selected={selected}
            onToggleSelected={toggleSelected}
            onToggleAll={toggleAll}
            allSelected={allSelected}
            menuFor={menuFor}
            groupFor={groupFor}
            agentFor={agentFor}
            handlers={handlers}
          />
        ) : (
          <SkillGrid
            rows={rows}
            agents={agents}
            facets={facets}
            rowNotice={rowNotice}
            multi={multi}
            selected={selected}
            handlers={handlers}
            menuFor={menuFor}
            groupFor={groupFor}
            agentFor={agentFor}
          />
        )}
      </div>

      {/* 评测查看：文本弹层（不设独立报告页） */}
      {reportView ? (
        <Modal
          title={`评测结果 · ${reportView.name}`}
          desc="每个 Skill 只保留当前一份评测结果文件；新的成功评测会替换它。"
          onClose={() => setReportView(null)}
          width={720}
          testId="library-report-modal"
          footer={
            <button type="button" className={c.btn} onClick={() => setReportView(null)}>
              关闭
            </button>
          }
        >
          <pre className={s.reportText}>{reportView.text}</pre>
        </Modal>
      ) : null}

      {/* 来源更新：沿用现有逐文件差异弹窗。 */}
      {updateFor ? (
        <SkillDiffModal
          title={`查看更新 · ${updateFor.name}`}
          sourceLabel={`${updateFor.source?.label ?? '来源'}版本`}
          targetLabel="中心库当前版本"
          footerHint="来源 → 中心库，覆盖或跳过将应用于整个 Skill"
          comparisonKey={updateFor.skillId}
          loadDiff={async (relPath) => {
            const result = await request('library:updateDiff', { skillId: updateFor.skillId, relPath });
            if (!result.ok) throw new Error(errorText(result.error));
            return result.data;
          }}
          onClose={() => setUpdateFor(null)}
          onDecision={async (choice, snapshot) => {
            if (!snapshot.sourceHash || !snapshot.targetHash) return false;
            const result = await request('library:applyUpdate', {
              skillId: updateFor.skillId, choice,
              sourceHash: snapshot.sourceHash, targetHash: snapshot.targetHash,
            });
            if (!result.ok) throw new Error(errorText(result.error));
            setNotice(choice === 'overwrite' ? `已更新「${updateFor.name}」` : `已跳过「${updateFor.name}」的更新`);
            setUpdateFor(null);
            refresh();
            return true;
          }}
        />
      ) : null}

      {/* 删除确认：含受管理链接数 */}
      {removePlan ? (
        <Modal
          title={removePlan.batch ? '批量删除 Skills' : '删除 Skill'}
          desc="删除会移除库内技能文件与当前评测结果；确认指向中心库的受管理链接会被撤下，非归属目录不会被删除。"
          onClose={() => (removePlan.busy ? undefined : setRemovePlan(null))}
          width={600}
          testId="library-delete-modal"
          footer={
            <>
              <button type="button" className={c.btn} onClick={() => setRemovePlan(null)} disabled={removePlan.busy}>
                取消
              </button>
              <button
                type="button"
                className={`${c.btn} ${s.dangerBtn}`}
                onClick={() => void confirmRemove()}
                disabled={removePlan.busy}
                data-testid="delete-confirm"
              >
                {removePlan.busy ? '正在删除…' : '确认删除'}
              </button>
            </>
          }
        >
          <ul className={s.removeList}>
            {removePlan.entries.map((entry) => (
              <li key={entry.row.skillId}>
                <b>{entry.row.name}</b>
                <span className={c.meta}>
                  {' '}
                  · 将撤下 {entry.plan.linksToRemove.length} 个受管理链接
                  {entry.plan.hasReport ? ' · 同时删除当前评测结果' : ''}
                  {entry.plan.skippedTargets.length > 0
                    ? ` · ${entry.plan.skippedTargets.length} 个非归属目录保留`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className={s.removeTotal}>
            合计：撤下{' '}
            {removePlan.entries.reduce((sum, entry) => sum + entry.plan.linksToRemove.length, 0)} 个受管理链接
          </p>
        </Modal>
      ) : null}

      {/* 批量 Group */}
      {batchGroupOpen ? (
        <Modal
          title="批量管理 Group"
          desc={`已选 ${selected.size} 个 Skill。`}
          onClose={() => setBatchGroupOpen(false)}
          width={480}
          footer={
            <>
              <button type="button" className={c.btn} onClick={() => setBatchGroupOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className={c.btn}
                onClick={() => void applyBatchGroups('remove')}
                disabled={batchGroupName.trim().length === 0}
              >
                移出 Group
              </button>
              <button
                type="button"
                className={`${c.btn} ${c.btnPrimary}`}
                onClick={() => void applyBatchGroups('add')}
                disabled={batchGroupName.trim().length === 0}
              >
                加入 Group
              </button>
            </>
          }
        >
          <label className={s.field}>
            <span className={s.fieldLabel}>Group 名称</span>
            <input
              className={c.input}
              list="library-group-options"
              value={batchGroupName}
              onChange={(event) => setBatchGroupName(event.target.value)}
              placeholder="输入或选择 Group"
            />
            <datalist id="library-group-options">
              {(facets?.groups ?? []).map((g) => (
                <option key={g.value} value={g.value} />
              ))}
            </datalist>
          </label>
          <div className={s.quickGroups}>
            {(facets?.groups ?? []).slice(0, 8).map((g) => (
              <button
                key={g.value}
                type="button"
                className={c.chip}
                onClick={() => setBatchGroupName(g.value)}
              >
                {g.label}
              </button>
            ))}
          </div>
        </Modal>
      ) : null}

      {/* 批量同步到 Agents */}
      {batchSyncOpen ? (
        <Modal
          title="同步到 Agents"
          desc={`将 ${selected.size} 个 Skill 同步到选中的 Agent。`}
          onClose={() => setBatchSyncOpen(false)}
          width={480}
          footer={
            <>
              <button type="button" className={c.btn} onClick={() => setBatchSyncOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className={`${c.btn} ${c.btnPrimary}`}
                onClick={() => void applyBatchSync()}
                disabled={batchAgents.size === 0}
              >
                确认同步
              </button>
            </>
          }
        >
          <div className={s.checkList}>
            {agents.filter((a) => a.enabled).length === 0 ? (
              <p className={c.hint}>没有启用中的 Agent，请先在设置中启用。</p>
            ) : null}
            {agents
              .filter((a) => a.enabled)
              .map((agent) => (
                <label key={agent.id} className={s.checkRow}>
                  <input
                    type="checkbox"
                    checked={batchAgents.has(agent.id)}
                    onChange={(event) => {
                      const next = new Set(batchAgents);
                      if (event.target.checked) next.add(agent.id);
                      else next.delete(agent.id);
                      setBatchAgents(next);
                    }}
                  />
                  <span>{agent.name}</span>
                  {!agent.installed ? <span className={s.checkHint}>目录不存在</span> : null}
                </label>
              ))}
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
