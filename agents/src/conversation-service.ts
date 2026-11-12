/**
 * T06：通用对话服务（prd.md §5.9、§6.1；tec.md §5.9、§6.2、§7.1）。
 *
 * 职责：
 *  - 会话生命周期：createSession / appendUserMessage / startRun / cancelRun / listSessions / getSession / resume；
 *  - 运行编排：Pi 会话 + 文件及命令工具 + 事件流（status/message/tool/usage/file/error/done）；
 *  - 持久化：消息/状态/文件引用落 DATA_DIR/sessions（重启可恢复），Pi 会话文件承载模型上下文；
 *  - 错误语义：NO_MODEL_CONFIGURED / PROVIDER_AUTH_FAILED / PROVIDER_TIMEOUT /
 *    TOOL_OUT_OF_SCOPE / TASK_CANCELLED / PI_*，一律结构化 code + detail。
 *
 * 业务编排（创建/改进/评测的提示词与报告落盘）在 T07，本服务持久化会话与文件变更。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CredentialBackend } from './win-credential';
import { AgentRunError, asAgentError, mapProviderErrorMessage } from './errors';
import { captureFile, compareCapturedFile, type CapturedFile } from './file-change';
import { modelProfile, normalizeThinkingLevel, type ModelProfile, type ThinkingLevel } from './model-meta';
import { assistantText, countPiMessages, normalizeUsage, PiBridge, type PiSessionHandle } from './pi-bridge';
import { ProviderConfigService } from './providers';
import { redactText, scrubFileSecrets, withRedaction, type RedactableLogger } from './redact';
import { ConversationStore } from './session-store';
import { ToolScopeGuard, type ScopeViolation } from './tool-scope';
import { listBuiltinSkills, type BuiltinSkillRef } from './workflows/quick-prompts';
import type {
  AgentEvent,
  AgentEventListener,
  AgentSessionDetail,
  AgentSessionRecord,
  AgentSessionSummary,
  AgentUsage,
  ProviderConfigView,
  RunResult,
  RunStatus,
  SessionFileRef,
  SessionFileChangeSnapshot,
  SessionMessage,
} from './types';

export interface ConversationServiceOptions {
  /** 本机数据目录（会话/供应商配置都在此，不进 Git） */
  dataDir: string;
  /** 注入供应商配置服务（测试用测试前缀）；缺省按 dataDir 新建 */
  providers?: ProviderConfigService;
  credentialBackend?: CredentialBackend;
  credentialPrefix?: string;
  logger?: RedactableLogger;
  /**
   * 产品自带的内置 skill（skill-creator、skill-creator-sop、skill-improve、skill-doctor）。
   * 它们作为「Agent 可发现的 skill」暴露：清单写进系统提示，按需由 Agent 读取。
   */
  builtinSkills?: readonly BuiltinSkillRef[];
  /**
   * 内置 skill 根目录（含用户随时投放的新 Skill）。缺省由 listBuiltinSkills 自动定位
   * （源码态命中 agents/skills 源目录；打包态命中包内构建副本）。生产主进程显式传
   * `<SOFT_DIR>/agents/skills`，与 CLI 上报的投放目录保持同一根（打包后 asar 内不可投放）。
   */
  builtinSkillsRoot?: string;
}

export interface StartRunOptions {
  /** 用户提示词（必填；先落盘再运行） */
  prompt: string;
  /** 覆盖当前模型（必须已添加到生效供应商） */
  modelId?: string;
  /** 覆盖会话附加系统提示（T07 注入技能流程约束） */
  systemPrompt?: string;
}

interface ActiveRun {
  runId: string;
  record: AgentSessionRecord;
  sessionReady: Promise<PiSessionHandle['session'] | null>;
  cancelRequested: boolean;
  abort: () => Promise<void>;
  settled: Promise<void>;
  resolveSettled: () => void;
}

/** 单次运行的内部状态（用对象承载，避免闭包内赋值被 TS 窄化）。 */
interface RunState {
  violation: ScopeViolation | null;
  message: SessionMessage | null;
  stopReason: string | null;
  errorMessage: string;
  usage: AgentUsage | null;
}

/** 默认系统提示：会话目录是工作目录，文件和命令工具可访问其他路径。 */
export function buildSystemPrompt(
  authorizedDir: string,
  extra?: string | null,
  builtinSkills: readonly BuiltinSkillRef[] = [],
): string {
  const lines = [
    '你是 Skills 工作台的技能助手，帮助用户创建、优化和评测 Agent Skill。',
    `本次会话的工作目录是：${authorizedDir}`,
    '规则：',
    '1. 文件工具和命令工具可访问工作目录以外的路径；相对路径以工作目录为基准。',
    '2. 需要生成或修改文件时可使用 write / edit，也可按需使用 bash / powershell。',
    '3. 回答使用简体中文，先说明意图再动手，结束前简述改动了哪些文件。',
    '4. 不要在回答、文件名或文件内容中写入 API Key、令牌或其他凭据。',
  ];
  if (builtinSkills.length > 0) {
    lines.push(
      '',
      '可用技能（产品自带，按需用 read 打开对应 SKILL.md 获取完整流程）：',
      ...builtinSkills.map((skill) => `- ${skill.name}：${skill.description || '（无描述）'} → ${skill.file}`),
      '当用户的要求与某个技能匹配时，先读取它的 SKILL.md 再按其流程执行。创建 Skill 默认使用 skill-creator；只有用户显式指定 skill-creator-sop 时才使用后者。优化使用 skill-improve，评测使用 skill-doctor。',
    );
  }
  if (extra && extra.trim()) lines.push('', extra.trim());
  return lines.join('\n');
}

