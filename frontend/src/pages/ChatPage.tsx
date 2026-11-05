import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ConversationEvent,
  ConversationFileChangeView,
  ConversationFileView,
  ConversationMessageView,
  ConversationView,
  ProviderModelsResult,
  ThinkingLevel,
} from '../../../backend/src/shared/ipc';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { ConversationDiffModal } from '../components/ConversationDiffModal';
import { PageHeader } from '../components/PageHeader';
import { SlashMenu, type SlashCandidate } from '../components/SlashMenu';
import { detectSlashToken, rankByName, type SlashToken } from '../components/slash-trigger';
import { ArrowUpIcon, ChevronDownIcon, CloseIcon, FileIcon, StopIcon } from '../components/icons';
import { navigate, navigateToHash, type Route } from '../router';
import { request } from '../ipc/client';
import { notifySessionsChanged, useConversationEvents } from '../ipc/conversation-events';
import { DshDocumentViewer } from '../components/DshDocumentViewer';
import dock from '../vendor/dsh-ui/dockkit/dockkit.module.css';
import preview from '../vendor/dsh-ui/document/TextPreview.module.css';
import group from '../vendor/dsh-ui/chat/ChatGroupSeat.module.css';
import assistant from '../vendor/dsh-ui/chat/AssistantMarkdown.module.css';
import flow from '../vendor/dsh-ui/chat/ChatView.module.css';
import userMessage from '../vendor/dsh-ui/chat/MessageItem.module.css';
import { PathLabel } from '../vendor/dsh-ui/document/PathLabel';
import { MarkdownText } from '../vendor/dsh-primitives/markdown/MarkdownText';
import { FileTypeIcon } from '../vendor/dsh-primitives/FileTypeIcon';
import c from '../styles/common.module.css';
import s from './ChatPage.module.css';

type Workflow = 'create' | 'improve' | 'evaluate';

interface FileTab {
  key: string;
  kind: 'file' | 'report';
  relPath: string;
  absolutePath: string | null;
  name: string;
  content: string | null;
  base64: string | null;
  mediaType: string | null;
  reason: string | null;
  loading: boolean;
  error: string | null;
}

const REASON_TEXT: Record<string, string> = {
  BINARY: '暂不支持预览此文件',
  TOO_LARGE: '文件超过预览大小上限',
  NOT_A_FILE: '不是可预览文件',
  MISSING: '文件不存在',
};

const STATUS_TEXT: Record<string, string> = {
  queued: '已排队',
  running: '运行中',
  cancelling: '中断中',
  done: '已完成',
  failed: '失败',
  cancelled: '已中断',
};

const markdownLabels = {
  code: {
    copyLabel: '复制',
    copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '不换行' },
  },
  footnotes: '脚注',
};

/** 推理强度显示名：沿用 Pi 的枚举名，不做本地化改写（与协议参数一一对应）。 */
const THINKING_LABEL: Record<ThinkingLevel, string> = {
  low: 'Low',
  high: 'High',
  max: 'Max',
};

function basename(relPath: string): string {
  const parts = relPath.split('/');
  return parts[parts.length - 1] || relPath;
}

function errorText(error: { code: string; detail?: string }): string {
  return error.detail && error.detail.trim().length > 0 ? error.detail : error.code;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

function chars(text: string): number {
  return [...text].length;
}

/** 文件区宽度记忆：拖过就记住，没拖过用 CSS 默认 clamp(400px, 38vw, 760px)。 */
const PANEL_WIDTH_KEY = 'chat.filePanelWidth';
/** 文件区最小宽度 */
const PANEL_MIN_WIDTH = 320;
/** 拖拽时为对话区预留的最小宽度 */
const CONVERSATION_MIN_WIDTH = 480;
/** 键盘方向键单次调整幅度 */
const PANEL_KEY_STEP = 24;

/** 文件区「打开方式」候选（顺序即菜单顺序；预览仅在有渲染器时出现） */
const VIEWER_OPTIONS: ReadonlyArray<{ id: 'rendered' | 'code' | 'plain'; label: string }> = [
  { id: 'rendered', label: '预览' },
  { id: 'code', label: '代码' },
  { id: 'plain', label: '文本' },
];

function readStoredPanelWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTH_KEY);
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function storePanelWidth(value: number | null): void {
  try {
    if (value == null) window.localStorage.removeItem(PANEL_WIDTH_KEY);
    else window.localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(value)));
  } catch {
    /* 存不下不影响本次拖拽结果 */
  }
}

