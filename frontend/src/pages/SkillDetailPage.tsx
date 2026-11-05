import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryDetailResult, SkillFileNode } from '../../../backend/src/shared/ipc';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { CloseIcon, FileIcon } from '../components/icons';
import { navigate, navigateToHash, setNavigationGuard } from '../router';
import { request } from '../ipc/client';
import c from '../styles/common.module.css';
import s from './SkillDetailPage.module.css';

interface TabState {
  relPath: string;
  name: string;
  content: string;
  /** 上次成功保存（或刚读取）的内容；与 content 不同即「未保存」 */
  saved: string;
  editable: boolean;
  reason: string | null;
  size: number;
  loading: boolean;
  error: string | null;
}

const REASON_TEXT: Record<string, string> = {
  BINARY: '二进制文件，无法在应用内编辑',
  TOO_LARGE: '文件超过 512 KB，未在应用内编辑',
  NOT_A_FILE: '不是可编辑文件',
  MISSING: '文件不存在',
};

function basename(relPath: string): string {
  const parts = relPath.split('/');
  return parts[parts.length - 1] || relPath;
}

function findNode(node: SkillFileNode | null, relPath: string): SkillFileNode | null {
  if (!node) return null;
  if (node.relPath === relPath) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, relPath);
    if (hit) return hit;
  }
  return null;
}