export class ConversationService {
  readonly store: ConversationStore;
  readonly providers: ProviderConfigService;
  private readonly bridge: PiBridge;
  private readonly logger: RedactableLogger | null;
  private readonly listeners = new Map<string, Set<AgentEventListener>>();
  /** T15：全局订阅（主进程 → 渲染层事件桥只需一次转发）。 */
  private readonly allListeners = new Set<AgentEventListener>();
  private readonly active = new Map<string, ActiveRun>();
  /** 内置 skill 清单进入系统提示。 */
  private builtinSkills: readonly BuiltinSkillRef[];
  private readonly builtinSkillsRoot: string | undefined;

  constructor(options: ConversationServiceOptions) {
    if (!options.dataDir || !path.isAbsolute(options.dataDir)) {
      throw new AgentRunError('INVALID_SCOPE', 'ConversationService 需要绝对 dataDir');
    }
    this.store = new ConversationStore(options.dataDir);
    this.providers =
      options.providers ??
      new ProviderConfigService({
        dataDir: options.dataDir,
        credentialBackend: options.credentialBackend,
        credentialPrefix: options.credentialPrefix,
      });
    this.bridge = new PiBridge({
      agentDir: path.join(path.resolve(options.dataDir), 'pi-agent'),
      sessionsDir: this.store.piDir,
      providers: this.providers,
    });
    this.logger = options.logger ? withRedaction(options.logger) : null;
    this.builtinSkills = options.builtinSkills ?? [];
    this.builtinSkillsRoot = options.builtinSkillsRoot;
  }

  /** 返回系统提示中的内部 Skill 清单，供聊天输入区使用。 */
  listAvailableSkills(): { name: string; description: string }[] {
    this.refreshBuiltinSkills();
    return this.builtinSkills.map(({ name, description }) => ({ name, description }));
  }

  /**
   * 重新扫描内部 Skill 目录：`agents/skills` 是可直接投放新 Skill 的目录，
   * 加了目录不用重启应用就能出现在 `/` 候选与系统提示里。
   * 清单未变时不更新提示内容。
   */
  private refreshBuiltinSkills(): void {
    const scanned = listBuiltinSkills(this.builtinSkillsRoot);
    const unchanged =
      scanned.length === this.builtinSkills.length &&
      scanned.every(
        (skill, index) =>
          skill.name === this.builtinSkills[index]?.name && skill.file === this.builtinSkills[index]?.file,
      );
    if (unchanged) return;
    this.builtinSkills = scanned;
    this.log('builtin-skills-refreshed', { count: scanned.length });
  }

  /**
   * 在发送前绑定本次内部 Skill 流程；运行中的会话不能切换工具策略。
   * `workflow = null` 表示「只注入某一内部 Skill 的流程文本」：清空流程归属，
   * 否则库根会话会带着上一次选中的创建/改进/评测语义继续运行。
   */
  setWorkflow(
    sessionId: string,
    workflow: 'create' | 'improve' | 'evaluate' | null,
    systemPrompt: string,
  ): void {
    if (this.active.has(sessionId)) throw new AgentRunError('SESSION_BUSY', '运行中的会话不能切换 Skill');
    const record = this.loadRecord(sessionId);
    record.workflow = workflow;
    record.systemPrompt = systemPrompt;
    record.toolPolicy = 'read-write';
    this.store.save(record);
  }

  // ── 订阅 ────────────────────────────────────────────────────────────────

