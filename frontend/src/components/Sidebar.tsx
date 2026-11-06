import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ConversationListItem } from '../../../backend/src/shared/ipc';
import { request } from '../ipc/client';
import { subscribeConversationEvents, subscribeSessionsChanged } from '../ipc/conversation-events';
import { navigate, type RouteId } from '../router';
import {
  AgentIcon,
  BackupIcon,
  ChatIcon,
  EllipsisIcon,
  FolderIcon,
  HomeIcon,
  InstallIcon,
  LibraryIcon,
  SettingsIcon,
} from './icons';
import s from './Sidebar.module.css';

interface NavItemDef {
  id: RouteId;
  label: string;
  icon: ReactNode;
}

const PRIMARY: NavItemDef[] = [
  { id: 'home', label: '主页', icon: <HomeIcon /> },
  { id: 'library', label: 'Skills 中心库', icon: <LibraryIcon /> },
  { id: 'install', label: '安装 Skills', icon: <InstallIcon /> },
  { id: 'backup', label: '备份 Skills', icon: <BackupIcon /> },
  { id: 'agents', label: 'Agents', icon: <AgentIcon /> },
  { id: 'chat', label: '新对话', icon: <ChatIcon /> },
];

const SETTINGS: NavItemDef = { id: 'settings', label: '设置', icon: <SettingsIcon /> };

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  cancelling: '中断中',
  failed: '失败',
  cancelled: '已中断',
};

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * 会话行的相对时间：刚刚 / n分钟 / n小时 / n天 / n个月 / n年。
 * 分桶口径与 DSH ui-primitives relative-time 一致（30 天进「个月」，365 天进「年」）。
 */
function relativeLabel(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const diff = Math.max(0, now - at);
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分钟`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}天`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}个月`;
  return `${Math.floor(diff / (365 * DAY))}年`;
}

function NavItem({ def, active, onClick, hideIcon = false }: { def: NavItemDef; active: boolean; onClick?: () => void; hideIcon?: boolean }) {
  return (
    <button
      type="button"
      className={`${s.item} ${active ? s.itemActive : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick ?? (() => navigate(def.id))}
      data-testid={`nav-${def.id}`}
    >
      {hideIcon ? null : <span className={s.icon}>{def.icon}</span>}
      <span className={s.label}>{def.label}</span>
    </button>
  );
}

/**
 * 会话列表项：当前会话用底色 + 加粗 + 左侧标识区分（ui.md「当前会话可区分」）。
 * 右侧默认显示最近更新时间，鼠标移入后同一位置换成「⋯」（ui.md「会话行操作」）。
 */
function SessionItem({
  item,
  active,
  now,
  menuOpen,
  onOpen,
  onMenu,
}: {
  item: ConversationListItem;
  active: boolean;
  now: number;
  menuOpen: boolean;
  onOpen: () => void;
  onMenu: (anchor: HTMLElement) => void;
}) {
  const running = item.running || item.status === 'running' || item.status === 'queued';
  const failed = item.status === 'failed';
  const cancelled = item.status === 'cancelled';
  return (
    <div
      className={`${s.session} ${active ? s.sessionActive : ''}`}
      onClick={onOpen}
      data-testid="session-item"
      data-session-id={item.id}
      data-active={active ? 'true' : 'false'}
      data-menu-open={menuOpen ? 'true' : undefined}
    >
      <button
        type="button"
        className={s.sessionOpen}
        aria-current={active ? 'true' : undefined}
        title={item.lastMessagePreview ?? item.title}
      >
        {running || failed || cancelled ? (
          <span
            className={`${s.sessionDot} ${running ? s.sessionDotRunning : failed ? s.sessionDotError : s.sessionDotOff}`}
            aria-label={STATUS_LABEL[item.status] ?? item.status}
          />
        ) : null}
        <span className={s.sessionTitle}>{item.title}</span>
      </button>
      <span className={s.sessionTrailing}>
        <span className={s.sessionTime}>{relativeLabel(item.updatedAt, now)}</span>
        <button
          type="button"
          className={s.sessionMore}
          aria-label={`${item.title} 的会话操作`}
          data-testid="session-more"
          onClick={(event) => {
            // 菜单按钮的动作是「打开菜单」，不是「打开会话」
            event.stopPropagation();
            onMenu(event.currentTarget);
          }}
        >
          <EllipsisIcon size={14} />
        </button>
      </span>
    </div>
  );
}