function initialExpanded(tree: SkillFileNode | null): Set<string> {
  const set = new Set<string>(['.']);
  for (const child of tree?.children ?? []) {
    if (child.type === 'dir') set.add(child.relPath);
  }
  return set;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 树展示顺序：SKILL.md 置顶，其余目录在前、文件在后（与 ui.md 线框一致）。 */
function orderedChildren(node: SkillFileNode): SkillFileNode[] {
  const children = node.children ?? [];
  const entry = children.filter((child) => child.type === 'file' && child.name.toLowerCase() === 'skill.md');
  const dirs = children.filter((child) => child.type === 'dir');
  const files = children.filter((child) => child.type === 'file' && child.name.toLowerCase() !== 'skill.md');
  return [...entry, ...dirs, ...files];
}

/**
 * 技能详情（ui.md「技能详情」、tec.md §5.3/§5.4）：
 * 左侧真实文件树（含 references/scripts/assets）→ 右侧文件标签 + 文件行 + 文件内容。
 * 文件默认以预览打开；文件行右端只有一个按钮：预览态为「编辑」，点后进入编辑态变为「保存」，
 * 保存成功回到预览态。未保存内容切换文件保留；关闭有改动标签或离开页面时提示保存/放弃/取消。
 *
 * T13：同一套组件复用于 Agent 源技能（agent 传入 agentId+dirName）：
 * 未入库技能编辑 Agent 原文件；已入库链接技能经链接写入中心库文件。
 */
export interface AgentSourceTarget {
  agentId: string;
  dirName: string;
}

export function SkillDetailPage({ skillId, agent }: { skillId?: string; agent?: AgentSourceTarget }) {
  const sourceKey = agent ? `agent:${agent.agentId}/${agent.dirName}` : `library:${skillId ?? ''}`;
  const selfHash = agent
    ? `#/agent/${encodeURIComponent(agent.agentId)}/${encodeURIComponent(agent.dirName)}`
    : `#/library/${encodeURIComponent(skillId ?? '')}`;
  const target = useMemo(
    () =>
      agent
        ? { origin: 'agent' as const, agentId: agent.agentId, dirName: agent.dirName }
        : { skillId: skillId ?? '' },
    [agent?.agentId, agent?.dirName, skillId],
  );

  const [detail, setDetail] = useState<LibraryDetailResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['.']));
  const [saving, setSaving] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [closePrompt, setClosePrompt] = useState<string | null>(null);
  const [pendingHash, setPendingHash] = useState<string | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const tabsRef = useRef<TabState[]>([]);
  tabsRef.current = tabs;
  const activeTab = useMemo(() => tabs.find((tab) => tab.relPath === active) ?? null, [tabs, active]);
  const dirtyTabs = useMemo(() => tabs.filter((tab) => tab.editable && tab.content !== tab.saved), [tabs]);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirtyTabs.length > 0;

  const applyFile = useCallback(
    (relPath: string, next: Partial<TabState>) => {
      setTabs((prev) => prev.map((tab) => (tab.relPath === relPath ? { ...tab, ...next } : tab)));
    },
    [],
  );

  const openFile = useCallback(
    async (relPath: string) => {
      setActive(relPath);
      if (tabsRef.current.some((tab) => tab.relPath === relPath)) return;
      const node = findNode(detail?.fileTree ?? null, relPath);
      const placeholder: TabState = {
        relPath,
        name: basename(relPath),
        content: '',
        saved: '',
        editable: true,
        reason: null,
        size: node?.size ?? 0,
        loading: true,
        error: null,
      };
      setTabs((prev) => (prev.some((tab) => tab.relPath === relPath) ? prev : [...prev, placeholder]));
      const result = await request('library:readFile', { ...target, relPath });
      if (!result.ok) {
        applyFile(relPath, { loading: false, editable: false, error: result.error.detail ?? result.error.code });
        return;
      }
      const data = result.data;
      applyFile(relPath, {
        loading: false,
        editable: data.editable,
        reason: data.reason,
        size: data.size,
        content: data.content ?? '',
        saved: data.content ?? '',
        error: null,
      });
    },
    [applyFile, detail, target],
  );

  // 载入详情 + 默认打开 SKILL.md（若有）
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setLoadError(null);
    setTabs([]);
    setActive(null);
    void request('library:detail', target).then((result) => {
      if (!alive) return;
      if (!result.ok) {
        setLoadError(result.error.detail ?? result.error.code);
        return;
      }
      setDetail(result.data);
      setExpanded(initialExpanded(result.data.fileTree));
      const root = result.data.fileTree;
      const entry = root?.children?.find((child) => child.type === 'file' && child.name.toLowerCase() === 'skill.md');
      if (entry) void openFile(entry.relPath);
    });
    return () => {
      alive = false;
    };
    // openFile 依赖 detail（默认展开）；这里只在来源变化时重载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // 未保存时拦截应用内导航
  useEffect(() => {
    setNavigationGuard((hash) => {
      if (!dirtyRef.current) return false;
      if (hash === selfHash) return false;
      setPendingHash(hash);
      setLeaveError(null);
      return true;
    });
    return () => setNavigationGuard(null);
  }, [selfHash]);

  const saveTab = useCallback(
    async (relPath: string): Promise<boolean> => {
      const tab = tabsRef.current.find((item) => item.relPath === relPath);
      if (!tab || !tab.editable || tab.loading) return false;
      const sent = tab.content;
      setSaving(relPath);
      try {
        const result = await request('library:writeFile', { ...target, relPath, content: sent });
        if (!result.ok) {
          setFeedback({ kind: 'error', text: `保存失败（未丢失修改）：${result.error.detail ?? result.error.code}` });
          return false;
        }
        setTabs((prev) =>
          prev.map((item) =>
            item.relPath === relPath
              ? { ...item, saved: sent, size: result.data.size, content: item.content }
              : item,
          ),
        );
        setFeedback({ kind: 'ok', text: `已保存 ${basename(relPath)} · ${new Date().toLocaleTimeString()}` });
        return true;
      } finally {
        setSaving(null);
      }
    },
    [target],
  );

  /** 文件行唯一按钮：预览态点「编辑」进入编辑，编辑态点「保存」写回后回到预览。 */
  const commitActive = useCallback(async () => {
    const tab = activeTab;
    if (!tab || !tab.editable || tab.loading || saving != null) return;
    if (mode === 'preview') {
      setMode('edit');
      return;
    }
    const ok = await saveTab(tab.relPath);
    if (ok) setMode('preview');
  }, [activeTab, mode, saveTab, saving]);

  function removeTab(relPath: string) {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.relPath === relPath);
    const next = current.filter((tab) => tab.relPath !== relPath);
    tabsRef.current = next;
    setTabs(next);
    if (active === relPath) {
      const fallback = next[Math.max(0, index - 1)] ?? next[0] ?? null;
      setActive(fallback?.relPath ?? null);
    }
  }

  function requestClose(relPath: string) {
    const tab = tabsRef.current.find((item) => item.relPath === relPath);
    if (!tab) return;
    if (tab.editable && tab.content !== tab.saved) {
      setClosePrompt(relPath);
      return;
    }
    removeTab(relPath);
  }

  async function saveAndClose() {
    if (!closePrompt) return;
    const ok = await saveTab(closePrompt);
    if (ok) {
      removeTab(closePrompt);
      setClosePrompt(null);
    }
  }

  async function saveAllDirty(): Promise<boolean> {
    for (const tab of tabsRef.current.filter((item) => item.editable && item.content !== item.saved)) {
      const ok = await saveTab(tab.relPath);
      if (!ok) return false;
    }
    return true;
  }

  async function leave(action: 'save' | 'discard') {
    if (!pendingHash) return;
    setLeaveError(null);
    setLeaveBusy(true);
    try {
      if (action === 'save') {
        const ok = await saveAllDirty();
        if (!ok) {
          setLeaveError('仍有文件保存失败，请修正后再离开。');
          return;
        }
      }
      const hash = pendingHash;
      setPendingHash(null);
      dirtyRef.current = false;
      setTabs((prev) => prev.map((tab) => ({ ...tab, saved: tab.content })));
      setNavigationGuard(null);
      navigateToHash(hash);
    } finally {
      setLeaveBusy(false);
    }
  }

  const tree = detail?.fileTree ?? null;

  return (
    <section className={s.page}>
      <header className={s.header}>
        <button
          type="button"
          className={s.back}
          onClick={() => {
            if (agent) navigateToHash(`#/agents?agent=${encodeURIComponent(agent.agentId)}`);
            else navigate('library');
          }}
          data-testid="skill-back"
        >
          ← 返回
        </button>
        <h1 className={s.title}>{detail?.name ?? '技能详情'}</h1>
        {detail?.missingName ? <span className={s.badge}>缺少 name</span> : null}
        {detail && detail.dirName !== detail.name ? <span className={s.dirName}>{detail.dirName}</span> : null}
        {agent && detail ? (
          <span className={s.sourceHint} data-testid="agent-source-hint">
            {detail.isManagedLink ? '已入库 · 编辑中心库文件' : '未入库 · 编辑 Agent 原文件'}
          </span>
        ) : null}
        <span className={c.toolbarSpacer} />
        {feedback ? (
          <span
            className={`${s.feedback} ${feedback.kind === 'error' ? s.feedbackError : ''}`}
            data-testid="skill-feedback"
          >
            {feedback.text}
          </span>
        ) : null}
      </header>

      {loadError ? (
        <div className={s.bodyEmpty}>
          <EmptyState title="无法打开技能详情" desc={loadError} />
        </div>
      ) : detail == null ? (
        <div className={s.bodyEmpty}>
          <EmptyState title="正在读取技能…" />
        </div>
      ) : (
        <div className={s.body}>
          <aside className={s.treePanel} aria-label="文件树" data-testid="skill-file-tree">
            <div className={s.treeHead}>
              <span className={s.treeTitle}>文件树</span>
              <span className={s.treeMeta}>{detail.sizeBytes != null ? formatSize(detail.sizeBytes) : ''}</span>
            </div>
            <div className={s.treeScroll}>
              {tree ? orderedChildren(tree).map((child) => (
                <TreeNode
                  key={child.relPath}
                  node={child}
                  depth={0}
                  expanded={expanded}
                  active={active}
                  onToggle={(relPath) =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(relPath)) next.delete(relPath);
                      else next.add(relPath);
                      return next;
                    })
                  }
                  onOpen={(relPath) => void openFile(relPath)}
                />
              )) : null}
            </div>
          </aside>

          <div className={s.editorPanel}>
            <div className={s.tabBar} data-testid="skill-tabs">
              <div className={s.tabList} role="tablist">
                {tabs.map((tab) => {
                  const dirty = tab.editable && tab.content !== tab.saved;
                  return (
                    <div
                      key={tab.relPath}
                      className={`${s.tab} ${active === tab.relPath ? s.tabActive : ''}`}
                      role="tab"
                      aria-selected={active === tab.relPath}
                      title={tab.relPath}
                      data-testid="skill-tab"
                      data-dirty={dirty ? 'true' : 'false'}
                    >
                      <button type="button" className={s.tabLabel} onClick={() => setActive(tab.relPath)}>
                        <FileIcon size={13} />
                        <span>{tab.name}</span>
                        {dirty ? <span className={s.dirtyDot} aria-label="未保存" /> : null}
                      </button>
                      <button
                        type="button"
                        className={s.tabClose}
                        aria-label={`关闭 ${tab.name}`}
                        onClick={() => requestClose(tab.relPath)}
                      >
                        <CloseIcon size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={s.fileBar}>
              <span className={s.filePath} title={active ?? ''}>
                {active ?? '未打开文件'}
              </span>
              <span className={c.toolbarSpacer} />
              {activeTab ? (
                <span className={s.fileMeta}>
                  {formatSize(activeTab.size)}
                  {activeTab.editable && activeTab.content !== activeTab.saved ? ' · 未保存修改' : ''}
                </span>
              ) : null}
              <button
                type="button"
                className={`${c.btn} ${mode === 'edit' ? c.btnPrimary : ''} ${s.save}`}
                onClick={() => void commitActive()}
                disabled={activeTab == null || !activeTab.editable || activeTab.loading || saving != null}
                data-testid="skill-save"
                data-mode={mode}
              >
                {saving ? '保存中…' : mode === 'edit' ? '保存' : '编辑'}
              </button>
            </div>

            <div className={s.editorBody}>
              {activeTab == null ? (
                <div className={s.bodyEmpty}>
                  <EmptyState title="从左侧文件树选择文件" />
                </div>
              ) : activeTab.loading ? (
                <div className={s.bodyEmpty}>
                  <EmptyState title="正在读取文件…" />
                </div>
              ) : activeTab.error ? (
                <div className={s.bodyEmpty}>
                  <EmptyState title="无法读取该文件" desc={activeTab.error} />
                </div>
              ) : !activeTab.editable ? (
                <div className={s.readOnlyBox} data-testid="skill-readonly">
                  <p className={s.readOnlyTitle}>该文件无法在应用内编辑</p>
                  <p className={s.readOnlyDesc}>
                    {REASON_TEXT[activeTab.reason ?? ''] ?? activeTab.reason ?? '不支持的文件类型'}
                    （{formatSize(activeTab.size)}）。请使用系统编辑器打开。
                  </p>
                </div>
              ) : mode === 'preview' ? (
                <pre className={s.preview} data-testid="skill-preview">
                  {activeTab.content}
                </pre>
              ) : (
                <textarea
                  className={s.textarea}
                  value={activeTab.content}
                  spellCheck={false}
                  onChange={(event) => applyFile(activeTab.relPath, { content: event.target.value })}
                  aria-label={`编辑 ${activeTab.name}`}
                  data-testid="skill-editor"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* 关闭有改动的标签：保存 / 放弃 / 取消 */}
      {closePrompt ? (
        <Modal
          title="关闭有未保存修改的文件？"
          desc={`${basename(closePrompt)} 的修改尚未保存。`}
          onClose={() => setClosePrompt(null)}
          width={460}
          testId="skill-close-prompt"
          footer={
            <>
              <button type="button" className={c.btn} onClick={() => setClosePrompt(null)}>
                取消
              </button>
              <button
                type="button"
                className={c.btn}
                onClick={() => {
                  removeTab(closePrompt);
                  setClosePrompt(null);
                }}
              >
                放弃修改
              </button>
              <button
                type="button"
                className={`${c.btn} ${c.btnPrimary}`}
                onClick={() => void saveAndClose()}
                disabled={saving != null}
              >
                保存并关闭
              </button>
            </>
          }
        >
          <p className={c.meta}>保存后再关闭，或放弃本次修改；取消则保持当前标签不变。</p>
        </Modal>
      ) : null}

      {/* 离开页面：保存 / 放弃 / 取消 */}
      {pendingHash ? (
        <Modal
          title="离开前保存修改？"
          desc={`有 ${dirtyTabs.length} 个文件存在未保存修改。`}
          onClose={() => setPendingHash(null)}
          width={460}
          testId="skill-leave-prompt"
          footer={
            <>
              <button type="button" className={c.btn} onClick={() => setPendingHash(null)} disabled={leaveBusy}>
                取消
              </button>
              <button type="button" className={c.btn} onClick={() => void leave('discard')} disabled={leaveBusy}>
                放弃修改并离开
              </button>
              <button
                type="button"
                className={`${c.btn} ${c.btnPrimary}`}
                onClick={() => void leave('save')}
                disabled={leaveBusy}
              >
                {leaveBusy ? '正在保存…' : '保存并离开'}
              </button>
            </>
          }
        >
          {leaveError ? <p className={s.errorText}>{leaveError}</p> : <p className={c.meta}>保存全部修改后再离开。</p>}
        </Modal>
      ) : null}
    </section>
  );
}

function TreeNode({
  node,
  depth,
  expanded,
  active,
  onToggle,
  onOpen,
}: {
  node: SkillFileNode;
  depth: number;
  expanded: Set<string>;
  active: string | null;
  onToggle: (relPath: string) => void;
  onOpen: (relPath: string) => void;
}) {
  const isDir = node.type === 'dir';
  const open = isDir && expanded.has(node.relPath);
  return (
    <>
      <button
        type="button"
        className={`${s.treeRow} ${active === node.relPath ? s.treeRowActive : ''}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => (isDir ? onToggle(node.relPath) : onOpen(node.relPath))}
        data-testid={isDir ? 'skill-tree-dir' : 'skill-tree-file'}
        data-rel-path={node.relPath}
        title={node.relPath}
      >
        {isDir ? (
          <span className={open ? `${s.treeCaret} ${s.treeCaretOpen}` : s.treeCaret} />
        ) : (
          <span className={s.treeCaretBlank} />
        )}
        <span className={s.treeName}>{node.name}</span>
        {!isDir ? <span className={s.treeSize}>{formatSize(node.size)}</span> : null}
      </button>
      {isDir && open
        ? orderedChildren(node).map((child) => (
            <TreeNode
              key={child.relPath}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              active={active}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))
        : null}
    </>
  );
}