  /** 订阅某会话的事件流；返回取消订阅函数。 */
  subscribe(sessionId: string, listener: AgentEventListener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<AgentEventListener>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  /**
   * 订阅所有会话的事件（T15 主进程事件桥）。
   * 事件内容与订阅者无关，转发层只做白名单过滤，不做业务判断。
   */
  subscribeAll(listener: AgentEventListener): () => void {
    this.allListeners.add(listener);
    return () => {
      this.allListeners.delete(listener);
    };
  }

  // ── 会话参数（T15：模型选择 / 预填草稿） ─────────────────────────────────

  /** 切换本次会话使用的模型（必须已添加到当前生效供应商）。 */
  setModel(sessionId: string, modelId: string): void {
    const selection = this.providers.getSelection(modelId);
    const record = this.loadRecord(sessionId);
    if (this.active.has(sessionId)) {
      throw new AgentRunError('SESSION_BUSY', '运行中的会话不能切换模型，请等待完成或先中断');
    }
    record.modelId = selection.modelId;
    record.providerId = selection.providerId;
    this.store.save(record);
    this.log('session-model-changed', { sessionId, modelId: selection.modelId });
  }

  /** 切换本会话的推理强度（只接受当前模型支持的档位，不影响供应商的全局选择）。 */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const record = this.loadRecord(sessionId);
    if (this.active.has(sessionId)) {
      throw new AgentRunError('SESSION_BUSY', '运行中的会话不能切换推理强度，请等待完成或先中断');
    }
    const selection = this.providers.getSelection(record.modelId ?? undefined);
    const profile = modelProfile(selection.preset, selection.modelId);
    if (!profile.thinkingLevels.includes(level)) {
      const available = profile.thinkingLevels.length > 0 ? profile.thinkingLevels.join(' / ') : '无';
      throw new AgentRunError(
        'INVALID_MODEL',
        `模型 ${selection.modelId} 不支持推理强度 ${level}（可选：${available}）`,
      );
    }
    record.thinkingLevel = level;
    this.store.save(record);
    // 档位跟模型绑定：会话模型就是当前生效模型时，同步为下次新会话的初值
    if (record.modelId && record.modelId === this.providers.readConfig().activeModelId) {
      this.providers.setActiveThinkingLevel(level);
    }
    this.log('session-thinking-level-changed', { sessionId, thinkingLevel: level });
  }

  /** 保存/清空预填草稿（快捷提示词与行菜单带入；发送后清空）。 */
  setDraftPrompt(sessionId: string, text: string | null): void {
    const record = this.loadRecord(sessionId);
    const value = typeof text === 'string' ? redactText(text) : null;
    record.draftPrompt = value && value.trim().length > 0 ? value : null;
    this.store.save(record);
  }

  /**
   * 刷新信号（T15）：工作流的后处理（rescan、写入评测报告、标记来源）在运行结束后完成，
   * 需要让界面再拉一次会话详情，否则「完成」瞬间可能看不到新报告/新文件。
   */
  touch(sessionId: string): void {
    const record = this.loadRecord(sessionId);
    this.emit({ type: 'status', sessionId, runId: null, status: record.status, at: new Date().toISOString() });
  }

  // ── 供应商/模型 ─────────────────────────────────────────────────────────

  /** 设置页数据契约（供应商、模型、单一生效选择、未配置引导）。 */
  getProviderConfig(): ProviderConfigView {
    return this.providers.view();
  }

  // ── 会话生命周期 ────────────────────────────────────────────────────────

  /**
   * 新建会话。授权目录必须是已存在的目录（技能目录或临时沙箱），
   * 不接受不存在的路径，避免运行期把文件写到意料之外的位置。
   */
  createSession(input: {
    authorizedDir: string;
    title?: string;
    systemPrompt?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    /** T07：工作流归属（create/improve/evaluate） */
    workflow?: 'create' | 'improve' | 'evaluate' | null;
  }): AgentSessionRecord {
    const dir = path.resolve(input.authorizedDir);
    if (!isDirectory(dir)) {
      throw new AgentRunError('INVALID_SCOPE', `授权目录不存在或不是目录：${dir}`);
    }
    let providerId = input.providerId ?? null;
    let modelId = input.modelId ?? null;
    let thinkingLevel: ThinkingLevel | null = null;
    try {
      const selection = this.providers.getSelection(input.modelId ?? undefined);
      providerId = providerId ?? selection.providerId;
      modelId = selection.modelId;
      // 档位跟模型绑定：新会话沿用上次为该模型选的档，按该模型能力归一
      const normalized = normalizeThinkingLevel(
        modelProfile(selection.preset, selection.modelId),
        this.providers.getActiveThinkingLevel(),
      );
      thinkingLevel = normalized === 'off' ? null : normalized;
    } catch (err) {
      // 未配置模型时仍允许建会话与保存提示词（PRD：未配置 → 引导而不是阻塞）；
      // 但显式指定的模型非法属于调用错误，必须报出
      if (input.modelId) throw err;
    }
    const record = this.store.create({
      authorizedDir: dir,
      title: input.title,
      systemPrompt: input.systemPrompt ?? null,
      providerId,
      modelId,
      thinkingLevel,
      workflow: input.workflow ?? null,
    });
    this.log('session-created', { sessionId: record.sessionId, authorizedDir: dir });
    return record;
  }

  /** 追加用户消息（发送前先落盘：进程崩溃也不丢用户输入）。 */
  appendUserMessage(sessionId: string, text: string): SessionMessage {
    const content = String(text ?? '').trim();
    if (!content) throw new AgentRunError('INVALID_PROMPT', '提示词不能为空');
    const record = this.loadRecord(sessionId);
    const message = ConversationStore.newMessage('user', redactText(content));
    record.messages.push(message);
    if (record.title === '新对话') record.title = truncateTitle(redactText(content));
    this.store.save(record);
    this.emit({
      type: 'message',
      sessionId,
      runId: null,
      messageId: message.messageId,
      role: 'user',
      text: message.text,
      final: true,
      at: message.at,
    });
    return message;
  }