/** DSH pane chrome uses small outline glyphs; the source pane supplies these controls. */
function PaneGlyph({ kind }: { kind: 'split' | 'fullscreen' | 'collapse' | 'refresh' | 'wrap' | 'folder' | 'chevron' }) {
  const paths: Record<typeof kind, ReactNode> = {
    split: <><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M8 2.5v11" /></>,
    fullscreen: <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" />,
    collapse: <><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M10 2.5v11" /></>,
    refresh: <><path d="M13 7a5 5 0 1 0 .1 2" /><path d="M13 3.5V7H9.5" /></>,
    wrap: <><path d="M2 4h12M2 7h9a2 2 0 1 1 0 4H7" /><path d="m9 9-2 2 2 2M2 13h3" /></>,
    folder: <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />,
    chevron: <path d="m5 6.5 3 3 3-3" />,
  };
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

/**
 * 新对话（ui.md「新对话」、tec.md §5.8/§5.9、prd.md M8/M9）：
 * 左侧（外壳）会话列表 | 中间对话主区 | 右侧文件区。
 *
 * - 三个快捷项只预填可编辑提示词，不运行；优化/评测需先选目标 Skill；
 * - 运行中逐字增量、工具摘要、可中断；完成后可继续发送；
 * - 文件卡 → 右侧只读预览（多标签，按文件类型展示）；
 * - skill-doctor 结果以文本打开（不设独立报告页）。
 */
export function ChatPage({ route }: { route: Route }) {
  const routeSession = route.query.get('session');
  const legacyFile = route.query.get('file');
  const [activeId, setActiveId] = useState<string | null>(routeSession);
  const [view, setView] = useState<ConversationView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [quickIntent, setQuickIntent] = useState<Workflow | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{
    kind: 'error' | 'info';
    text: string;
    action: 'settings' | 'models' | null;
  } | null>(null);

  const [models, setModels] = useState<ProviderModelsResult | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingThinking, setPendingThinking] = useState<ThinkingLevel | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  /** 弹层当前展开的层级：root = 模型/推理强度两行；model / thinking = 各自的列表 */
  const [modelMenuView, setModelMenuView] = useState<'root' | 'model' | 'thinking'>('root');
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [addModelValue, setAddModelValue] = useState('');
  const [addModelBusy, setAddModelBusy] = useState(false);

  /** 输入 `/` 时的候选层：token 定插入范围，candidates 是过滤后的内部 Skill */
  const [slash, setSlash] = useState<{
    token: SlashToken;
    candidates: readonly SlashCandidate[];
    highlight: number;
  } | null>(null);
  const slashSkills = useRef<SlashCandidate[] | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inputShellRef = useRef<HTMLDivElement | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [changeFor, setChangeFor] = useState<{ runId: string; files: ConversationFileChangeView[] } | null>(null);
  const [panelFullscreen, setPanelFullscreen] = useState(false);
  const [panelSplit, setPanelSplit] = useState(false);
  /** 文件区宽度（px）；null = 用 CSS 默认值 */
  const [panelWidth, setPanelWidth] = useState<number | null>(() => readStoredPanelWidth());
  const [panelResizing, setPanelResizing] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const panelWidthRef = useRef<number | null>(panelWidth);
  panelWidthRef.current = panelWidth;
  const [viewerMode, setViewerMode] = useState<Record<string, 'rendered' | 'code' | 'plain'>>({});
  const [wrapByTab, setWrapByTab] = useState<Record<string, boolean>>({});
  const [viewerMenuOpen, setViewerMenuOpen] = useState(false);
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const tabsRef = useRef<FileTab[]>([]);
  tabsRef.current = tabs;
  const activeTab = useMemo(() => tabs.find((tab) => tab.key === activeKey) ?? null, [tabs, activeKey]);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const running =
    view?.running === true ||
    view?.status === 'running' ||
    view?.status === 'queued' ||
    view?.status === 'cancelling';
  const canSend = draft.trim().length > 0 && !sending;

  // ── 载入会话 ────────────────────────────────────────────────────────────
  const loadSession = useCallback(async (sessionId: string, applyDraft: boolean) => {
    setLoading(true);
    const result = await request('conversation:get', { sessionId });
    setLoading(false);
    if (!result.ok) {
      setView(null);
      setLoadError(errorText(result.error));
      return;
    }
    setLoadError(null);
    setView(result.data);
    if (applyDraft) setDraft(result.data.draftPrompt ?? '');
  }, []);

  useEffect(() => {
    setActiveId(routeSession);
    setChangeFor(null);
  }, [routeSession]);

  useEffect(() => {
    setView(null);
    setNotice(null);
    setTabs([]);
    setActiveKey(null);
    setPanelOpen(false);
    setPanelFullscreen(false);
    setPanelSplit(false);
    setViewerMenuOpen(false);
    setLoadError(null);
    setQuickIntent(null);
    if (!activeId) {
      setDraft('');
      return;
    }
    void loadSession(activeId, true);
  }, [activeId, loadSession]);

  // 模型菜单数据（当前生效供应商已添加的模型）
  const loadModels = useCallback(async () => {
    const result = await request('providers:models');
    if (result.ok) setModels(result.data);
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels, activeId]);

  // 消息区跟随到底部（新消息与增量）
  const messageSignature = view
    ? `${view.messages.length}:${view.messages.reduce((sum, m) => sum + m.text.length, 0)}:${view.files.length}`
    : '0';
  useEffect(() => {
    const node = messagesRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messageSignature, view?.status]);

  // ── 事件流 ──────────────────────────────────────────────────────────────
  const handleEvent = useCallback(
    (event: ConversationEvent) => {
      if (!activeId || event.sessionId !== activeId) return;
      if (event.type === 'status') {
        setView((prev) =>
          prev
            ? {
                ...prev,
                status: event.status,
                running: event.status === 'running' || event.status === 'queued' || event.status === 'cancelling',
              }
            : prev,
        );
        notifySessionsChanged();
        if (event.status === 'cancelling') setSending(false);
        // 终态（含工作流后处理完成后的刷新信号）：以持久化记录为准
        if (event.status === 'done' || event.status === 'failed' || event.status === 'cancelled') {
          setSending(false);
          void loadSession(event.sessionId, false);
        }
        return;
      }
      if (event.type === 'message') {
        setView((prev) => {
          if (!prev) return prev;
          const messages = [...prev.messages];
          const index = messages.findIndex((item) => item.messageId === event.messageId);
          if (index < 0) {
            messages.push({
              messageId: event.messageId,
              role: event.role,
              text: event.text ?? event.delta ?? '',
              at: event.at,
              status: event.final ? 'complete' : 'streaming',
              toolCalls: [],
              fileChanges: [],
              usage: null,
            });
          } else {
            const current = messages[index];
            messages[index] = {
              ...current,
              text: event.final ? (event.text ?? current.text) : `${current.text}${event.delta ?? ''}`,
              status: event.final ? (current.status === 'failed' ? 'failed' : 'complete') : 'streaming',
            };
          }
          return { ...prev, messages };
        });
        return;
      }
      if (event.type === 'tool') {
        setView((prev) => {
          if (!prev) return prev;
          const messages = [...prev.messages];
          let index = -1;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
              index = i;
              break;
            }
          }
          if (index < 0) return prev;
          const message = messages[index];
          const calls = [...message.toolCalls];
          const callIndex = calls.findIndex((call) => call.id === event.toolCallId);
          const next = {
            id: event.toolCallId,
            name: event.name,
            summary: event.summary,
            isError: event.isError === true,
          };
          if (callIndex >= 0) calls[callIndex] = { ...calls[callIndex], ...next };
          else calls.push(next);
          messages[index] = { ...message, toolCalls: calls };
          return { ...prev, messages };
        });
        return;
      }
      if (event.type === 'usage') {
        setView((prev) =>
          prev
            ? {
                ...prev,
                lastRun: prev.lastRun
                  ? { ...prev.lastRun, totalTokens: event.usage.totalTokens, durationMs: event.durationMs }
                  : prev.lastRun,
              }
            : prev,
        );
        return;
      }
      if (event.type === 'file') {
        setView((prev) => {
          if (!prev) return prev;
          const files = [...prev.files];
          const index = files.findIndex((file) => file.relPath === event.relPath);
          const entry: ConversationFileView = {
            relPath: event.relPath,
            bytes: event.bytes,
            exists: true,
            at: event.at,
          };
          if (index >= 0) files[index] = entry;
          else files.push(entry);
          return { ...prev, files };
        });
        return;
      }
      if (event.type === 'error') {
        setNotice({
          kind: 'error',
          text: `${event.detail}（${event.code}）`,
          action: event.code === 'NO_MODEL_CONFIGURED' ? 'settings' : null,
        });
        return;
      }
      if (event.type === 'done') {
        setSending(false);
        notifySessionsChanged();
        // 终态以持久化记录为准（报告、文件、状态、用量）
        void loadSession(event.sessionId, false);
      }
    },
    [activeId, loadSession],
  );

  useConversationEvents(handleEvent);

  // ── 发送 / 停止 ─────────────────────────────────────────────────────────
  async function ensureSession(): Promise<string | null> {
    if (activeId) return activeId;
    const result = await request('conversation:create', { mode: 'blank' });
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result.error), action: null });
      return null;
    }
    if (result.data.error) {
      setNotice({ kind: 'error', text: result.data.error.detail, action: result.data.error.action });
      return null;
    }
    const id = result.data.sessionId;
    if (!id) {
      setNotice({ kind: 'error', text: '无法创建会话', action: null });
      return null;
    }
    if (pendingModel || pendingThinking) {
      await applyPendingPreferences(id);
    }
    setActiveId(id);
    navigateToHash(`#/chat?session=${encodeURIComponent(id)}`);
    notifySessionsChanged();
    return id;
  }

  async function send(mode: 'queue' | 'steer' = 'queue') {
    const text = draft.trim();
    const workflowIntent = quickIntent ?? undefined;
    if (!text || sending) return;
    setSending(true);
    setNotice(null);
    try {
      const sessionId = await ensureSession();
      if (!sessionId) return;
      const result = await request('conversation:send', { sessionId, text, mode, workflowIntent });
      if (!result.ok) {
        setNotice({ kind: 'error', text: errorText(result.error), action: null });
        return;
      }
      if (result.data.error) {
        setNotice({ kind: 'error', text: result.data.error.detail, action: result.data.error.action });
        return;
      }
      setDraft('');
      setQuickIntent(null);
      setSlash(null);
      // 让用户消息立即出现（事件流也会推送，按 messageId 去重）
      void loadSession(sessionId, false);
      notifySessionsChanged();
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!activeId) return;
    setSending(false);
    const result = await request('conversation:cancel', { sessionId: activeId });
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result.error), action: null });
      return;
    }
    await loadSession(activeId, false);
    notifySessionsChanged();
  }

  // ── `/` 补全（照 DSH：选中即插入字面 "/name "，不改变会话绑定） ──────────

  /** 工作台 Agent 的内部 Skill 清单；同一轮编辑内复用，重新敲 `/` 时重读（新投放的 Skill 立即可见）。 */
  const loadSlashSkills = useCallback(async (): Promise<SlashCandidate[]> => {
    const cached = slashSkills.current;
    if (cached) return cached;
    const result = await request('conversation:skills', undefined);
    if (!result.ok) return [];
    const list = result.data.items;
    slashSkills.current = list;
    return list;
  }, []);

  /** 按当前草稿与光标刷新候选层；斜杠标记不成立时关闭。 */
  const syncSlash = useCallback(
    (text: string, caret: number) => {
      const token = detectSlashToken(text, caret);
      if (!token) {
        // 关闭即清空清单缓存：下次重敲 `/` 重新读 agents/skills（用户随时投放的 Skill 不必重启）
        slashSkills.current = null;
        setSlash(null);
        return;
      }
      void loadSlashSkills().then((skills) => {
        if (skills.length === 0) {
          setSlash(null);
          return;
        }
        const candidates = rankByName(skills, token.query);
        setSlash((prev) => ({
          token,
          candidates,
          // 同一个 token 继续输入时保留高亮，换了位置则从第一项开始
          highlight:
            prev && prev.token.start === token.start && prev.highlight < candidates.length ? prev.highlight : 0,
        }));
      });
    },
    [loadSlashSkills],
  );

  /** 选中候选：把 token 整段换成 "/name "，光标落在其后。 */
  const pickSlash = (item: SlashCandidate) => {
    if (!slash) return;
    const insert = `/${item.name} `;
    const next = draft.slice(0, slash.token.start) + insert + draft.slice(slash.token.end);
    const caret = slash.token.start + insert.length;
    setDraft(next);
    setSlash(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  // 菜单打开时点击输入卡以外的地方关闭（与 DSH 的 pointerdown 口径一致）
  useEffect(() => {
    if (!slash) return;
    const onPointerDown = (event: PointerEvent) => {
      const shell = inputShellRef.current;
      if (shell && event.target instanceof Node && shell.contains(event.target)) return;
      setSlash(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [slash]);

  // ── 快捷项 ──────────────────────────────────────────────────────────────
  /** 点快捷项 = 预填该 skill 的提示词（不建会话、不弹框、不运行）。 */
  async function insertQuickPrompt(mode: Workflow) {
    setNotice(null);
    const result = await request('conversation:prompt', { mode });
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result.error), action: null });
      return;
    }
    const text = result.data.prompt;
    setQuickIntent(mode);
    const el = textareaRef.current;
    setDraft(text);
    setSlash(null);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }

  async function pickModel(modelId: string) {
    setModelMenuOpen(false);
    setModelMenuView('root');
    if (!activeId) {
      setPendingModel(modelId);
      return;
    }
    const result = await request('conversation:setModel', { sessionId: activeId, modelId });
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result.error), action: null });
      return;
    }
    setView((prev) => (prev ? { ...prev, modelId } : prev));
    void loadModels();
    // 换模型后可用档位随之变化（例：v4-pro 没有 low），重取一次会话以拿到归一后的强度
    void loadSession(activeId, false);
  }

  async function pickThinking(level: ThinkingLevel) {
    setModelMenuOpen(false);
    setModelMenuView('root');
    if (!activeId) {
      setPendingThinking(level);
      return;
    }
    const result = await request('conversation:setThinkingLevel', { sessionId: activeId, thinkingLevel: level });
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result.error), action: null });
      return;
    }
    setView((prev) => (prev ? { ...prev, thinkingLevel: level } : prev));
  }

  /**
   * 空白会话在首次发送时才建会话：把用户事先选的模型与强度补写进去。
   * 强度写不进去（换了模型后该档不适用）不阻断发送，后端会归一为默认档。
   */
  async function applyPendingPreferences(sessionId: string) {
    if (pendingModel) {
      await request('conversation:setModel', { sessionId, modelId: pendingModel });
      setPendingModel(null);
    }
    if (pendingThinking) {
      const level = pendingThinking;
      setPendingThinking(null);
      await request('conversation:setThinkingLevel', { sessionId, thinkingLevel: level });
    }
  }

  async function addModel() {
    const modelId = addModelValue.trim();
    if (!modelId) return;
    setAddModelBusy(true);
    const result = await request('providers:addModel', { modelId });
    setAddModelBusy(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result.error), action: null });
      return;
    }
    setModels(result.data);
    setAddModelOpen(false);
    setAddModelValue('');
    await pickModel(modelId);
  }

  // ── 文件区 ──────────────────────────────────────────────────────────────
  const openFile = useCallback(
    async (relPath: string, force = false) => {
      const key = `file:${relPath}`;
      setPanelOpen(true);
      setActiveKey(key);
      if (tabsRef.current.some((tab) => tab.key === key) && !force) return;
      const placeholder: FileTab = {
        key,
        kind: 'file',
        relPath,
        absolutePath: null,
        name: basename(relPath),
        content: null,
        base64: null,
        mediaType: null,
        reason: null,
        loading: true,
        error: null,
      };
      setTabs((prev) => (prev.some((tab) => tab.key === key)
        ? prev.map((tab) => tab.key === key ? { ...tab, loading: true, error: null } : tab)
        : [...prev, placeholder]));
      if (!activeId) {
        setTabs((prev) =>
          prev.map((tab) => (tab.key === key ? { ...tab, loading: false, reason: 'MISSING' } : tab)),
        );
        return;
      }
      const result = await request('conversation:previewFile', { sessionId: activeId, relPath });
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.key !== key) return tab;
          if (!result.ok) return { ...tab, loading: false, error: errorText(result.error) };
          const data = result.data;
          return {
            ...tab,
            loading: false,
            reason: data.reason,
            absolutePath: data.absolutePath,
            content: data.content,
            base64: data.base64,
            mediaType: data.mediaType,
            error: null,
          };
        }),
      );
    },
    [activeId],
  );

  const openReport = useCallback(async (force = false) => {
    if (!activeId || !view?.report) return;
    const key = 'report';
    setPanelOpen(true);
    setActiveKey(key);
    if (tabsRef.current.some((tab) => tab.key === key) && !force) return;
    const tab: FileTab = {
      key,
      kind: 'report',
      relPath: view.report.relPath,
      absolutePath: view.report.absolutePath,
      name: view.report.fileName,
      content: view.report.text,
      base64: null,
      mediaType: 'text/markdown',
      reason: null,
      loading: view.report.text == null,
      error: null,
    };
    setTabs((prev) => (prev.some((item) => item.key === key)
      ? prev.map((item) => item.key === key ? { ...item, loading: force, error: null } : item)
      : [...prev, tab]));
    if (view.report.text != null && !force) return;
    const result = await request('library:report', { skillId: view.report.skillId });
    setTabs((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        if (!result.ok || !result.data.exists) {
          return { ...item, loading: false, error: result.ok ? '评测结果文件不存在' : errorText(result.error) };
        }
        const text = result.data.text ?? '';
        return { ...item, loading: false, content: text };
      }),
    );
  }, [activeId, view]);

  // T09 遗留深链：#/chat?file=SKILL.md（无会话时保持三栏布局可核对）
  useEffect(() => {
    if (!legacyFile) return;
    if (!view) {
      setPanelOpen(true);
      return;
    }
    const hit = view.files.find((file) => file.relPath === legacyFile);
    if (hit) void openFile(hit.relPath);
    // 只处理一次深链（按会话变化触发）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyFile, view?.sessionId]);


  function removeTab(key: string) {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.key === key);
    const next = current.filter((tab) => tab.key !== key);
    tabsRef.current = next;
    setTabs(next);
    if (activeKey === key) {
      const fallback = next[Math.max(0, index - 1)] ?? next[0] ?? null;
      setActiveKey(fallback?.key ?? null);
    }
    if (next.length === 0) setPanelOpen(false);
  }

  function refreshActiveTab() {
    if (!activeTab) return;
    if (activeTab.kind === 'report') void openReport(true);
    else void openFile(activeTab.relPath, true);
  }

  async function showActiveFileInFolder() {
    if (!activeTab) return;
    const result = activeTab.kind === 'report'
      ? await request('conversation:showReport', { skillId: view?.report?.skillId ?? '' })
      : await request('conversation:showFile', { sessionId: activeId ?? '', relPath: activeTab.relPath });
    if (!result.ok) setNotice({ kind: 'error', text: errorText(result.error), action: null });
  }

  // ── 派生展示 ────────────────────────────────────────────────────────────
  const currentModel = view?.modelId ?? pendingModel ?? models?.activeModelId ?? null;
  const modelOptions = models?.models ?? [];
  // 推理强度：会话视图是权威（后端已按模型能力归一），空白会话用供应商的模型能力表
  const thinkingLevels: ThinkingLevel[] = view?.thinkingLevels?.length
    ? view.thinkingLevels
    : (currentModel ? models?.modelThinkingLevels?.[currentModel] : undefined) ?? [];
  // 空白会话：沿用上次为该模型选的档（后端已按模型能力归一），未设置时优先 High
  const rememberedThinking = models?.activeThinkingLevel ?? null;
  const currentThinking =
    view?.thinkingLevel
    ?? pendingThinking
    ?? (rememberedThinking && thinkingLevels.includes(rememberedThinking) ? rememberedThinking : null)
    ?? (thinkingLevels.includes('high') ? 'high' : thinkingLevels.includes('max') ? 'max' : thinkingLevels[0])
    ?? null;
  const reportAvailable = Boolean(view?.report?.exists);
  const activeExt = activeTab?.relPath.split('.').pop()?.toLowerCase() ?? '';
  const hasRenderedViewer = ['md', 'markdown', 'html', 'htm', 'xhtml'].includes(activeExt);
  const canChangeViewer = activeTab?.content != null;
  const activeViewer = activeTab ? (viewerMode[activeTab.key] ?? (hasRenderedViewer ? 'rendered' : 'code')) : 'code';
  const activeWrap = activeTab ? (wrapByTab[activeTab.key] ?? false) : false;
  const subtitle = view
    ? `当前会话 · ${STATUS_TEXT[view.status] ?? view.status}`
    : '空白对话 · 选择快捷项或直接描述需求';
  const isEmptyConversation = !loadError && !loading && !running && (!view || view.messages.length === 0);
  const showQuickActions = isEmptyConversation && !sending && (activeId === null || view !== null);

  // ── 文件区宽度拖拽 ──────────────────────────────────────────────────────
  /** 把指针位置换算成合法的文件区宽度（受对话区最小宽度约束）。 */
  const widthFromPointer = useCallback((body: HTMLElement, clientX: number): number => {
    const rect = body.getBoundingClientRect();
    const maxWidth = Math.max(PANEL_MIN_WIDTH, rect.width - CONVERSATION_MIN_WIDTH);
    const raw = rect.right - clientX;
    return Math.round(Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, raw)));
  }, []);

  const beginPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const body = bodyRef.current;
      if (!body || event.button !== 0) return;
      event.preventDefault();
      const handle = event.currentTarget;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* 合成事件或指针已释放时捕获会失败，不影响后续拖拽 */
      }
      setPanelResizing(true);
      setPanelWidth(widthFromPointer(body, event.clientX));

      const onMove = (moveEvent: PointerEvent) => setPanelWidth(widthFromPointer(body, moveEvent.clientX));
      const onEnd = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        try {
          if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        } catch {
          /* 指针已释放 */
        }
        setPanelResizing(false);
        storePanelWidth(panelWidthRef.current);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    },
    [widthFromPointer],
  );

  /** 双击拖拽条：恢复 CSS 默认宽度 */
  const resetPanelWidth = useCallback(() => {
    setPanelWidth(null);
    storePanelWidth(null);
  }, []);

  const onPanelResizerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const body = bodyRef.current;
      if (!body) return;
      event.preventDefault();
      const rect = body.getBoundingClientRect();
      const maxWidth = Math.max(PANEL_MIN_WIDTH, rect.width - CONVERSATION_MIN_WIDTH);
      const current = rect.right - event.currentTarget.getBoundingClientRect().left;
      const delta = event.key === 'ArrowLeft' ? PANEL_KEY_STEP : -PANEL_KEY_STEP;
      const next = Math.round(Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, current + delta)));
      setPanelWidth(next);
      storePanelWidth(next);
    },
    [],
  );

  return (
    <section className={c.page}>
      <div className={s.body} ref={bodyRef}>
        <div className={`${s.conversation} ${isEmptyConversation ? s.conversationEmpty : ''}`}>
          {!isEmptyConversation ? <div className={s.chatHeader}><PageHeader title={view?.title ?? '新对话'} subtitle={subtitle} bordered /></div> : null}
          <div className={s.messages} ref={messagesRef} data-testid="chat-messages">
            <div className={`${s.messageColumn} ${flow.column}`}>
            {loadError ? (
              <EmptyState title="无法打开会话" desc={loadError} />
            ) : loading && !view ? (
              <EmptyState title="正在读取会话…" />
            ) : isEmptyConversation ? (
              <div className={s.welcome}>
                <h1 className={s.welcomeTitle}>有什么 Skill 需要帮忙？</h1>
                <p className={s.welcomeHint}>创建、优化或评测 Skill，也可以直接描述你的需求。</p>
              </div>
            ) : (
              view?.messages.map((message) => <MessageItem key={message.messageId} message={message}
                onViewChanges={() => message.changeRunId && setChangeFor({ runId: message.changeRunId, files: message.fileChanges })} />)
            )}

            {view && view.files.length + (reportAvailable ? 1 : 0) > 0 ? (
              <div className={s.generated} data-testid="chat-generated">
                <div className={c.hint}>已生成文件</div>
                {view.files.map((file) => (
                  <button
                    key={file.relPath}
                    type="button"
                    className={s.fileCard}
                    onClick={() => void openFile(file.relPath)}
                    data-testid="chat-file-card"
                    data-rel-path={file.relPath}
                  >
                    <span className={s.fileCardIcon}>
                      <FileIcon />
                    </span>
                    <span className={s.fileCardName}>{file.relPath}</span>
                    <span className={c.hint}>{formatBytes(file.bytes)}</span>
                    <span className={s.fileCardAction}>打开</span>
                  </button>
                ))}
                {reportAvailable ? (
                  <button
                    type="button"
                    className={s.fileCard}
                    onClick={() => void openReport()}
                    data-testid="chat-report-card"
                  >
                    <span className={s.fileCardIcon}>
                      <FileIcon />
                    </span>
                    <span className={s.fileCardName}>{view?.report?.fileName}</span>
                    <span className={c.hint}>评测结果</span>
                    <span className={s.fileCardAction}>打开</span>
                  </button>
                ) : null}
              </div>
            ) : null}

            {view ? <StatusBar view={view} running={running} /> : null}
            </div>
          </div>

          <div className={s.composer}>
            {showQuickActions ? (
              <div className={s.quickRow}>
                {(
                  [
                    { key: 'create', label: '创建 Skill' },
                    { key: 'improve', label: '优化 Skill' },
                    { key: 'evaluate', label: '评测 Skill' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={c.chip}
                    disabled={running}
                    data-testid={`chat-quick-${item.key}`}
                    onClick={() => void insertQuickPrompt(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
                {view?.targetSkillName ? <span className={c.hint}>目标 Skill：{view.targetSkillName}</span> : null}
              </div>
            ) : null}

            {notice ? (
              <div className={`${s.notice} ${notice.kind === 'error' ? s.noticeError : ''}`} data-testid="chat-notice">
                <span>{notice.text}</span>
                {notice.action === 'settings' ? (
                  <button
                    type="button"
                    className={c.btn}
                    onClick={() => navigate('settings')}
                    data-testid="chat-notice-settings"
                  >
                    去设置
                  </button>
                ) : null}
                {notice.action === 'models' ? (
                  <button
                    type="button"
                    className={c.btn}
                    onClick={() => {
                      setAddModelValue('');
                      setAddModelOpen(true);
                    }}
                  >
                    添加模型
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className={s.inputShell} ref={inputShellRef}>
              {slash && slash.candidates.length > 0 ? (
                <SlashMenu
                  items={slash.candidates}
                  highlight={slash.highlight}
                  onPick={pickSlash}
                  onHover={(index) => setSlash((prev) => (prev ? { ...prev, highlight: index } : prev))}
                />
              ) : null}
              <textarea
                ref={textareaRef}
                className={s.textarea}
                rows={3}
                value={draft}
                placeholder="描述你要创建、优化或评测的 Skill…"
                aria-label="对话输入"
                data-testid="chat-input"
                disabled={sending}
                onChange={(event) => {
                  setDraft(event.target.value);
                  syncSlash(event.target.value, event.target.selectionStart ?? 0);
                }}
                onClick={(event) => syncSlash(draft, event.currentTarget.selectionStart ?? 0)}
                onKeyUp={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                    syncSlash(draft, event.currentTarget.selectionStart ?? 0);
                  }
                }}
                onKeyDown={(event) => {
                  // 候选层打开时方向键移动高亮、Enter/Tab 选中（DSH arbitrate 口径）
                  if (slash && slash.candidates.length > 0) {
                    const count = slash.candidates.length;
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setSlash({ ...slash, highlight: (slash.highlight + 1) % count });
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setSlash({ ...slash, highlight: (slash.highlight - 1 + count) % count });
                      return;
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setSlash(null);
                      return;
                    }
                    const commit =
                      event.key === 'Tab' ||
                      (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing);
                    if (commit) {
                      event.preventDefault();
                      pickSlash(slash.candidates[slash.highlight]);
                      return;
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (!event.repeat) void send(event.ctrlKey || event.metaKey ? 'steer' : 'queue');
                  }
                }}
              />

              <div className={s.composerFooter}>
                <span className={c.toolbarSpacer} />
                <div className={s.modelWrap}>
                  <button
                    type="button"
                    className={s.modelButton}
                    disabled={running}
                    onClick={() => {
                      setModelMenuView('root');
                      setModelMenuOpen((open) => !open);
                    }}
                    aria-haspopup="menu"
                    aria-expanded={modelMenuOpen}
                    data-testid="chat-model-button"
                  >
                    <span className={s.modelName}>{currentModel ?? '选择模型'}</span>
                    {currentThinking ? (
                      <span className={s.modelLevel} data-testid="chat-thinking-badge">
                        {THINKING_LABEL[currentThinking]}
                      </span>
                    ) : null}
                    <span className={s.modelCaret} data-open={modelMenuOpen} aria-hidden="true">
                      <ChevronDownIcon size={13} />
                    </span>
                  </button>
                  {modelMenuOpen ? (
                    <div className={s.modelMenu} role="menu" data-testid="chat-model-menu" data-view={modelMenuView}>
                      {modelMenuView === 'root' ? (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            className={s.modelRow}
                            onClick={() => setModelMenuView('model')}
                            data-testid="chat-model-row"
                          >
                            <span className={s.modelRowLabel}>模型</span>
                            <span className={s.modelRowValue}>{currentModel ?? '未选择'}</span>
                            <span className={s.modelRowCaret} aria-hidden="true">
                              ›
                            </span>
                          </button>
                          {thinkingLevels.length > 0 ? (
                            <button
                              type="button"
                              role="menuitem"
                              className={s.modelRow}
                              onClick={() => setModelMenuView('thinking')}
                              data-testid="chat-thinking-row"
                            >
                              <span className={s.modelRowLabel}>推理强度</span>
                              <span className={s.modelRowValue}>
                                {currentThinking ? THINKING_LABEL[currentThinking] : ''}
                              </span>
                              <span className={s.modelRowCaret} aria-hidden="true">
                                ›
                              </span>
                            </button>
                          ) : null}
                        </>
                      ) : modelMenuView === 'model' ? (
                        <>
                          <button
                            type="button"
                            className={s.modelBack}
                            onClick={() => setModelMenuView('root')}
                            data-testid="chat-model-back"
                          >
                            ‹ 模型
                          </button>
                          {modelOptions.length === 0 ? (
                            <>
                              <p className={s.modelEmpty}>{models?.guidance ?? '当前供应商还没有添加模型'}</p>
                              {/* 只在空态给入口：有模型时菜单只列可选模型 */}
                              <button
                                type="button"
                                role="menuitem"
                                className={s.modelItem}
                                onClick={() => {
                                  setModelMenuOpen(false);
                                  setModelMenuView('root');
                                  setAddModelValue('');
                                  setAddModelOpen(true);
                                }}
                                data-testid="chat-add-model"
                              >
                                添加模型…
                              </button>
                            </>
                          ) : (
                            modelOptions.map((modelId) => (
                              <button
                                key={modelId}
                                type="button"
                                role="menuitem"
                                className={`${s.modelItem} ${modelId === currentModel ? s.modelItemActive : ''}`}
                                onClick={() => void pickModel(modelId)}
                                data-testid="chat-model-option"
                                data-model-id={modelId}
                              >
                                <span>{modelId}</span>
                                {modelId === currentModel ? <span className={s.modelCheck}>✓</span> : null}
                              </button>
                            ))
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={s.modelBack}
                            onClick={() => setModelMenuView('root')}
                            data-testid="chat-thinking-back"
                          >
                            ‹ 推理强度
                          </button>
                          {thinkingLevels.map((level) => (
                            <button
                              key={level}
                              type="button"
                              role="menuitem"
                              className={`${s.modelItem} ${level === currentThinking ? s.modelItemActive : ''}`}
                              onClick={() => void pickThinking(level)}
                              data-testid="chat-thinking-option"
                              data-level={level}
                            >
                              <span>{THINKING_LABEL[level]}</span>
                              {level === currentThinking ? <span className={s.modelCheck}>✓</span> : null}
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>

                {running ? (
                  <button
                    type="button"
                    className={s.send}
                    onClick={() => void stop()}
                    aria-label="停止"
                    data-testid="chat-stop"
                  >
                    <StopIcon size={18} />
                  </button>
                ) : null}
                {!running || canSend ? (
                  <button
                    type="button"
                    className={s.send}
                    disabled={!canSend}
                    onClick={() => void send()}
                    aria-label="发送"
                    data-testid="chat-send"
                  >
                    <ArrowUpIcon size={16} />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {panelOpen && !panelFullscreen ? (
          <div
            className={`${s.panelResizer} ${panelResizing ? s.panelResizerActive : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整文件查看区宽度"
            aria-valuemin={PANEL_MIN_WIDTH}
            aria-valuenow={panelWidth ?? undefined}
            tabIndex={0}
            data-testid="chat-panel-resizer"
            data-resizing={panelResizing ? 'true' : 'false'}
            onPointerDown={beginPanelResize}
            onDoubleClick={resetPanelWidth}
            onKeyDown={onPanelResizerKeyDown}
          />
        ) : null}

        {panelOpen ? (
          <aside
            className={`${s.filePanel} ${panelFullscreen ? s.filePanelFullscreen : ''}`}
            style={panelWidth != null && !panelFullscreen ? { width: `${panelWidth}px` } : undefined}
            aria-label="文件查看区"
            data-testid="chat-file-panel"
          >
            <div className={dock.tabStrip}>
              <div className={dock.stripTabs} role="tablist" aria-label="打开的文件">
                {tabs.map((tab) => (
                  <div key={tab.key} className={`${dock.tab} ${tab.key === activeKey ? dock.tabActive : ''}`}
                    role="tab" aria-selected={tab.key === activeKey} data-testid="chat-file-tab" data-rel-path={tab.relPath}>
                    <button type="button" className={s.fileTabLabel} onClick={() => { setActiveKey(tab.key); setViewerMenuOpen(false); }}>
                      <span className={dock.tabTitle}><FileTypeIcon path={tab.relPath} size={16} />{tab.name}</span>
                    </button>
                    <button type="button" className={dock.tabClose} onClick={() => removeTab(tab.key)}
                      aria-label={`关闭 ${tab.name}`} data-testid="chat-file-tab-close"><CloseIcon size={13} /></button>
                  </div>
                ))}
              </div>
              <span className={dock.stripFill} />
              <div className={dock.stripChrome}>
                <button type="button" className={dock.iconButton} onClick={() => setPanelSplit((value) => !value)}
                  aria-label={panelSplit ? '关闭分屏' : '分屏查看'} aria-pressed={panelSplit} data-testid="chat-file-split"><PaneGlyph kind="split" /></button>
                <button type="button" className={dock.iconButton} onClick={() => setPanelFullscreen((value) => !value)}
                  aria-label={panelFullscreen ? '退出全屏' : '全屏查看'} aria-pressed={panelFullscreen} data-testid="chat-file-fullscreen"><PaneGlyph kind="fullscreen" /></button>
                <button type="button" className={dock.iconButton} onClick={() => { setPanelOpen(false); setPanelFullscreen(false); }}
                  aria-label="收起文件查看区" data-testid="chat-file-close-panel"><PaneGlyph kind="collapse" /></button>
              </div>
            </div>
            <div className={preview.preview}>
              <div className={preview.header}>
                <PathLabel path={activeTab?.absolutePath ?? activeTab?.relPath ?? ''} className={preview.path} />
                {canChangeViewer ? (
                  <div className={s.viewerPicker}>
                    <button type="button" className={`${preview.tool} ${preview.viewerTool}`} onClick={() => setViewerMenuOpen((value) => !value)}
                      aria-label="打开方式" aria-expanded={viewerMenuOpen} data-testid="chat-file-viewer-menu">
                      {activeViewer === 'rendered' ? '预览' : activeViewer === 'plain' ? '文本' : '代码'}
                      <PaneGlyph kind="chevron" />
                    </button>
                    {viewerMenuOpen ? <div className={s.viewerMenu} role="menu">
                      {VIEWER_OPTIONS.filter((option) => option.id !== 'rendered' || hasRenderedViewer).map((option) => (
                        <button key={option.id} type="button" role="menuitemradio" aria-checked={activeViewer === option.id}
                          onClick={() => { if (activeTab) setViewerMode((prev) => ({ ...prev, [activeTab.key]: option.id })); setViewerMenuOpen(false); }}>
                          {option.label}{activeViewer === option.id ? ' ✓' : ''}
                        </button>
                      ))}
                    </div> : null}
                  </div>
                ) : null}
                {canChangeViewer && activeViewer !== 'rendered' ? (
                  <button type="button" className={preview.tool} data-textpreview-tool="wrap" aria-label="自动换行" aria-pressed={activeWrap}
                    onClick={() => { if (activeTab) setWrapByTab((prev) => ({ ...prev, [activeTab.key]: !activeWrap })); }}
                    data-testid="chat-file-wrap"><PaneGlyph kind="wrap" /></button>
                ) : null}
                <button type="button" className={preview.tool} data-textpreview-tool="reload" aria-label="重新加载" onClick={refreshActiveTab}
                  data-testid="chat-file-refresh"><PaneGlyph kind="refresh" /></button>
                {activeTab?.absolutePath ? (
                  <button type="button" className={preview.tool} aria-label="在文件夹中显示" title="在文件夹中显示"
                    onClick={() => void showActiveFileInFolder()} data-testid="chat-file-show-folder"><PaneGlyph kind="folder" /></button>
                ) : null}
              </div>
              <div className={`${preview.body} ${s.fileBody} ${panelSplit ? s.fileBodySplit : ''}`}>
                {!activeTab ? (
                  <div className={s.fileEmpty}><EmptyState title="未打开文件" desc="点击会话中的文件卡，在此查看。" /></div>
                ) : activeTab.loading ? (
                  <div className={s.fileEmpty}><EmptyState title="正在读取文件…" /></div>
                ) : activeTab.error ? (
                  <div className={s.fileEmpty}><EmptyState title="无法打开文件" desc={activeTab.error} /></div>
                ) : activeTab.reason ? (
                  <div className={s.fileEmpty}><EmptyState title={activeTab.name} desc={REASON_TEXT[activeTab.reason] ?? activeTab.reason} /></div>
                ) : <><div className={s.filePreview} data-testid="chat-file-content"><DshDocumentViewer document={activeTab} mode={activeViewer} wrap={activeWrap} /></div>
                  {panelSplit ? <div className={`${s.filePreview} ${s.filePreviewSplit}`}><DshDocumentViewer document={activeTab} mode={activeViewer} wrap={activeWrap} /></div> : null}</>}
              </div>
            </div>
          </aside>
        ) : null}
      </div>

      {addModelOpen ? (
        <Modal
          title="添加模型"
          desc="保存到当前供应商，随后可在输入区选择。"
          onClose={() => setAddModelOpen(false)}
          testId="chat-add-model-modal"
          footer={
            <>
              <button type="button" className={c.btn} onClick={() => setAddModelOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className={`${c.btn} ${c.btnPrimary}`}
                disabled={addModelBusy || addModelValue.trim().length === 0}
                onClick={() => void addModel()}
                data-testid="chat-add-model-save"
              >
                保存并选用
              </button>
            </>
          }
        >
          <label className={s.formRow}>
            <span className={s.formLabel}>模型 ID</span>
            <input
              className={`${c.input} ${c.inputGrow}`}
              value={addModelValue}
              placeholder="例如 gpt-4o-mini"
              onChange={(event) => setAddModelValue(event.target.value)}
              data-testid="chat-add-model-input"
            />
          </label>
          {models?.providerName ? <p className={c.hint}>当前供应商：{models.providerName}</p> : null}
        </Modal>
      ) : null}

      {changeFor && activeId ? <ConversationDiffModal sessionId={activeId} runId={changeFor.runId} files={changeFor.files}
        onClose={() => setChangeFor(null)} /> : null}

    </section>
  );
}

// ── 消息 ──────────────────────────────────────────────────────────────────

function MessageItem({ message, onViewChanges }: { message: ConversationMessageView; onViewChanges: () => void }) {
  const isUser = message.role === 'user';
  const changeTotal = message.fileChanges.reduce((total, file) => ({
    added: total.added + (file.added ?? 0), removed: total.removed + (file.removed ?? 0),
    unknown: total.unknown || file.added == null || file.removed == null,
  }), { added: 0, removed: 0, unknown: false });
  const [processOpen, setProcessOpen] = useState(message.status === 'streaming');
  const [filesOpen, setFilesOpen] = useState(false);
  useEffect(() => {
    if (message.status === 'streaming') setProcessOpen(true);
    else setProcessOpen(false);
  }, [message.status]);
  return (
    <article className={`${s.message} ${isUser ? `${s.messageUser} ${userMessage.userRow}` : assistant.root}`}
      data-testid="chat-message" data-role={message.role}>
      <div className={`${s.messageBody} ${isUser ? userMessage.userStack : assistant.body}`}>
        {message.text.trim().length > 0 ? (
          isUser ? <p className={s.messageText}>{message.text}</p>
            : <MarkdownText text={message.text} streaming={message.status === 'streaming'} labels={markdownLabels} />
        ) : message.status === 'streaming' ? (
          <p className={s.messagePending}>正在生成…</p>
        ) : null}
        {message.toolCalls.length > 0 ? (
          <div className={group.root} data-step-process>
            <button type="button" className={group.title} aria-expanded={processOpen} onClick={() => setProcessOpen((value) => !value)}>
              <span className={group.leading} aria-hidden="true"><span className={group.activityIcon}><FileIcon size={14} /></span>
                <span className={group.chevron}><ChevronDownIcon size={14} /></span></span>
              <span className={group.label}>{message.status === 'streaming' ? '正在执行' : `已执行 ${message.toolCalls.length} 项操作`}</span>
            </button>
            {processOpen ? <div className={group.body} data-step-process-body><ul className={`${s.toolList} ${group.content}`}>
            {message.toolCalls.map((call) => (
              <li key={call.id} className={`${s.toolItem} ${call.isError ? s.toolItemError : ''}`}>
                <span className={s.toolName}>{call.name}</span>
                <span className={s.toolSummary}>{call.summary}</span>
              </li>
            ))}
            </ul></div> : null}
          </div>
        ) : null}
        {message.fileChanges.length > 0 ? <div className={s.changeCard} data-testid="chat-file-changes">
          <div className={s.changeHeading}>
            <span>已编辑 {message.fileChanges.length} 个文件 <span className={s.changeCounts}><b>+{changeTotal.unknown ? '?' : changeTotal.added}</b> <i>−{changeTotal.unknown ? '?' : changeTotal.removed}</i></span></span>
            <button type="button" className={s.changeButton} onClick={onViewChanges}>查看变更</button>
          </div>
          <div className={s.changeFiles}>{(filesOpen ? message.fileChanges : message.fileChanges.slice(0, 3)).map((file) => <div key={file.relPath} className={s.changeFile}>
            <span title={file.relPath}>{file.relPath}</span>
            <span className={s.changeCounts}><b>+{file.added ?? '?'}</b> <i>−{file.removed ?? '?'}</i></span>
          </div>)}</div>
          {message.fileChanges.length > 3 ? <button type="button" className={s.changeMore}
            aria-expanded={filesOpen} onClick={() => setFilesOpen((open) => !open)}>
            {filesOpen ? '收起文件' : `再显示 ${message.fileChanges.length - 3} 个文件`}
          </button> : null}
        </div> : null}
        {message.errorCode ? <p className={s.messageError}>错误：{message.errorCode}</p> : null}
      </div>
    </article>
  );
}

function StatusBar({ view, running }: { view: ConversationView; running: boolean }) {
  const charsNow = view.messages.reduce(
    (sum, message) => sum + (message.role === 'assistant' ? chars(message.text) : 0),
    0,
  );
  const last = view.lastRun;
  if (running) {
    return (
      <div className={s.statusBar} data-testid="chat-status" data-status="running">
        <span className={s.statusDot} />
        <span>
          {view.status === 'cancelling' ? '正在中断…' : 'Agent 正在运行…'}
          {charsNow > 0 ? ` · 已接收 ${charsNow} 字` : ''}
        </span>
      </div>
    );
  }
  if (!last) return null;
  const failed = last.status === 'failed';
  const cancelled = last.status === 'cancelled';
  return (
    <div
      className={`${s.statusBar} ${failed ? s.statusBarError : ''}`}
      data-testid="chat-status"
      data-status={last.status}
    >
      <span className={s.statusText}>
        {failed ? '运行失败' : cancelled ? '已中断（已产生的消息与文件保留）' : STATUS_TEXT[last.status] ?? last.status}
        {last.durationMs != null ? ` · 用时 ${formatDuration(last.durationMs)}` : ''}
        {last.totalTokens != null ? ` · ${last.totalTokens} tokens` : ''}
        {last.modelId ? ` · ${last.modelId}` : ''}
      </span>
      {failed && view.error ? <span className={s.statusErrorDetail}>{view.error.detail}</span> : null}
    </div>
  );
}