/**
 * 左侧固定导航：主导航 + 可滚动会话列表 + 底部设置（design.md「导航、会话列表和分栏」）。
 * 会话列表真实读取 `conversation:list`，创建/运行状态变化时自动刷新（T15）。
 */
/**
 * 右键菜单锚定光标：成熟软件（资源管理器 / VS Code）都在指针处弹出，
 * 而不是贴行的边角；贴边时向左/向上翻转，避免被视口裁掉。
 * 尺寸取文件夹菜单的最大情形（最长项「新建文件夹」约 90 宽、两项约 76 高）。
 */
function contextMenuPosition(event: { clientX: number; clientY: number }): { top: number; left: number } {
  const MENU_WIDTH = 100;
  const MENU_HEIGHT = 76;
  return {
    left: Math.max(4, Math.min(event.clientX, window.innerWidth - MENU_WIDTH)),
    top: Math.max(4, Math.min(event.clientY, window.innerHeight - MENU_HEIGHT)),
  };
}

export function Sidebar({ active, activeSessionId, libraryFolder }: { active: RouteId; activeSessionId: string | null; libraryFolder: string | null }) {
  const [libraryExpanded, setLibraryExpanded] = useState(Boolean(libraryFolder));
  const [libraryFolders, setLibraryFolders] = useState<string[]>([]);
  /** 文件夹右键菜单：folder = null 表示「Skills 中心库」行本身；confirmRemove 为删除二次确认态 */
  const [folderMenu, setFolderMenu] = useState<{ folder: string | null; top: number; left: number; confirmRemove?: boolean } | null>(null);
  /** 内联输入：create 在列表末尾新增一行，rename 把目标行变成输入框 */
  const [folderEdit, setFolderEdit] = useState<{ mode: 'create' | 'rename'; from: string; value: string } | null>(null);
  const [sessions, setSessions] = useState<ConversationListItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** 会话行的「⋯」菜单：记录被点开的会话与弹出坐标（fixed，避免被列表滚动区裁剪） */
  const [menu, setMenu] = useState<{ sessionId: string; top: number; left: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reload = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const result = await request('library:folders');
      if (alive && result.ok) setLibraryFolders(result.data.folders);
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, []);

  useEffect(() => {
    if (libraryFolder) setLibraryExpanded(true);
  }, [libraryFolder]);

  /** 文件夹增删改后立即重拉侧边栏列表（listFolders 按磁盘实时枚举）。 */
  const refreshFolders = useCallback(async () => {
    const result = await request('library:folders');
    if (result.ok) setLibraryFolders(result.data.folders);
  }, []);

  /** 提交内联输入：create 新建文件夹，rename 改名；失败把原因留在侧边栏提示条。 */
  async function submitFolderEdit() {
    const edit = folderEdit;
    if (!edit) return;
    const name = edit.value.trim();
    if (name.length === 0) {
      setFolderEdit(null);
      return;
    }
    const result = edit.mode === 'create'
      ? await request('library:createFolder', { name })
      : await request('library:renameFolder', { from: edit.from, to: name });
    if (!result.ok) {
      setActionError(result.error?.detail ?? '操作失败');
      return;
    }
    setFolderEdit(null);
    await refreshFolders();
    // 正在看这个文件夹时跟着改名，否则页面会停在一个已不存在的 folder 上
    if (edit.mode === 'rename' && libraryFolder === edit.from) navigate('library', { folder: name });
  }

  /** 删除文件夹：技能由后端移到库根，再按原落点重建 Agent 链接；失败项逐条提示。 */
  async function removeFolder(folder: string) {
    const result = await request('library:removeFolder', { name: folder });
    setFolderMenu(null);
    if (!result.ok) {
      setActionError(result.error?.detail ?? '删除失败');
      return;
    }
    await refreshFolders();
    if (libraryFolder === folder) navigate('library');
    const failures = result.data.relinkFailures;
    if (failures.length > 0) {
      setActionError(`${failures.length} 个链接未重建：${failures.map((item) => `${item.dirName}（${item.agentName}）`).join('、')}`);
    }
  }

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;

    const load = async () => {
      const result = await request('conversation:list');
      if (!alive) return;
      setLoaded(true);
      if (result.ok) setSessions(result.data.items);
    };
    reload.current = load;

    const schedule = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void load();
      }, 220);
    };

    void load();
    const offEvents = subscribeConversationEvents((event) => {
      if (event.type === 'status' || event.type === 'done' || event.type === 'error') schedule();
    });
    const offChanged = subscribeSessionsChanged(schedule);
    // 切页时也刷新一次（例如从中心库行菜单「编辑/评测」新建了会话）
    window.addEventListener('hashchange', schedule);
    return () => {
      alive = false;
      offEvents();
      offChanged();
      window.removeEventListener('hashchange', schedule);
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  // 相对时间每分钟重算一次，避免「刚刚」长住不动
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (actionError == null) return;
    const timer = window.setTimeout(() => setActionError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [actionError]);

  // 菜单/内联输入打开期间 Esc 关闭
  useEffect(() => {
    if (menu == null && folderMenu == null && folderEdit == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenu(null);
      setFolderMenu(null);
      setFolderEdit(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, folderMenu, folderEdit]);

  const openMenu = useCallback((sessionId: string, anchor: HTMLElement) => {
    // 用整行的位置定位：菜单按钮在 hover 之前是隐藏的，自身 rect 不可靠
    const row = anchor.closest('[data-testid="session-item"]') ?? anchor;
    const rect = row.getBoundingClientRect();
    const width = 144;
    const height = 38;
    const below = rect.bottom + 4;
    const top = below + height > window.innerHeight ? Math.max(8, rect.top - height - 4) : below;
    setMenu({
      sessionId,
      top,
      left: Math.max(8, Math.min(Math.round(rect.right - width), window.innerWidth - width - 8)),
    });
  }, []);

  /** 归档会话＝删除会话记录与运行日志（不可恢复）。删当前会话时回到空白新对话。 */
  const archiveSession = async (sessionId: string) => {
    setMenu(null);
    const result = await request('conversation:delete', { sessionId });
    if (!result.ok) {
      setActionError(result.error?.detail ?? '归档失败');
      return;
    }
    if (sessionId === activeSessionId) navigate('chat');
    await reload.current();
  };

  return (
    <aside className={s.sidebar}>
      <nav className={s.nav} aria-label="主导航">
        {PRIMARY.map((def) => def.id === 'library' ? (
          <div key={def.id}>
            <div
              className={s.libraryNavRow}
              onContextMenu={(event) => {
                event.preventDefault();
                setLibraryExpanded(true);
                setFolderMenu({ folder: null, ...contextMenuPosition(event) });
              }}
            >
              <button
                type="button"
                className={s.libraryToggle}
                aria-label={libraryExpanded ? '折叠中心库文件夹' : '展开中心库文件夹'}
                aria-expanded={libraryExpanded}
                onClick={() => setLibraryExpanded((value) => !value)}
                data-testid="library-folder-toggle"
              >
                <span className={libraryExpanded ? s.chevronOpen : s.chevron}>›</span>
              </button>
              <NavItem def={def} active={active === 'library' && !libraryFolder} onClick={() => navigate('library')} hideIcon />
            </div>
            {libraryExpanded ? (
              <div className={s.libraryFolders} aria-label="中心库文件夹" data-testid="library-folders">
                {libraryFolders.map((folder) => (
                  folderEdit?.mode === 'rename' && folderEdit.from === folder ? (
                    <div key={folder} className={s.folderEditing}>
                      <FolderIcon size={16} />
                      <input
                        className={s.folderInput}
                        value={folderEdit.value}
                        autoFocus
                        onChange={(event) => setFolderEdit({ ...folderEdit, value: event.target.value })}
                        onBlur={() => void submitFolderEdit()}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                        aria-label={`重命名文件夹 ${folder}`}
                        data-testid="library-folder-input"
                      />
                    </div>
                  ) : (
                    <button
                      key={folder}
                      type="button"
                      className={`${s.folderItem} ${active === 'library' && libraryFolder === folder ? s.itemActive : ''}`}
                      aria-current={active === 'library' && libraryFolder === folder ? 'page' : undefined}
                      title={folder}
                      onClick={() => navigate('library', { folder })}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setFolderMenu({ folder, ...contextMenuPosition(event) });
                      }}
                    >
                      <FolderIcon size={16} />
                      <span className={s.label}>{folder}</span>
                    </button>
                  )
                ))}
                {folderEdit?.mode === 'create' ? (
                  <div className={s.folderEditing}>
                    <FolderIcon size={16} />
                    <input
                      className={s.folderInput}
                      value={folderEdit.value}
                      autoFocus
                      placeholder="新建文件夹名"
                      onChange={(event) => setFolderEdit({ ...folderEdit, value: event.target.value })}
                      onBlur={() => void submitFolderEdit()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                      aria-label="新建文件夹名称"
                      data-testid="library-folder-input"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : <NavItem key={def.id} def={def} active={active === def.id} />)}
      </nav>

      <div className={s.divider} role="presentation" />

      <section className={s.sessions} aria-label="会话列表">
        <div className={s.sessionsLabel}>会话列表</div>
        {actionError ? <p className={s.sessionsError} role="alert">{actionError}</p> : null}
        <div className={s.sessionsList}>
          {sessions.length === 0 ? (
            <p className={s.sessionsEmpty}>
              {loaded ? '暂无会话' : '正在读取会话…'}
              {loaded ? <span className={s.sessionsEmptyHint}>在「新对话」中创建后显示</span> : null}
            </p>
          ) : (
            sessions.map((item) => (
              <SessionItem
                key={item.id}
                item={item}
                now={now}
                active={item.id === activeSessionId}
                menuOpen={menu?.sessionId === item.id}
                onOpen={() => {
                  if (item.id === activeSessionId) return;
                  navigate('chat', { session: item.id });
                }}
                onMenu={(anchor) => openMenu(item.id, anchor)}
              />
            ))
          )}
        </div>
      </section>

      <div className={s.footer}>
        <NavItem def={SETTINGS} active={active === 'settings'} />
      </div>

      {folderMenu ? (
        <>
          <div className={s.menuBackdrop} role="presentation" onMouseDown={() => setFolderMenu(null)} />
          <div
            className={s.menu}
            style={{ top: folderMenu.top, left: folderMenu.left }}
            role="menu"
            data-testid="library-folder-menu"
          >
            {folderMenu.folder == null ? (
              <button
                type="button"
                role="menuitem"
                className={s.menuItem}
                data-testid="library-folder-create"
                onClick={() => {
                  setFolderMenu(null);
                  setLibraryExpanded(true);
                  setFolderEdit({ mode: 'create', from: '', value: '' });
                }}
              >
                新建文件夹
              </button>
            ) : folderMenu.confirmRemove ? (
              <button
                type="button"
                role="menuitem"
                className={s.menuItem}
                data-testid="library-folder-remove-confirm"
                onClick={() => void removeFolder(folderMenu.folder ?? '')}
              >
                确认删除
              </button>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={s.menuItem}
                  data-testid="library-folder-rename"
                  onClick={() => {
                    const folder = folderMenu.folder ?? '';
                    setFolderMenu(null);
                    setFolderEdit({ mode: 'rename', from: folder, value: folder });
                  }}
                >
                  重命名
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={s.menuItem}
                  data-testid="library-folder-remove"
                  onClick={() => setFolderMenu((prev) => (prev ? { ...prev, confirmRemove: true } : prev))}
                >
                  删除
                </button>
              </>
            )}
          </div>
        </>
      ) : null}

      {menu ? (
        <>
          <div className={s.menuBackdrop} role="presentation" onMouseDown={() => setMenu(null)} />
          <div
            className={s.menu}
            style={{ top: menu.top, left: menu.left }}
            role="menu"
            data-testid="session-menu"
          >
            <button
              type="button"
              role="menuitem"
              className={s.menuItem}
              data-testid="session-archive"
              onClick={() => void archiveSession(menu.sessionId)}
            >
              归档会话
            </button>
          </div>
        </>
      ) : null}
    </aside>
  );
}