  listSessions(): AgentSessionSummary[] {
    return this.store.list({ activeSessionIds: new Set(this.active.keys()) });
  }

  /**
   * 归档（删除）会话：记录、事件日志与 Pi 会话文件一并删除，不可恢复。
   * 运行中的会话先拒绝，避免删掉正在写入的记录。
   */
  deleteSession(sessionId: string): void {
    const record = this.loadRecord(sessionId);
    if (this.active.has(sessionId)) {
      throw new AgentRunError('SESSION_BUSY', '运行中的会话不能归档，请先中断');
    }
    this.store.remove(record.sessionId);
    this.log('session-deleted', { sessionId: record.sessionId });
  }

  getSession(sessionId: string): AgentSessionDetail {
    const record = this.loadRecord(sessionId);
    return this.detailOf(record);
  }

  /** 恢复会话：校验授权目录与 Pi 会话文件，返回可继续的详情。 */
  resume(sessionId: string): AgentSessionDetail {
    const record = this.loadRecord(sessionId);
    const dir = record.authorizedDir;
    if (!isDirectory(dir)) {
      throw new AgentRunError('INVALID_SCOPE', `授权目录已不存在，无法继续会话：${dir}`);
    }
    record.resumedAt = new Date().toISOString();
    this.store.save(record);
    if (record.piSessionFile) {
      try {
        scrubFileSecrets(this.store.piPath(record.piSessionFile));
      } catch {
        /* 清洗失败不阻塞恢复 */
      }
    }
    const detail = this.detailOf(record);
    this.log('session-resumed', {
      sessionId,
      piMessageCount: detail.piMessageCount,
      resumable: detail.resumable,
    });
    return detail;
  }

  /** 事件回放（已脱敏；用于重启后查看运行过程）。 */
  getSessionEvents(sessionId: string): AgentEvent[] {
    return this.store.readEvents(sessionId);
  }

  getFileChange(sessionId: string, runId: string, relPath: string): SessionFileChangeSnapshot {
    const record = this.loadRecord(sessionId);
    const run = record.runs.find((item) => item.runId === runId);
    if (!run?.fileChanges?.some((item) => item.relPath === relPath)) {
      throw new AgentRunError('SESSION_NOT_FOUND', '文件差异记录不存在');
    }
    return this.store.readChange(sessionId, runId, relPath);
  }

  // ── 运行 ────────────────────────────────────────────────────────────────

  /**
   * 开始一次运行。返回的 Promise 在运行结束后 resolve（状态见 result.status），
   * 过程中的进度通过 subscribe()/事件文件推送。取消用 cancelRun()。
   */
  async startRun(sessionId: string, options: StartRunOptions): Promise<RunResult> {
    const prompt = String(options.prompt ?? '').trim();
    if (!prompt) throw new AgentRunError('INVALID_PROMPT', '提示词不能为空');
    if (this.active.has(sessionId)) {
      throw new AgentRunError('SESSION_BUSY', '该会话已有运行中的任务，请等待完成或先中断');
    }

    const record = this.loadRecord(sessionId);
    const selection = this.providers.getSelection(options.modelId);
    if (!isDirectory(record.authorizedDir)) {
      throw new AgentRunError('INVALID_SCOPE', `授权目录已不存在：${record.authorizedDir}`);
    }

    // 登记密钥用于脱敏（即使模型回显也不会落盘）
    if (selection.requiresApiKey) {
      const key = this.providers.readApiKey(selection.providerId);
      if (!key) {
        throw new AgentRunError(
          'NO_MODEL_CONFIGURED',
          `供应商「${selection.providerName}」尚未保存 API Key，请在设置中填写后再开始对话。`,
        );
      }
    }
    if (options.systemPrompt !== undefined) record.systemPrompt = options.systemPrompt;
    record.providerId = selection.providerId;
    record.modelId = selection.modelId;
    // 推理强度按当前模型的能力归一（换模型后旧档位可能不再可用）
    const profile = modelProfile(selection.preset, selection.modelId);
    const thinkingLevel = normalizeThinkingLevel(profile, record.thinkingLevel);
    record.thinkingLevel = thinkingLevel === 'off' ? null : thinkingLevel;

    const startedAt = new Date();
    const run = ConversationStore.newRun({
      status: 'queued',
      startedAt: startedAt.toISOString(),
      endedAt: null,
      providerId: selection.providerId,
      modelId: selection.modelId,
      error: null,
      usage: null,
      durationMs: null,
    });
    record.runs.push(run);

    // 用户消息先落盘（未发送提示词不运行；这里 prompt 已校验非空）
    const userMessage = ConversationStore.newMessage('user', redactText(prompt));
    record.messages.push(userMessage);
    if (record.title === '新对话') record.title = truncateTitle(redactText(prompt));
    // 发送即消费预填草稿（草稿不进入历史，避免重启后又出现在输入框）
    record.draftPrompt = null;

    record.status = 'queued';
    record.error = null;
    this.store.save(record);
    this.emitStatus(record, run.runId, 'queued');
    this.emit({
      type: 'message',
      sessionId,
      runId: run.runId,
      messageId: userMessage.messageId,
      role: 'user',
      text: userMessage.text,
      final: true,
      at: userMessage.at,
    });

    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let handle: PiSessionHandle | null = null;
    let abortFn: () => Promise<void> = async () => undefined;
    let resolveSessionReady: (session: PiSessionHandle['session'] | null) => void = () => undefined;
    const sessionReady = new Promise<PiSessionHandle['session'] | null>((resolve) => { resolveSessionReady = resolve; });
    this.active.set(sessionId, {
      runId: run.runId,
      record,
      sessionReady,
      cancelRequested: false,
      abort: () => abortFn(),
      settled,
      resolveSettled,
    });

    const state: RunState = {
      violation: null,
      message: null,
      stopReason: null,
      errorMessage: '',
      usage: null,
    };
    const toolArgs = new Map<string, Record<string, unknown>>();
    const pendingWrites = new Map<string, { relPath: string; absolute: string }>();
    const originalFiles = new Map<string, CapturedFile>();
    const newFiles: SessionFileRef[] = [];
    // 运行中节流落盘：进程被强杀时，用户消息与已生成的 assistant 文本仍能恢复（C-26）
    let lastPersistAt = 0;
    const persistThrottled = () => {
      const now = Date.now();
      if (now - lastPersistAt < 400) return;
      lastPersistAt = now;
      try {
        this.store.save(record);
      } catch {
        /* 落盘失败不中断运行，结束后还会再写一次 */
      }
    };

    try {
      record.status = 'running';
      run.status = 'running';
      this.store.save(record);
      this.emitStatus(record, run.runId, 'running');

      const scope = new ToolScopeGuard(record.authorizedDir);
      handle = await this.bridge.createSession({
        authorizedDir: record.authorizedDir,
        providerId: selection.providerId,
        modelId: selection.modelId,
        thinkingLevel,
        systemPrompt: buildSystemPrompt(record.authorizedDir, record.systemPrompt, this.builtinSkills),
        sessionFile: record.piSessionFile ? this.store.piPath(record.piSessionFile) : null,
        scope,
        onViolation: (v) => {
          state.violation = v;
        },
      });
      record.piSessionFile = this.store.toRelative(handle.sessionFile) ?? record.piSessionFile;
      this.store.save(record);

      const piSession = handle.session;
      abortFn = () => piSession.abort();
      resolveSessionReady(piSession);

      const unsubscribe = piSession.subscribe((event) => {
        switch (event.type) {
          case 'message_start': {
            if (event.message.role !== 'assistant') break;
            const message = ConversationStore.newMessage('assistant', '');
            message.runId = run.runId;
            message.status = 'streaming';
            state.message = message;
            record.messages.push(message);
            this.emit({
              type: 'message',
              sessionId,
              runId: run.runId,
              messageId: message.messageId,
              role: 'assistant',
              text: '',
              final: false,
              at: message.at,
            });
            break;
          }
          case 'message_update': {
            const update = event.assistantMessageEvent;
            const delta = update.type === 'text_delta' ? update.delta : '';
            const message = state.message;
            if (!delta || !message) break;
            message.text += redactText(delta);
            persistThrottled();
            this.emit({
              type: 'message',
              sessionId,
              runId: run.runId,
              messageId: message.messageId,
              role: 'assistant',
              delta: redactText(delta),
              final: false,
              at: new Date().toISOString(),
            });
            break;
          }
          case 'message_end': {
            if (event.message.role !== 'assistant') break;
            let message = state.message;
            if (!message) {
              message = ConversationStore.newMessage('assistant', '');
              message.runId = run.runId;
              state.message = message;
              record.messages.push(message);
            }
            const text = redactText(assistantText(event.message));
            const stopReason = (event.message as { stopReason?: string }).stopReason ?? null;
            const errorMessage = (event.message as { errorMessage?: string }).errorMessage ?? '';
            message.text = text || message.text;
            message.status =
              stopReason === 'error' ? 'failed' : stopReason === 'aborted' ? 'aborted' : 'complete';
            message.usage = normalizeUsage((event.message as { usage?: unknown }).usage);
            persistThrottled();
            if (message.usage) state.usage = message.usage;
            state.stopReason = stopReason;
            state.errorMessage = errorMessage;
            if (stopReason === 'error') {
              message.errorCode = mapProviderErrorMessage(errorMessage).code;
            }
            this.emit({
              type: 'message',
              sessionId,
              runId: run.runId,
              messageId: message.messageId,
              role: 'assistant',
              text: redactText(message.text),
              final: true,
              at: new Date().toISOString(),
            });
            if (message.usage) {
              this.emit({
                type: 'usage',
                sessionId,
                runId: run.runId,
                usage: message.usage,
                durationMs: Date.now() - startedAt.getTime(),
                at: new Date().toISOString(),
              });
            }
            break;
          }
          case 'tool_execution_start': {
            const args = (event.args ?? {}) as Record<string, unknown>;
            toolArgs.set(event.toolCallId, args);
            if ((event.toolName === 'write' || event.toolName === 'edit') &&
              typeof args.path === 'string' && args.path.trim()) {
              const check = scope.check(event.toolName, args);
              if (check.ok) {
                const relPath = scope.relativize(check.resolvedPath);
                pendingWrites.set(event.toolCallId, { relPath, absolute: check.resolvedPath });
                if (!originalFiles.has(relPath)) originalFiles.set(relPath, captureFile(check.resolvedPath));
              }
            }
            const summary = summarizeToolCall(event.toolName, args, scope);
            let message = state.message;
            if (!message) {
              message = ConversationStore.newMessage('assistant', '');
              message.runId = run.runId;
              state.message = message;
              record.messages.push(message);
            }
            message.toolCalls.push({
              toolCallId: event.toolCallId,
              name: event.toolName,
              summary,
              isError: false,
              at: new Date().toISOString(),
            });
            this.emit({
              type: 'tool',
              sessionId,
              runId: run.runId,
              toolCallId: event.toolCallId,
              phase: 'start',
              name: event.toolName,
              summary,
              at: new Date().toISOString(),
            });
            break;
          }
          case 'tool_execution_end': {
            const args = toolArgs.get(event.toolCallId) ?? {};
            const pending = pendingWrites.get(event.toolCallId);
            pendingWrites.delete(event.toolCallId);
            if (pending) {
              const before = originalFiles.get(pending.relPath);
              if (before) {
                try {
                  const result = compareCapturedFile(pending.relPath, before, captureFile(pending.absolute));
                  if (result) this.store.writeChange(sessionId, run.runId, pending.relPath, result.snapshot);
                  else this.store.removeChange(sessionId, run.runId, pending.relPath);
                  run.fileChanges ??= [];
                  run.fileChanges = run.fileChanges.filter((item) => item.relPath !== pending.relPath);
                  if (result) run.fileChanges.push(result.change);
                  this.store.save(record);
                } catch (error) {
                  this.log('file-change-snapshot-failed', { sessionId, runId: run.runId,
                    reason: error instanceof Error ? error.message : String(error) });
                }
              }
            }
            const summary = summarizeToolResult(event.toolName, args, event.isError === true, scope);
            const call = state.message?.toolCalls.find((c) => c.toolCallId === event.toolCallId);
            if (call) {
              call.isError = event.isError === true;
              call.summary = summary;
              persistThrottled();
            }
            this.emit({
              type: 'tool',
              sessionId,
              runId: run.runId,
              toolCallId: event.toolCallId,
              phase: 'end',
              name: event.toolName,
              summary,
              isError: event.isError === true,
              at: new Date().toISOString(),
            });
            if (!event.isError && (event.toolName === 'write' || event.toolName === 'edit')) {
              const ref = recordFile(record, args, scope);
              if (ref) {
                newFiles.push(ref);
                this.emit({
                  type: 'file',
                  sessionId,
                  runId: run.runId,
                  relPath: ref.relPath,
                  bytes: ref.bytes,
                  at: ref.at,
                });
              }
            }
            break;
          }
          default:
            break;
        }
      });

      try {
        await piSession.prompt(prompt);
      } finally {
        unsubscribe();
      }

      const cancelRequested = this.active.get(sessionId)?.cancelRequested === true;
      if (state.violation) {
        this.finishRun(record, run.runId, 'failed', {
          code: 'TOOL_OUT_OF_SCOPE',
          detail: `工具调用未通过检查，本次运行已中止：${state.violation.reason}`,
        });
      } else if (cancelRequested || state.stopReason === 'aborted') {
        this.finishRun(record, run.runId, 'cancelled', {
          code: 'TASK_CANCELLED',
          detail: '已中断本次运行（已产生的消息与文件保留）',
        });
      } else if (state.stopReason === 'error') {
        const mapped = mapProviderErrorMessage(state.errorMessage || 'provider error');
        if (state.message) state.message.errorCode = mapped.code;
        this.finishRun(record, run.runId, 'failed', {
          code: mapped.code,
          detail: providerDetail(state.errorMessage, mapped.code),
        });
      } else if (!state.message) {
        this.finishRun(record, run.runId, 'failed', {
          code: 'PI_RUN_FAILED',
          detail: '模型没有返回任何消息',
        });
      } else {
        this.finishRun(record, run.runId, 'done', null);
      }

      return this.resultOf(record, run.runId, state, newFiles, startedAt);
    } catch (err) {
      const error = asAgentError(err, 'PI_RUN_FAILED');
      this.finishRun(record, run.runId, 'failed', { code: error.code, detail: error.detail });
      return this.resultOf(record, run.runId, state, newFiles, startedAt);
    } finally {
      try {
        handle?.dispose();
      } catch {
        /* dispose 失败不影响已保存状态 */
      }
      // Pi 原生会话文件由内核直接追加写；运行结束后统一清洗一次，确保任何被回显的密钥不落盘
      if (record.piSessionFile) {
        try {
          scrubFileSecrets(this.store.piPath(record.piSessionFile));
        } catch {
          /* 清洗失败不改变运行结果；下一次 resume/运行会再次尝试 */
        }
      }
      resolveSessionReady(null);
      this.active.get(sessionId)?.resolveSettled();
      this.active.delete(sessionId);
    }
  }

  /** DSH busy composer: Enter queues a follow-up, Ctrl/Cmd+Enter steers the active turn. */
  async submitWhileRunning(sessionId: string, text: string, mode: 'queue' | 'steer'): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active || active.cancelRequested) throw new AgentRunError('NO_ACTIVE_RUN', '该会话没有可接收消息的运行任务');
    const prompt = text.trim();
    if (!prompt) throw new AgentRunError('INVALID_PROMPT', '提示词不能为空');
    const session = await active.sessionReady;
    if (!session || !session.isStreaming || active.cancelRequested) {
      throw new AgentRunError('SESSION_BUSY', '当前运行即将结束，请稍后重新发送');
    }
    if (mode === 'steer') await session.steer(prompt);
    else await session.followUp(prompt);
    const userMessage = ConversationStore.newMessage('user', redactText(prompt));
    active.record.messages.push(userMessage);
    this.store.save(active.record);
    this.emit({
      type: 'message', sessionId, runId: active.runId, messageId: userMessage.messageId,
      role: 'user', text: userMessage.text, final: true, at: userMessage.at,
    });
  }

  /**
   * 中断当前运行：状态先置 cancelling，再调用 Pi 的 abort()；
   * 已产生的 assistant 文本与文件引用全部保留（prd.md §6.1）。
   */
  async cancelRun(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (!active) throw new AgentRunError('NO_ACTIVE_RUN', '该会话没有正在运行的任务');
    active.cancelRequested = true;
    const record = this.loadRecord(sessionId);
    const run = record.runs.find((r) => r.runId === active.runId);
    record.status = 'cancelling';
    if (run) run.status = 'cancelling';
    this.store.save(record);
    this.emitStatus(record, active.runId, 'cancelling');
    await active.abort();
    await active.settled;
  }

  /** 进程退出/测试清理：中断所有活动运行，避免悬挂的网络请求。 */
  async dispose(): Promise<void> {
    const ids = [...this.active.keys()];
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.cancelRun(id);
        } catch {
          /* 已结束 */
        }
      }),
    );
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private resultOf(
    record: AgentSessionRecord,
    runId: string,
    state: RunState,
    files: SessionFileRef[],
    startedAt: Date,
  ): RunResult {
    return {
      sessionId: record.sessionId,
      runId,
      status: record.status,
      messageId: state.message?.messageId ?? null,
      text: state.message?.text ?? '',
      usage: state.usage,
      error: record.error,
      durationMs: Date.now() - startedAt.getTime(),
      files,
    };
  }

  private loadRecord(sessionId: string): AgentSessionRecord {
    return this.store.load(sessionId, { normalizeInterrupted: !this.active.has(sessionId) });
  }

  /** 最近一条 assistant 消息的用量（用于运行摘要）。 */
  private lastUsage(record: AgentSessionRecord): AgentUsage | null {
    for (let i = record.messages.length - 1; i >= 0; i--) {
      const usage = record.messages[i].usage;
      if (usage) return usage;
    }
    return null;
  }

  private detailOf(record: AgentSessionRecord): AgentSessionDetail {
    const view = this.providers.view();
    let modelConfigured = true;
    let modelGuidance: string | null = null;
    let profile: ModelProfile | null = null;
    try {
      const selection = this.providers.getSelection(record.modelId ?? undefined);
      profile = modelProfile(selection.preset, selection.modelId);
    } catch (err) {
      modelConfigured = false;
      modelGuidance = err instanceof AgentRunError ? err.detail : view.guidance;
    }
    const piFile = record.piSessionFile ? this.store.piPath(record.piSessionFile) : null;
    const piMessageCount = piFile ? countPiMessages(piFile) : 0;
    const effective = profile ? normalizeThinkingLevel(profile, record.thinkingLevel) : 'off';
    return {
      ...record,
      modelConfigured,
      modelGuidance,
      thinkingLevel: effective === 'off' ? null : effective,
      thinkingLevels: profile ? [...profile.thinkingLevels] : [],
      running: this.active.has(record.sessionId),
      piMessageCount,
      resumable: isDirectory(record.authorizedDir) && (!piFile || fs.existsSync(piFile)),
    };
  }

  private finishRun(
    record: AgentSessionRecord,
    runId: string,
    status: RunStatus,
    error: { code: AgentRunError['code']; detail: string } | null,
  ): void {
    const now = new Date().toISOString();
    const run = record.runs.find((r) => r.runId === runId);
    record.status = status;
    record.error = error;
    if (run) {
      run.status = status;
      run.endedAt = now;
      run.error = error;
      // T15：运行用量也落在 run 上（会话页「用时 / tokens」直接读这里）
      if (!run.usage) run.usage = this.lastUsage(record) ?? null;
      run.durationMs = Math.max(0, new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime());
    }
    this.store.save(record);
    // 终态也走 status 事件，保证事件流的状态机闭合（queued → running → done/failed/cancelled）
    this.emitStatus(record, runId, status);
    if (error) {
      this.emit({
        type: 'error',
        sessionId: record.sessionId,
        runId,
        code: error.code,
        detail: error.detail,
        retryable: error.code === 'PROVIDER_TIMEOUT' || error.code === 'PROVIDER_ERROR',
        at: now,
      });
    }
    this.emit({ type: 'done', sessionId: record.sessionId, runId, status, at: now });
    this.log('run-finished', { sessionId: record.sessionId, runId, status, code: error?.code ?? null });
  }

  private emitStatus(record: AgentSessionRecord, runId: string | null, status: RunStatus): void {
    this.emit({ type: 'status', sessionId: record.sessionId, runId, status, at: new Date().toISOString() });
  }

  private emit(event: AgentEvent): void {
    try {
      this.store.appendEvent(event.sessionId, event);
    } catch (err) {
      this.logger?.error('agent-event-append-failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    this.dispatch(this.allListeners, event);
    const set = this.listeners.get(event.sessionId);
    if (set) this.dispatch(set, event);
  }

  private dispatch(listeners: Iterable<AgentEventListener>, event: AgentEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger?.error('agent-listener-failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private log(event: string, data?: unknown): void {
    this.logger?.info(event, data);
  }
}

// ── 辅助 ──────────────────────────────────────────────────────────────────

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function truncateTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 30 ? `${flat.slice(0, 30)}…` : flat || '新对话';
}

/** 工具调用摘要（脱敏、截断；不写文件内容）。 */
function summarizeToolCall(toolName: string, args: Record<string, unknown>, scope: ToolScopeGuard): string {
  const rel = relativePathArg(args, scope);
  switch (toolName) {
    case 'read':
      return `读取 ${rel}`;
    case 'write': {
      const content = typeof args.content === 'string' ? args.content : '';
      return `写入 ${rel}（${[...content].length} 字符）`;
    }
    case 'edit': {
      const edits = Array.isArray(args.edits) ? args.edits.length : 0;
      return `编辑 ${rel}（${edits} 处）`;
    }
    case 'ls':
      return `列目录 ${rel}`;
    case 'grep': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      return `检索 ${truncateText(pattern, 40)} @ ${rel}`;
    }
    case 'find': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      return `查找 ${truncateText(pattern, 40)} @ ${rel}`;
    }
    case 'bash':
      return '执行 Bash 命令';
    case 'powershell':
      return '执行 PowerShell 命令';
    default:
      return rel;
  }
}

function summarizeToolResult(
  toolName: string,
  args: Record<string, unknown>,
  isError: boolean,
  scope: ToolScopeGuard,
): string {
  const base = summarizeToolCall(toolName, args, scope);
  return isError ? `${base} → 失败` : `${base} → 完成`;
}

function relativePathArg(args: Record<string, unknown>, scope: ToolScopeGuard): string {
  const raw = args.path;
  if (typeof raw !== 'string' || !raw.trim()) return '.';
  try {
    return scope.relativize(path.resolve(scope.authorizedDir, raw.trim()));
  } catch {
    return truncateText(raw, 80);
  }
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 记录 write/edit 生成的文件引用（读取真实字节数；文件不存在则忽略）。 */
function recordFile(
  record: AgentSessionRecord,
  args: Record<string, unknown>,
  scope: ToolScopeGuard,
): SessionFileRef | null {
  const raw = args.path;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const absolute = path.resolve(scope.authorizedDir, raw.trim());
  const relPath = scope.relativize(absolute);
  let bytes: number | null = null;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) return null;
    bytes = stat.size;
  } catch {
    return null;
  }
  const at = new Date().toISOString();
  const existing = record.files.find((f) => f.path === absolute);
  if (existing) {
    existing.relPath = relPath;
    existing.bytes = bytes;
    existing.at = at;
    return existing;
  }
  const ref: SessionFileRef = { relPath, path: absolute, bytes, at };
  record.files.push(ref);
  return ref;
}

/** provider 失败详情（先脱敏再截断，避免把 header/密钥写进会话）。 */
function providerDetail(raw: string, code: string): string {
  const cleaned = redactText(raw).replace(/\s+/g, ' ').trim();
  const hint =
    code === 'PROVIDER_AUTH_FAILED'
      ? '（请检查供应商 API Key 是否正确、是否有该模型权限）'
      : code === 'PROVIDER_TIMEOUT'
        ? '（模型服务响应超时，请检查网络或稍后重试）'
        : '';
  const base = cleaned ? truncateText(cleaned, 300) : '模型服务返回错误';
  return `${base}${hint}`;
}
