/**
 * T10 IPC 处理器装配（不含 electron 依赖，便于 node:test 直调）。
 *
 * 设计：
 *  - 返回类型是共享契约里的 IpcHandlers（每个通道的请求/响应强类型绑定）；
 *  - Electron 专属能力（目录选择、打开文件夹）由宿主以函数注入，
 *    这样 handlers 本身可被测试直接调用，不需要启动 Electron；
 *  - 业务失败（如 Agent 路径非法）抛错，由路由统一转成错误信封，detail 保留人读原因。
 */
import type {
  AgentsAdoptRequest,
  AgentsAdoptResult,
  AgentsAddCustomRequest,
  AgentsOpenFolderResult,
  AgentsRemoveSkillRequest,
  AgentsRemoveSkillResult,
  AgentsResult,
  AgentsSetEnabledRequest,
  AgentsSkillListResult,
  AgentsSkillsRequest,
  AgentsResolveConflictRequest,
  AgentsUpdatePathRequest,
  AppInfoResult,
  AppPingResult,
  ConversationCancelRequest,
  ConversationCancelResult,
  ConversationCreateRequest,
  ConversationCreateResult,
  ConversationDeleteRequest,
  ConversationDeleteResult,
  ConversationFileView,
  ConversationGetRequest,
  ConversationListItem,
  ConversationListResult,
  ConversationMessageView,
  ConversationMode,
  ConversationPrefillRequest,
  ConversationPrefillResult,
  ConversationPromptRequest,
  ConversationPromptResult,
  ConversationSkillsResult,
  ConversationReadFileRequest,
  ConversationReadChangeRequest,
  ConversationFileChangeResult,
  ConversationPreviewFileResult,
  ConversationReportView,
  ConversationSendRequest,
  ConversationSendResult,
  ConversationSetModelRequest,
  ConversationSetModelResult,
  ConversationSetThinkingLevelRequest,
  ConversationSetThinkingLevelResult,
  ConversationView,
  FirstRunImportRequest,
  InstallDiscoveryResult,
  InstallGitParseRequest,
  InstallImportRequest,
  InstallImportResult,
  InstallScanDiffRequest,
  InstallScanDiffResult,
  InstallScanResolveRequest,
  InstallScanResolveResult,
  InstallLocalScanRequest,
  InstallMarketLeaderboardRequest,
  InstallMarketDescriptionRequest,
  InstallMarketDescriptionResult,
  InstallMarketListResult,
  InstallMarketPreviewRequest,
  InstallMarketPreviewResult,
  InstallMarketReadFileRequest,
  InstallMarketReadFileResult,
  InstallMarketDiffRequest,
  InstallMarketResolveRequest,
  InstallSourcePreviewRequest,
  InstallSourcePreviewResult,
  InstallSourceReadFileRequest,
  InstallSourceReadFileResult,
  InstallMarketSearchRequest,
  InstallZipReadRequest,
  IpcHandlers,
  LibraryBatchGroupsRequest,
  LibraryBatchGroupsResult,
  LibraryDetailRequest,
  LibraryDetailResult,
  LibraryGroupsRequest,
  LibraryGroupsResult,
  LibraryListRequest,
  LibraryListResult,
  LibraryReadFileRequest,
  LibraryReadFileResult,
  LibraryRemovePlanRequest,
  LibraryRemovePlanResult,
  LibraryRemoveRequest,
  LibraryRemoveResult,
  AppEnvName,
  LibraryReportRequest,
  LibraryReportResult,
  LibrarySyncRequest,
  LibrarySyncResult,
  LibrarySyncItem,
  LibrarySyncPlanRequest,
  LibrarySyncPlanResult,
  LibrarySyncDiffRequest,
  LibrarySyncDiffResult,
  LibraryUpdateDiffRequest,
  LibraryUpdateDiffResult,
  LibraryApplyUpdateRequest,
  LibraryApplyUpdateResult,
  LibraryUnsyncRequest,
  LibraryUnsyncResult,
  LibraryWriteFileRequest,
  LibraryWriteFileResult,
  LibraryChangeDirectoryRequest,
  ProviderModelsResult,
  ProvidersAddModelRequest,
  ProvidersAddRequest,
  ProvidersRemoveRequest,
  ProvidersResult,
  ProvidersSaveKeyRequest,
  ProvidersSetActiveRequest,
  SyncCommitRequest,
  SyncCommitResult,
  SyncConnectRequest,
  SyncHistoryResult,
  SyncPullResult,
  SyncPushResult,
  SyncResolveRequest,
  SyncResolveResult,
  SyncRestoreRequest,
  SyncRestoreResult,
  SyncStatusResult,
  SyncVersionDetailRequest,
  SyncVersionDetailResult,
  CliSetupStatus,
  CliSetupInstallRequest,
  CliSetupInstallResult,
} from '../shared/ipc';
import type { AppContext } from '../context';
import { AgentError } from '../domain/agents';
import { isLocalAbsolutePath } from '../domain/path-guard';
import { asAgentError } from '../domain/agent/errors';
import { modelProfile } from '../domain/agent/model-meta';
import type { AgentSessionDetail } from '../domain/agent/types';
import { resolvePathInsideRoot } from '../domain/catalog';
import { unsupportedAppUpdateState, type AppUpdateControls } from '../domain/app-update';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface IpcHandlerDeps {
  context: AppContext;
  appInfo: () => AppInfoResult;
  version: string;
  mode: AppEnvName;
  /** Electron dialog.showOpenDialog 包装；取消返回 null */
  pickDirectory: (opts: { title?: string; defaultPath?: string }) => Promise<string | null>;
  /** Electron dialog.showOpenDialog（openFile）包装；取消返回 null（T12 压缩包） */
  pickFile: (opts: { title?: string; defaultPath?: string }) => Promise<string | null>;
  /** Electron shell.openPath 包装；成功返回空字符串 */
  openPath: (target: string) => Promise<string>;
  /**
   * 应用自更新控制器：仅打包生产环境由宿主装配；缺省（dev/uat/无更新配置）时
   * updates:* 返回 unsupported 快照，渲染层不提供检查入口。
   */
  updates?: AppUpdateControls;
  /**
   * 仅测试/自动截图使用：把路径加入安装来源白名单（等价于用户通过系统选择器选中）。
   * 不改变产品行为，渲染层无法写入。
   */
  installAllowedPaths?: string[];
  /**
   * 仅自动截图使用（T09 外壳截图需要侧栏）：强制首个状态为「已完成」以便渲染导航骨架。
   * 不写任何持久状态，也不影响首启通道本身。
   */
  firstRunOverride?: boolean;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
}

function requireString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentError('BAD_REQUEST', `参数 ${field} 必须是非空字符串`);
  }
  return value;
}

function optionalString(payload: unknown, field: string): string | undefined {
  const value = (payload as Record<string, unknown> | undefined)?.[field];
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new AgentError('BAD_REQUEST', `参数 ${field} 必须是字符串`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 详情/文件读写来源：缺省为中心库；显式 agent 时走 Agent 目录。 */
function detailOrigin(payload: unknown): 'library' | 'agent' {
  const raw = (payload as Record<string, unknown> | undefined)?.origin;
  if (raw == null || raw === 'library') return 'library';
  if (raw === 'agent') return 'agent';
  throw new AgentError('BAD_REQUEST', `未知的详情来源：${String(raw)}`);
}

/** Group 名称数组：与 ID 数组不同，空字符串是明确的参数错误（不静默丢弃）。 */
function groupArray(payload: unknown, field: string): string[] {
  const value = (payload as Record<string, unknown> | undefined)?.[field];
  if (value == null) return [];
  if (!Array.isArray(value)) throw new AgentError('BAD_REQUEST', `参数 ${field} 必须是字符串数组`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new AgentError('BAD_REQUEST', `参数 ${field} 必须是字符串数组`);
    const trimmed = item.trim();
    if (trimmed.length === 0) throw new AgentError('BAD_REQUEST', 'Group 名不能为空');
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}
function stringArray(payload: unknown, field: string): string[] {
  const value = (payload as Record<string, unknown> | undefined)?.[field];
  if (value == null) return [];
  if (!Array.isArray(value)) throw new AgentError('BAD_REQUEST', `参数 ${field} 必须是字符串数组`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new AgentError('BAD_REQUEST', `参数 ${field} 必须是字符串数组`);
    const trimmed = item.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** 提交 SHA：只接受十六进制（拒绝选项注入与任意 revision 表达式）。 */
function requireSha(payload: unknown, field: string): string {
  const value = requireString(payload, field).trim();
  if (!/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new AgentError('BAD_REQUEST', `参数 ${field} 必须是提交 ID（十六进制）`);
  }
  return value.toLowerCase();
}

/** 简易二进制判定：前 8KB 出现 NUL 或控制字符占比过高即视为二进制（不送渲染层）。 */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8192);
  if (limit === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < limit; i++) {
    const byte = buffer[i];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / limit > 0.1;
}

/**
 * 文件夹改动结果：把重建链接里失败/跳过的项收敛成界面可直接展示的文案。
 * movedSkills 是本批次被移动的技能数（0 = 空文件夹）。
 */
function folderMutationResult(
  name: string,
  movedSkills: number,
  relink: ReadonlyArray<{ dirName: string; agentId: string; agentName?: string; status: string; reason?: string }>,
): { name: string; movedSkills: number; relinkFailures: Array<{ dirName: string; agentName: string; reason: string }> } {
  return {
    name,
    movedSkills,
    relinkFailures: relink
      .filter((item) => item.status === 'failed' || item.status === 'skipped')
      .map((item) => ({
        dirName: item.dirName,
        agentName: item.agentName ?? item.agentId,
        reason: item.reason ?? '未重建',
      })),
  };
}

export function createIpcHandlers(deps: IpcHandlerDeps): IpcHandlers {
  const { context } = deps;

  // ── T15：会话辅助（列表/详情/文件读写共用） ──────────────────────────────

  /** 按目录名找库内技能（改进/评测会话的目标技能）。 */
  const skillByDirName = (dirName: string) => {
    const wanted = dirName.toLowerCase();
    return context.library.listSkills().find((s) => s.dirName.toLowerCase() === wanted) ?? null;
  };

  const sessionTarget = (detail: AgentSessionDetail) => {
    if (!detail.workflow) return null;
    const skill = skillByDirName(path.basename(detail.authorizedDir));
    return skill ? { skillId: skill.skillId, name: skill.name } : null;
  };

  const listItem = (sessionId: string, item: {
    title: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    lastMessagePreview: string | null;
    error: { code: string; detail: string } | null;
  }): ConversationListItem => {
    let detail: AgentSessionDetail | null = null;
    try {
      detail = context.conversations.getSession(sessionId);
    } catch {
      detail = null;
    }
    const target = detail ? sessionTarget(detail) : null;
    const running = detail ? detail.running : ['queued', 'running', 'cancelling'].includes(item.status);
    return {
      id: sessionId,
      title: item.title,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      messageCount: item.messageCount,
      workflow: detail?.workflow ?? null,
      targetSkillId: target?.skillId ?? null,
      targetSkillName: target?.name ?? null,
      running,
      error: item.error,
      lastMessagePreview: item.lastMessagePreview,
    };
  };

  const conversationView = (sessionId: string): ConversationView => {
    const detail = context.conversations.getSession(sessionId);
    const target = sessionTarget(detail);
    const lastAssistantByRun = new Map<string, string>();
    for (const message of detail.messages) {
      if (message.role === 'assistant' && message.runId) lastAssistantByRun.set(message.runId, message.messageId);
    }
    const messages: ConversationMessageView[] = detail.messages.map((message) => ({
      messageId: message.messageId,
      role: message.role,
      text: message.text,
      at: message.at,
      status: message.status,
      toolCalls: message.toolCalls.map((call) => ({
        id: call.toolCallId,
        name: call.name,
        summary: call.summary,
        isError: call.isError,
      })),
      fileChanges: message.runId && lastAssistantByRun.get(message.runId) === message.messageId
        ? (detail.runs.find((run) => run.runId === message.runId)?.fileChanges ?? [])
        : [],
      ...(message.runId && lastAssistantByRun.get(message.runId) === message.messageId
        ? { changeRunId: message.runId } : {}),
      ...(message.errorCode ? { errorCode: message.errorCode } : {}),
      usage: message.usage
        ? {
            input: message.usage.input,
            output: message.usage.output,
            totalTokens: message.usage.totalTokens,
            cost: message.usage.cost,
          }
        : null,
    }));
    const files: ConversationFileView[] = detail.files.map((file) => ({
      relPath: file.relPath,
      bytes: file.bytes,
      exists: fs.existsSync(file.path),
      at: file.at,
    }));
    let report: ConversationReportView | null = null;
    if (detail.workflow === 'evaluate' && target) {
      const read = context.workflows.readReport(target.skillId);
      // 报告文件名带技能名与时间戳，展示路径以实际文件为准
      const reportPath = read?.path ?? context.catalog.reportPath(target.skillId);
      const reportRel = `reports/${path.basename(reportPath)}`;
      report = {
        skillId: target.skillId,
        fileName: reportRel,
        relPath: reportRel,
        absolutePath: reportPath,
        exists: read != null,
        text: read?.text ?? null,
      };
    }
    const lastRun = detail.runs.length > 0 ? detail.runs[detail.runs.length - 1] : null;
    return {
      sessionId: detail.sessionId,
      title: detail.title,
      status: detail.status,
      workflow: detail.workflow ?? null,
      targetSkillId: target?.skillId ?? null,
      targetSkillName: target?.name ?? null,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      running: detail.running,
      canContinue: detail.resumable,
      messages,
      files,
      report,
      draftPrompt: detail.draftPrompt ?? null,
      providerId: detail.providerId,
      modelId: detail.modelId,
      modelConfigured: detail.modelConfigured,
      modelGuidance: detail.modelGuidance,
      thinkingLevel: detail.thinkingLevel,
      thinkingLevels: detail.thinkingLevels,
      error: detail.error,
      lastRun: lastRun
        ? {
            status: lastRun.status,
            startedAt: lastRun.startedAt,
            endedAt: lastRun.endedAt,
            durationMs: lastRun.durationMs,
            totalTokens: lastRun.usage?.totalTokens ?? null,
            modelId: lastRun.modelId,
          }
        : null,
    };
  };

  const modelsResult = (): ProviderModelsResult => {
    const view = context.providers.view();
    const active = view.providers.find((p) => p.id === view.activeProviderId) ?? null;
    // 每模型可选的推理强度：按 Pi 厂商目录裁剪（不支持推理的模型为空数组）
    const modelThinkingLevels: ProviderModelsResult['modelThinkingLevels'] = {};
    if (active) {
      for (const modelId of active.models) {
        modelThinkingLevels[modelId] = [...modelProfile(active.preset, modelId).thinkingLevels];
      }
    }
    return {
      providerId: active?.id ?? null,
      providerName: active?.name ?? null,
      models: active ? [...active.models] : [],
      activeModelId: view.activeModelId,
      activeThinkingLevel: view.activeThinkingLevel,
      modelThinkingLevels,
      runnable: view.runnable,
      guidance: view.guidance,
    };
  };

  /** 未配置模型时的结构化引导（含「去设置」导航数据，不让界面崩溃）。 */
  const modelGuidanceError = (): { code: string; detail: string; action: 'settings' } => {
    const view = context.providers.view();
    return {
      code: 'NO_MODEL_CONFIGURED',
      detail: view.guidance ?? '尚未配置可用的模型，请先在设置中添加供应商与模型。',
      action: 'settings',
    };
  };

  const previewSessionFile = (sessionId: string, relPath: string): ConversationPreviewFileResult => {
    const detail = context.conversations.getSession(sessionId);
    const abs = resolvePathInsideRoot(detail.authorizedDir, relPath);
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { relPath, absolutePath: abs, size: stat.size, content: null, base64: null, mediaType: null, reason: 'NOT_A_FILE' };
    }
    const maxPreviewBytes = 32 * 1024 * 1024;
    if (stat.size > maxPreviewBytes) {
      return { relPath, absolutePath: abs, size: stat.size, content: null, base64: null, mediaType: null, reason: 'TOO_LARGE' };
    }
    const ext = path.extname(abs).toLowerCase();
    const mediaTypes: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml', '.avif': 'image/avif',
      '.pdf': 'application/pdf',
    };
    const buffer = fs.readFileSync(abs);
    const mediaType = mediaTypes[ext] ?? null;
    if (mediaType) {
      return { relPath, absolutePath: abs, size: stat.size, content: null, base64: buffer.toString('base64'), mediaType, reason: null };
    }
    if (looksBinary(buffer)) {
      return { relPath, absolutePath: abs, size: stat.size, content: null, base64: null, mediaType: null, reason: 'BINARY' };
    }
    return { relPath, absolutePath: abs, size: stat.size, content: buffer.toString('utf8'), base64: null, mediaType: 'text/plain', reason: null };
  };

  /**
   * 发送：先落盘用户消息再启动运行，立即返回；进度经 conversation:event 推送。
   * 工作流会话（创建/改进/评测）走 T07 的编排（元数据、rescan、报告落盘）；
   * 其余会话是通用对话。
   */
  const sendPrompt = (
    sessionId: string,
    text: string,
    mode: 'queue' | 'steer',
    workflowIntent?: 'create' | 'improve' | 'evaluate',
  ): ConversationSendResult | Promise<ConversationSendResult> => {
    const prompt = String(text ?? '').trim();
    if (!prompt) throw new AgentError('BAD_REQUEST', '提示词不能为空');
    let detail = context.conversations.getSession(sessionId);
    if (detail.running) {
      return context.conversations.submitWhileRunning(sessionId, prompt, mode).then(() => (
        { sessionId, accepted: true, status: mode === 'steer' ? 'steered' : 'queued' }
      ));
    }
    const slashName = /^\/([a-z0-9-]+)(?=\s|$)/i.exec(prompt)?.[1] ?? null;
    const slashAction = slashName === 'skill-creator' || slashName === 'skill-creator-sop' ? 'create'
      : slashName === 'skill-improve' ? 'improve'
      : slashName === 'skill-doctor' ? 'evaluate' : null;
    // `/` 候选来自 agents/skills（工作台 Agent 的内部 Skill，含用户随时投放的），不是中心库
    const slashSkill = slashName != null && context.conversations.listAvailableSkills().some((skill) => skill.name === slashName)
      ? slashName : null;
    const selectedSkill = slashAction ? slashSkill : null;
    const action = selectedSkill ? slashAction : workflowIntent;
    if (action) {
      context.workflows.bindLibraryWorkflow(sessionId, action, selectedSkill ?? undefined);
      detail = context.conversations.getSession(sessionId);
    } else if (slashSkill) {
      // 三个内置流程之外的内部 Skill：把它的 SKILL.md 正文注入本次会话（任意投放的 Skill 也真执行）
      context.workflows.bindInternalSkill(sessionId, slashSkill);
      detail = context.conversations.getSession(sessionId);
    } else if (detail.workflow === 'evaluate' && detail.runs.length > 0) {
      // 检查流程只用于本轮评测；后续普通追问可能要求直接修复，不能继续受 skill-doctor 的「只诊断」约束。
      context.conversations.setWorkflow(sessionId, null, '');
      detail = context.conversations.getSession(sessionId);
    }
    try {
      context.providers.getSelection(detail.modelId ?? undefined);
    } catch (err) {
      const normalized = asAgentError(err, 'NO_MODEL_CONFIGURED');
      return {
        sessionId,
        accepted: false,
        status: detail.status,
        error: { code: normalized.code, detail: normalized.detail, action: 'settings' },
      };
    }
    const modelId = detail.modelId ?? undefined;
    const run = async (): Promise<unknown> => {
      if (detail.workflow === 'create') return context.workflows.runCreate(sessionId, { prompt, modelId });
      if (detail.workflow === 'improve') return context.workflows.runImprove(sessionId, { prompt, modelId });
      if (detail.workflow === 'evaluate') return context.workflows.runEvaluate(sessionId, { prompt, modelId });
      const result = await context.conversations.startRun(sessionId, { prompt, modelId });
      // 普通对话也可能在 skills/ 内新建或改写技能：运行后重扫一次，让库索引跟上
      const left = path.resolve(detail.authorizedDir);
      const right = path.resolve(context.workflows.library.skillsDir);
      const scopeDir = process.platform === 'win32' ? left.toLowerCase() : left;
      const skillsDir = process.platform === 'win32' ? right.toLowerCase() : right;
      if (scopeDir === skillsDir || scopeDir.startsWith(`${skillsDir}${path.sep}`)) {
        await context.workflows.library.rescan();
      }
      return result;
    };
    // 后台运行：错误通过事件流与会话状态呈现，这里只记录，不让 IPC 调用悬挂
    void Promise.resolve()
      .then(run)
      .then(() => {
        // 工作流后处理（rescan / 报告落盘 / 来源标记）已完成 → 通知界面重新拉取详情
        context.conversations.touch(sessionId);
      })
      .catch((err: unknown) => {
        const normalized = asAgentError(err, 'PI_RUN_FAILED');
        deps.logger?.error('conversation:send-failed', {
          sessionId,
          code: normalized.code,
          detail: normalized.detail,
        });
      });
    return { sessionId, accepted: true, status: 'queued' };
  };

  // 测试/截图注入：只把明确给定的路径加入安装白名单（产品路径仍由选择器产生）
  for (const allowed of deps.installAllowedPaths ?? []) {
    context.install.allowDirectory(allowed);
    context.install.allowFile(allowed);
  }

  const agentsResult = (): AgentsResult => {
    const agents = context.agents.list();
    return {
      agents,
      stats: {
        detected: agents.filter((a) => a.installed).length,
        enabled: agents.filter((a) => a.enabled).length,
        custom: agents.filter((a) => !a.builtin).length,
        total: agents.length,
      },
    };
  };

  const providersResult = (): ProvidersResult => {
    const view = context.providers.view();
    return {
      providers: view.providers.map((p) => ({
        id: p.id,
        name: p.name,
        preset: p.preset,
        apiFormat: p.apiFormat,
        baseUrl: p.baseUrl,
        requiresApiKey: p.requiresApiKey,
        // Key 只写不读：只暴露「是否已配置」
        credentialConfigured: p.credentialConfigured,
        modelCount: p.models.length,
        models: [...p.models],
      })),
      activeProviderId: view.activeProviderId,
      presets: view.presets.map((p) => ({
        preset: p.preset,
        label: p.label,
        apiFormat: p.apiFormat,
        defaultBaseUrl: p.defaultBaseUrl,
        requiresApiKey: p.requiresApiKey,
        suggestedModels: [...p.suggestedModels],
      })),
      credentialBackend: view.credentialBackend,
      guidance: view.guidance,
      runnable: view.runnable,
    };
  };

  return {
    'app:ping': (): AppPingResult => ({ ok: true, appEnv: deps.mode }),
    'app:info': () => deps.appInfo(),

    'app:getInitialState': () => ({
      firstRunCompleted: deps.firstRunOverride ?? context.state.firstRunCompleted,
      libraryPath: context.libraryDir,
      mode: deps.mode,
      version: deps.version,
    }),

    'app:pickDirectory': async (payload) => {
      const opts = (payload ?? {}) as { title?: string; defaultPath?: string };
      const picked = await deps.pickDirectory({
        title: typeof opts.title === 'string' ? opts.title : undefined,
        defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      });
      // 用户亲手选过的目录才允许后续扫描（T12 安装来源白名单）
      if (picked) context.install.allowDirectory(picked);
      return { path: picked };
    },

    'app:pickFile': async (payload) => {
      const opts = (payload ?? {}) as { title?: string; defaultPath?: string };
      const picked = await deps.pickFile({
        title: typeof opts.title === 'string' ? opts.title : undefined,
        defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      });
      if (picked) context.install.allowFile(picked);
      return { path: picked };
    },

    'firstRun:scan': () => context.firstRun.scan(),

    'firstRun:import': async (payload: FirstRunImportRequest) => {
      if (!Array.isArray(payload?.keys)) {
        throw new AgentError('BAD_REQUEST', 'keys 必须是字符串数组');
      }
      const keys = payload.keys.filter((k): k is string => typeof k === 'string');
      return context.firstRun.importSelected(keys);
    },

    'firstRun:complete': () => context.firstRun.complete(),

    'library:getOverview': () => context.overview().overview(),

    'library:getRecentActivity': () => context.overview().recentActivity(),

    'library:changeDirectory': async (payload: LibraryChangeDirectoryRequest) => {
      const targetDir = requireString(payload, 'targetDir');
      if (!isLocalAbsolutePath(targetDir)) {
        throw new AgentError('BAD_REQUEST', `目标目录必须是绝对路径：${targetDir}`);
      }
      const policy = payload?.policy;
      if (policy != null && policy !== 'empty' && policy !== 'merge') {
        throw new AgentError('BAD_REQUEST', `未知的迁移策略：${String(policy)}`);
      }
      return context.changeLibraryDirectory(targetDir, policy);
    },

    'library:openFolder': async () => {
      const path = context.libraryDir;
      const error = await deps.openPath(path);
      return { ok: error === '', path, error: error === '' ? undefined : error };
    },

    'agents:list': () => agentsResult(),

    'agents:redetect': () => {
      context.agents.redetect();
      return agentsResult();
    },

    'agents:setEnabled': (payload: AgentsSetEnabledRequest) => {
      if (typeof payload?.enabled !== 'boolean') {
        throw new AgentError('BAD_REQUEST', 'enabled 必须是布尔值');
      }
      if (payload.agentId !== undefined) {
        // 显式给了 agentId 就只改这一个；空串视为参数错误，避免误伤「全部禁用」
        context.agents.setEnabled(requireString(payload, 'agentId'), payload.enabled);
      } else {
        context.agents.setEnabledAll(payload.enabled);
      }
      return agentsResult();
    },

    'agents:updatePath': (payload: AgentsUpdatePathRequest) => {
      const agentId = requireString(payload, 'agentId');
      const skillsDir = requireString(payload, 'skillsDir');
      context.agents.updateDir(agentId, skillsDir);
      return agentsResult();
    },

    'agents:addCustom': (payload: AgentsAddCustomRequest) => {
      const name = requireString(payload, 'name');
      const skillsDir = requireString(payload, 'skillsDir');
      context.agents.addCustom({ name, skillsDir });
      return agentsResult();
    },

    /* ────────────────────────── T13：Agents 页 ────────────────────────── */

    'agents:listSkills': (payload: AgentsSkillsRequest): AgentsSkillListResult =>
      context.agentSkills.list(requireString(payload, 'agentId')),

    'agents:resolveConflict': async (payload: AgentsResolveConflictRequest): Promise<LibrarySyncItem> => {
      const skillId = requireString(payload, 'skillId');
      const agentId = requireString(payload, 'agentId');
      const fingerprint = requireString(payload, 'fingerprint');
      const sourceHash = requireString(payload, 'sourceHash');
      if (payload.choice !== 'overwrite' && payload.choice !== 'skip') throw new AgentError('BAD_REQUEST', '未知的处理方式');
      return context.deploy.resolveAgentConflict({ skillId, agentId, fingerprint, sourceHash, choice: payload.choice });
    },

    'agents:rescan': (payload: AgentsSkillsRequest): Promise<AgentsSkillListResult> =>
      context.agentSkills.rescan(requireString(payload, 'agentId')),

    'agents:adopt': (payload: AgentsAdoptRequest): Promise<AgentsAdoptResult> =>
      context.agentSkills.adopt(requireString(payload, 'agentId'), requireString(payload, 'dirName')),

    'agents:removeSkill': (payload: AgentsRemoveSkillRequest): Promise<AgentsRemoveSkillResult> =>
      context.agentSkills.remove(requireString(payload, 'agentId'), requireString(payload, 'dirName')),

    /** 只按 agentId 取清单里的目录，渲染层无法传入任意路径。 */
    'agents:openFolder': async (payload: AgentsSkillsRequest): Promise<AgentsOpenFolderResult> => {
      const agentId = requireString(payload, 'agentId');
      const agent = context.agents.get(agentId);
      if (!agent) throw new AgentError('BAD_REQUEST', `未知的 Agent：${agentId}`);
      const skillsDir = agent.skillsDir;
      if (!fs.existsSync(skillsDir)) return { ok: false, path: skillsDir, error: '目录不存在' };
      const error = await deps.openPath(skillsDir);
      return { ok: error === '', path: skillsDir, error: error === '' ? undefined : error };
    },

    'providers:list': () => providersResult(),

    'providers:add': (payload: ProvidersAddRequest) => {
      const preset = requireString(payload, 'preset');
      const models = Array.isArray(payload.models)
        ? payload.models.filter((model): model is string => typeof model === 'string')
        : undefined;
      const record = context.providers.addProvider({
        preset,
        name: payload.name,
        baseUrl: payload.baseUrl,
        apiFormat: payload.apiFormat,
        models,
      });
      if (typeof payload.apiKey === 'string' && payload.apiKey.trim().length > 0) {
        context.providers.setApiKey(record.id, payload.apiKey);
      }
      return providersResult();
    },

    'providers:setActive': (payload: ProvidersSetActiveRequest) => {
      const providerId = requireString(payload, 'providerId');
      context.providers.setActiveProvider(providerId);
      return providersResult();
    },

    'providers:saveKey': (payload: ProvidersSaveKeyRequest) => {
      const providerId = requireString(payload, 'providerId');
      const apiKey = requireString(payload, 'apiKey');
      context.providers.setApiKey(providerId, apiKey);
      return providersResult();
    },

    /* 删除供应商：连带清除其模型清单与凭据；生效供应商被删时自动切到列表第一条 */
    'providers:remove': (payload: ProvidersRemoveRequest) => {
      const providerId = requireString(payload, 'providerId');
      context.providers.removeProvider(providerId);
      return providersResult();
    },

    /* ────────────────────────── T11：Skills 中心库 ────────────────────────── */

    'library:list': (payload: LibraryListRequest): LibraryListResult => {
      const folder = (payload as { folder?: unknown } | undefined)?.folder;
      if (folder !== undefined && typeof folder !== 'string') {
        throw new AgentError('BAD_REQUEST', '参数 folder 必须是字符串');
      }
      const filter: LibraryListRequest = {
        query: optionalString(payload, 'query'),
        folder,
        group: optionalString(payload, 'group'),
        sourceType: optionalString(payload, 'sourceType'),
        origin: optionalString(payload, 'origin'),
        agentId: optionalString(payload, 'agentId'),
      };
      return context.catalog.list(filter);
    },

    'library:folders': async () => ({ folders: await context.library.listFolders() }),
    'library:createFolder': (payload: { name?: unknown }) => ({
      name: context.library.createFolder(typeof payload?.name === 'string' ? payload.name : ''),
    }),
    'library:renameFolder': async (payload: { from?: unknown; to?: unknown }) => {
      const from = typeof payload?.from === 'string' ? payload.from : '';
      const to = typeof payload?.to === 'string' ? payload.to : '';
      const moved = await context.library.renameFolder(from, to);
      // 库内路径变了，指向旧位置的 Agent 链接必须跟着重建（按原落点，不动落点记忆）
      const relink = moved.length > 0 ? await context.deploy.relinkMoved(moved) : [];
      return folderMutationResult(to, moved.length, relink);
    },
    'library:removeFolder': async (payload: { name?: unknown }) => {
      const name = typeof payload?.name === 'string' ? payload.name : '';
      const moved = await context.library.removeFolder(name);
      const relink = moved.length > 0 ? await context.deploy.relinkMoved(moved) : [];
      return folderMutationResult('', moved.length, relink);
    },
    'library:moveSkill': async (payload: { skillId?: unknown; folder?: unknown }) => {
      const skillId = typeof payload?.skillId === 'string' ? payload.skillId : '';
      const folder = typeof payload?.folder === 'string' ? payload.folder : '';
      const moved = await context.library.moveSkill(skillId, folder);
      const relink = moved.length > 0 ? await context.deploy.relinkMoved(moved) : [];
      return folderMutationResult(folder, moved.length, relink);
    },

    'library:facets': (payload) => {
      const folder = (payload as { folder?: unknown } | undefined)?.folder;
      if (folder !== undefined && typeof folder !== 'string') {
        throw new AgentError('BAD_REQUEST', '参数 folder 必须是字符串');
      }
      return context.catalog.facets(folder);
    },

    'library:checkUpdates': async () => {
      await context.updates.checkAll();
      return { checked: true as const };
    },

    // 打开中心库页时前端触发一次全量对账（2026-11-02 用户定：去掉 3 秒轮询后，
    // 手动移动技能目录靠「打开页面」与库监视事件两条路恢复）
    'library:rescan': async () => {
      const res = await context.library.rescan();
      // 打开中心库页触发的对账：等过期链接重定向完成再返回，界面探针立即拿到正确状态
      await context.deploy.reconcileStaleLinks();
      return { total: res.total, added: res.added, changed: res.changed, missing: res.missing, restored: res.restored };
    },

    'library:detail': (payload: LibraryDetailRequest): LibraryDetailResult => {
      if (detailOrigin(payload) === 'agent') {
        return context.agentSkills.detail(requireString(payload, 'agentId'), requireString(payload, 'dirName'));
      }
      return context.catalog.detail(requireString(payload, 'skillId'));
    },

    'library:readFile': (payload: LibraryReadFileRequest): LibraryReadFileResult => {
      const relPath = requireString(payload, 'relPath');
      if (detailOrigin(payload) === 'agent') {
        return context.agentSkills.readFile(
          requireString(payload, 'agentId'),
          requireString(payload, 'dirName'),
          relPath,
        );
      }
      return context.catalog.readFile(requireString(payload, 'skillId'), relPath);
    },

    'library:writeFile': async (payload: LibraryWriteFileRequest): Promise<LibraryWriteFileResult> => {
      const relPath = requireString(payload, 'relPath');
      const content = (payload as { content?: unknown }).content;
      if (typeof content !== 'string') {
        throw new AgentError('BAD_REQUEST', '参数 content 必须是字符串');
      }
      if (detailOrigin(payload) === 'agent') {
        return context.agentSkills.writeFile(
          requireString(payload, 'agentId'),
          requireString(payload, 'dirName'),
          relPath,
          content,
        );
      }
      return context.catalog.writeFile(requireString(payload, 'skillId'), relPath, content);
    },

    'library:setGroups': async (payload: LibraryGroupsRequest): Promise<LibraryGroupsResult> => {
      const skillId = requireString(payload, 'skillId');
      return context.catalog.setGroups(skillId, {
        add: groupArray(payload, 'add'),
        remove: groupArray(payload, 'remove'),
      });
    },

    'library:batchGroups': async (payload: LibraryBatchGroupsRequest): Promise<LibraryBatchGroupsResult> => {
      const skillIds = stringArray(payload, 'skillIds');
      if (skillIds.length === 0) throw new AgentError('BAD_REQUEST', 'skillIds 不能为空');
      return context.catalog.batchGroups(skillIds, {
        add: groupArray(payload, 'add'),
        remove: groupArray(payload, 'remove'),
      });
    },

    'library:planSyncToAgents': async (payload: LibrarySyncPlanRequest): Promise<LibrarySyncPlanResult> => {
      const skillIds = stringArray(payload, 'skillIds');
      const agentIds = stringArray(payload, 'agentIds');
      if (skillIds.length === 0 || agentIds.length === 0) throw new AgentError('BAD_REQUEST', '请选择 Skill 和 Agent');
      return { items: await context.deploy.planSyncToAgents(skillIds, agentIds) };
    },

    'library:syncDiff': async (payload: LibrarySyncDiffRequest): Promise<LibrarySyncDiffResult> => {
      return context.deploy.syncDiff({
        skillId: requireString(payload, 'skillId'),
        agentId: requireString(payload, 'agentId'),
        fingerprint: requireString(payload, 'fingerprint'),
        sourceHash: requireString(payload, 'sourceHash'),
        relPath: payload.relPath === undefined ? undefined : requireString(payload, 'relPath'),
      });
    },

    'library:syncToAgents': async (payload: LibrarySyncRequest): Promise<LibrarySyncResult> => {
      const skillIds = stringArray(payload, 'skillIds');
      const agentIds = stringArray(payload, 'agentIds');
      if (skillIds.length === 0) throw new AgentError('BAD_REQUEST', 'skillIds 不能为空');
      if (agentIds.length === 0) throw new AgentError('BAD_REQUEST', 'agentIds 不能为空');

      // 只列已启用（且已安装）的 Agent：其余如实回报为忽略项，不静默当作成功
      const ignoredAgents: LibrarySyncResult['ignoredAgents'] = [];
      const targets: string[] = [];
      for (const agentId of agentIds) {
        const agent = context.agents.get(agentId);
        if (!agent) {
          ignoredAgents.push({ agentId, reason: 'Agent 不存在' });
          continue;
        }
        if (!agent.enabled) {
          ignoredAgents.push({ agentId, reason: `${agent.name} 已停用，不作为同步目标` });
          continue;
        }
        if (!agent.installed) {
          ignoredAgents.push({ agentId, reason: `未检测到 ${agent.name} 的 Skills 目录` });
          continue;
        }
        targets.push(agentId);
      }
      if (targets.length === 0) {
        return {
          items: [],
          summary: { deployed: 0, already: 0, conflict: 0, failed: 0, skipped: 0 },
          ignoredAgents,
        };
      }
      const decisions = payload.decisions === undefined ? undefined : (() => {
        if (!Array.isArray(payload.decisions)) throw new AgentError('BAD_REQUEST', '同步选择格式不正确');
        const seen = new Set<string>();
        return payload.decisions.map((item) => {
          if (!skillIds.includes(item.skillId) || !targets.includes(item.agentId) ||
              (item.choice !== 'overwrite' && item.choice !== 'skip') ||
              typeof item.fingerprint !== 'string' || item.fingerprint.length === 0 ||
              typeof item.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(item.sourceHash)) {
            throw new AgentError('BAD_REQUEST', '同步选择无效，请重新检查');
          }
          const key = `${item.skillId}\0${item.agentId}`;
          if (seen.has(key)) throw new AgentError('BAD_REQUEST', '同步选择重复');
          seen.add(key);
          return item;
        });
      })();
      const result = decisions === undefined
        ? await context.deploy.syncToAgents(skillIds, targets)
        : await context.deploy.syncToAgentsResolved(skillIds, targets, decisions);
      return {
        items: result.items.map((item) => ({
          skillId: item.skillId,
          dirName: item.dirName,
          agentId: item.agentId,
          agentName: item.agentName,
          status: item.status,
          linkType: item.linkType,
          reason: item.reason,
          code: item.code,
        })),
        summary: result.summary,
        ignoredAgents,
      };
    },

    'library:unsyncFromAgents': async (payload: LibraryUnsyncRequest): Promise<LibraryUnsyncResult> => {
      const skillIds = stringArray(payload, 'skillIds');
      const agentIds = stringArray(payload, 'agentIds');
      if (skillIds.length === 0) throw new AgentError('BAD_REQUEST', 'skillIds 不能为空');
      if (agentIds.length === 0) throw new AgentError('BAD_REQUEST', 'agentIds 不能为空');
      const items: LibraryUnsyncResult['items'] = [];
      for (const skillId of skillIds) {
        const results = await context.deploy.undeployFromAgents(skillId, agentIds);
        for (const r of results) {
          items.push({
            skillId: r.skillId,
            dirName: r.dirName,
            agentId: r.agentId,
            agentName: r.agentName,
            status: r.status,
            reason: r.reason,
            code: r.code,
          });
        }
      }
      return { items };
    },

    'library:updateDiff': async (payload: LibraryUpdateDiffRequest): Promise<LibraryUpdateDiffResult> => {
      const skillId = requireString(payload, 'skillId');
      const relPath = typeof payload.relPath === 'string' ? payload.relPath : undefined;
      const expected = typeof payload.sourceHash === 'string' && typeof payload.targetHash === 'string'
        ? { sourceHash: payload.sourceHash, targetHash: payload.targetHash } : undefined;
      return context.updates.getDiff(skillId, relPath, expected);
    },

    'library:applyUpdate': async (payload: LibraryApplyUpdateRequest): Promise<LibraryApplyUpdateResult> => {
      const skillId = requireString(payload, 'skillId');
      const choice = payload.choice;
      if (choice !== 'skip' && choice !== 'overwrite') throw new AgentError('BAD_REQUEST', '更新操作无效');
      return context.updates.apply(skillId, choice, requireString(payload, 'sourceHash'), requireString(payload, 'targetHash'));
    },

    'library:removePlan': (payload: LibraryRemovePlanRequest): LibraryRemovePlanResult => {
      const plan = context.removal.planRemoval(requireString(payload, 'skillId'));
      return {
        skillId: plan.skillId,
        dirName: plan.dirName,
        name: plan.name,
        linksToRemove: plan.linksToRemove.map((t) => ({
          agentId: t.agentId,
          agentName: t.agentName,
          targetPath: t.targetPath,
        })),
        skippedTargets: plan.skippedTargets.map((t) => ({
          agentId: t.agentId,
          agentName: t.agentName,
          targetPath: t.targetPath,
          reason: t.reason,
        })),
        hasReport: plan.hasReport,
        reportPath: plan.reportPath,
      };
    },

    'library:remove': async (payload: LibraryRemoveRequest): Promise<LibraryRemoveResult> => {
      const skillId = requireString(payload, 'skillId');
      // 删除必须显式确认，缺省一律拒绝（tec.md §5.14 / prd.md 5.1）
      if ((payload as { confirm?: unknown }).confirm !== true) {
        throw new AgentError('BAD_REQUEST', '删除需要二次确认（confirm=true）');
      }
      const result = await context.removal.removeSkill(skillId);
      return {
        skillId: result.skillId,
        name: result.name,
        removedLinks: result.removedLinks,
        reportDeleted: result.reportDeleted,
        libraryDirDeleted: result.libraryDirDeleted,
        remainingSkills: result.remainingSkills,
        skippedTargets: result.skippedTargets.map((t) => ({
          agentId: t.agentId,
          agentName: t.agentName,
          targetPath: t.targetPath,
          reason: t.reason,
        })),
      };
    },

    'library:report': (payload: LibraryReportRequest): LibraryReportResult =>
      context.catalog.report(requireString(payload, 'skillId')),

    'conversation:prefill': (payload: ConversationPrefillRequest): ConversationPrefillResult => {
      const skillId = requireString(payload, 'skillId');
      const mode = (payload as { mode?: unknown }).mode;
      if (mode !== 'improve' && mode !== 'evaluate') {
        throw new AgentError('BAD_REQUEST', `未知的预填模式：${String(mode)}`);
      }
      // 只建会话 + 预填提示词，不启动运行（运行由 T15「发送」触发）
      const conversation =
        mode === 'improve'
          ? context.workflows.startImproveConversation(skillId)
          : context.workflows.startEvaluateConversation(skillId);
      // T15：草稿持久化，切换到对话页（或重启后）仍能回填到输入框
      context.conversations.setDraftPrompt(conversation.sessionId, conversation.prompt);
      return {
        mode,
        sessionId: conversation.sessionId,
        prompt: conversation.prompt,
        skillId: conversation.skillId,
        dirName: conversation.dirName,
        skillName: conversation.skillName,
      };
    },

    /* ────────────────────────── T15：新对话与文件区 ────────────────────────── */

    'conversation:list': (): ConversationListResult => {
      const items = context.conversations.listSessions().map((summary) =>
        listItem(summary.sessionId, {
          title: summary.title,
          status: summary.status,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          messageCount: summary.messageCount,
          lastMessagePreview: summary.lastMessagePreview,
          error: summary.error,
        }),
      );
      return { items };
    },

    'conversation:get': (payload: ConversationGetRequest): ConversationView =>
      conversationView(requireString(payload, 'sessionId')),

    'conversation:create': (payload: ConversationCreateRequest): ConversationCreateResult => {
      const mode = (payload as { mode?: unknown })?.mode;
      if (mode !== 'blank' && mode !== 'create' && mode !== 'improve' && mode !== 'evaluate') {
        throw new AgentError('BAD_REQUEST', `未知的会话模式：${String(mode)}`);
      }
      const targetSkillId = optionalString(payload, 'targetSkillId');
      const targetName = optionalString(payload, 'targetName');

      const fail = (err: unknown): ConversationCreateResult => {
        const normalized = asAgentError(err, 'TARGET_INVALID');
        const rawCode = (err as { code?: unknown } | null)?.code;
        const code = typeof rawCode === 'string' ? rawCode : normalized.code;
        const rawDetail =
          err instanceof Error ? err.message.replace(/^[A-Z][A-Z_]+: /, '') : normalized.detail;
        return {
          mode,
          sessionId: null,
          prompt: '',
          targetSkillId: targetSkillId ?? null,
          targetSkillName: null,
          dirName: null,
          error: { code, detail: rawDetail, action: 'settings' },
        };
      };

      try {
        if (mode === 'blank') {
          // 新对话也授权到中心库 skills/ 根：聊天页三个快捷入口只往输入框填提示词，
          // 由 Agent 在库里自行定位目标（内置 skill 另以只读根暴露，见 ConversationService）。
          const session = context.conversations.createSession({
            authorizedDir: path.resolve(context.workflows.library.skillsDir),
            title: '新对话',
          });
          return {
            mode,
            sessionId: session.sessionId,
            prompt: '',
            targetSkillId: null,
            targetSkillName: null,
            dirName: null,
          };
        }
        if (mode === 'create') {
          // 提供目标名 → 复用 T07 创建会话（预建库内目录）；未提供 → 落到会话工作区
          if (targetName) {
            const conversation = context.workflows.startCreateConversation({ targetName });
            context.conversations.setDraftPrompt(conversation.sessionId, conversation.prompt);
            return {
              mode,
              sessionId: conversation.sessionId,
              prompt: conversation.prompt,
              targetSkillId: null,
              targetSkillName: null,
              dirName: conversation.targetName,
            };
          }
          const session = context.workflows.startLibraryConversation('create');
          context.conversations.setDraftPrompt(session.sessionId, session.prompt);
          return {
            mode,
            sessionId: session.sessionId,
            prompt: session.prompt,
            targetSkillId: null,
            targetSkillName: null,
            dirName: null,
          };
        }
        if (!targetSkillId) {
          // 聊天页快捷入口：授权到 skills/ 根，不指定目标技能，由 Agent 在库内自行定位
          const session = context.workflows.startLibraryConversation(mode);
          context.conversations.setDraftPrompt(session.sessionId, session.prompt);
          return {
            mode,
            sessionId: session.sessionId,
            prompt: session.prompt,
            targetSkillId: null,
            targetSkillName: null,
            dirName: null,
          };
        }
        const conversation =
          mode === 'improve'
            ? context.workflows.startImproveConversation(targetSkillId)
            : context.workflows.startEvaluateConversation(targetSkillId);
        context.conversations.setDraftPrompt(conversation.sessionId, conversation.prompt);
        return {
          mode,
          sessionId: conversation.sessionId,
          prompt: conversation.prompt,
          targetSkillId: conversation.skillId,
          targetSkillName: conversation.skillName,
          dirName: conversation.dirName,
        };
      } catch (err) {
        deps.logger?.error('conversation:create-failed', {
          mode,
          detail: err instanceof Error ? err.message : String(err),
        });
        return fail(err);
      }
    },

    'conversation:prompt': (payload: ConversationPromptRequest): ConversationPromptResult => {
      const mode = payload?.mode;
      if (mode !== 'create' && mode !== 'improve' && mode !== 'evaluate') {
        throw new AgentError('BAD_REQUEST', `未知的快捷项：${String(mode)}`);
      }
      // 只取模板文本：不建会话、不启动运行；提示词里不写目标技能名
      return { prompt: context.workflows.buildPrompt(mode, { libraryScope: true }) };
    },

    'conversation:skills': (): ConversationSkillsResult => ({
      items: context.conversations.listAvailableSkills(),
    }),

    'conversation:send': (payload: ConversationSendRequest): ConversationSendResult | Promise<ConversationSendResult> => {
      const workflowIntent = payload.workflowIntent;
      if (workflowIntent != null && workflowIntent !== 'create' && workflowIntent !== 'improve' && workflowIntent !== 'evaluate') {
        throw new AgentError('BAD_REQUEST', `未知的内部 Skill 流程：${String(workflowIntent)}`);
      }
      return sendPrompt(
        requireString(payload, 'sessionId'), requireString(payload, 'text'),
        payload.mode === 'steer' ? 'steer' : 'queue', workflowIntent,
      );
    },

    'conversation:cancel': async (payload: ConversationCancelRequest): Promise<ConversationCancelResult> => {
      const sessionId = requireString(payload, 'sessionId');
      try {
        await context.conversations.cancelRun(sessionId);
        return { sessionId, canceled: true };
      } catch (err) {
        const normalized = asAgentError(err, 'NO_ACTIVE_RUN');
        if (normalized.code === 'NO_ACTIVE_RUN') {
          return { sessionId, canceled: false };
        }
        throw err;
      }
    },

    'conversation:delete': (payload: ConversationDeleteRequest): ConversationDeleteResult => {
      const sessionId = requireString(payload, 'sessionId');
      context.conversations.deleteSession(sessionId);
      return { sessionId, deleted: true };
    },

    'conversation:setModel': (payload: ConversationSetModelRequest): ConversationSetModelResult => {
      const sessionId = requireString(payload, 'sessionId');
      const modelId = requireString(payload, 'modelId');
      context.conversations.setModel(sessionId, modelId);
      // 同步为当前生效模型，下一条消息沿用
      context.providers.setActiveModel(modelId);
      return { sessionId, modelId };
    },

    'conversation:setThinkingLevel': (
      payload: ConversationSetThinkingLevelRequest,
    ): ConversationSetThinkingLevelResult => {
      const sessionId = requireString(payload, 'sessionId');
      const thinkingLevel = requireString(payload, 'thinkingLevel') as ConversationSetThinkingLevelResult['thinkingLevel'];
      context.conversations.setThinkingLevel(sessionId, thinkingLevel);
      return { sessionId, thinkingLevel };
    },

    'conversation:previewFile': (payload: ConversationReadFileRequest): ConversationPreviewFileResult =>
      previewSessionFile(requireString(payload, 'sessionId'), requireString(payload, 'relPath')),

    'conversation:fileChange': (payload: ConversationReadChangeRequest): ConversationFileChangeResult =>
      context.conversations.getFileChange(
        requireString(payload, 'sessionId'),
        requireString(payload, 'runId'),
        requireString(payload, 'relPath'),
      ),

    'conversation:showFile': async (payload: ConversationReadFileRequest): Promise<{ opened: boolean }> => {
      const sessionId = requireString(payload, 'sessionId');
      const relPath = requireString(payload, 'relPath');
      const detail = context.conversations.getSession(sessionId);
      const abs = resolvePathInsideRoot(detail.authorizedDir, relPath);
      if (!fs.lstatSync(abs).isFile()) throw new AgentError('BAD_REQUEST', '文件不存在');
      const error = await deps.openPath(path.dirname(abs));
      if (error) throw new AgentError('OPEN_FAILED', error);
      return { opened: true };
    },

    'conversation:showReport': async (payload: { skillId: string }): Promise<{ opened: boolean }> => {
      const skillId = requireString(payload, 'skillId');
      const reportPath = context.catalog.reportPath(skillId);
      if (!fs.statSync(reportPath).isFile()) throw new AgentError('BAD_REQUEST', '评测报告不存在');
      const error = await deps.openPath(path.dirname(reportPath));
      if (error) throw new AgentError('OPEN_FAILED', error);
      return { opened: true };
    },

    'providers:models': (): ProviderModelsResult => modelsResult(),

    'providers:addModel': (payload: ProvidersAddModelRequest): ProviderModelsResult => {
      const modelId = requireString(payload, 'modelId');
      const providerId = optionalString(payload, 'providerId');
      const view = context.providers.view();
      const target = providerId ?? view.activeProviderId;
      if (!target) {
        throw new AgentError('BAD_REQUEST', '尚未选择供应商：请先在设置中添加供应商');
      }
      context.providers.addModel(target, modelId);
      // 新增后立即可用：仅当当前供应商就是目标供应商时设为生效模型
      if (view.activeProviderId === target) {
        context.providers.setActiveModel(modelId);
      }
      return modelsResult();
    },

    /* ────────────────────────── T12：安装 Skills ────────────────────────── */

    'install:marketLeaderboard': (payload: InstallMarketLeaderboardRequest): Promise<InstallMarketListResult> => {
      const force = (payload as { force?: unknown } | undefined)?.force === true;
      const provider = (payload as { provider?: unknown } | undefined)?.provider;
      if (provider != null && provider !== 'skills.sh' && provider !== 'skillhub') throw new AgentError('BAD_REQUEST', '未知技能市场');
      return context.install.marketLeaderboard(force, provider ?? 'skills.sh');
    },

    'install:marketSearch': (payload: InstallMarketSearchRequest): Promise<InstallMarketListResult> => {
      const query = requireString(payload, 'query');
      const force = (payload as { force?: unknown }).force === true;
      const provider = (payload as { provider?: unknown }).provider;
      if (provider != null && provider !== 'skills.sh' && provider !== 'skillhub') throw new AgentError('BAD_REQUEST', '未知技能市场');
      return context.install.marketSearch(query, force, provider ?? 'skills.sh');
    },

    'install:marketDescription': (payload: InstallMarketDescriptionRequest): Promise<InstallMarketDescriptionResult> => {
      const source = requireString(payload, 'source');
      const skillId = requireString(payload, 'skillId');
      return context.install.marketDescription(source, skillId);
    },

    'install:marketPreview': (payload: InstallMarketPreviewRequest): Promise<InstallMarketPreviewResult> => {
      const raw = (payload ?? {}) as InstallMarketPreviewRequest;
      const key = optionalString(raw, 'key');
      const source = optionalString(raw, 'source');
      const skillId = optionalString(raw, 'skillId');
      if (key == null && (source == null || skillId == null)) {
        throw new AgentError('BAD_REQUEST', '需要市场条目的 key，或 source + skillId');
      }
      return context.install.marketPreview({ ...raw, key, source, skillId });
    },
    'install:marketReadFile': (payload: InstallMarketReadFileRequest): Promise<InstallMarketReadFileResult> => {
      const source = requireString(payload, 'source');
      const skillId = requireString(payload, 'skillId');
      const relativePath = requireString(payload, 'path');
      return context.install.marketReadFile(source, skillId, relativePath);
    },
    'install:sourcePreview': (payload: InstallSourcePreviewRequest): InstallSourcePreviewResult => {
      const channel = requireString(payload, 'channel') as InstallSourcePreviewRequest['channel'];
      const key = requireString(payload, 'key');
      return context.install.sourcePreview(channel, key);
    },
    'install:sourceReadFile': (payload: InstallSourceReadFileRequest): InstallSourceReadFileResult => {
      const channel = requireString(payload, 'channel') as InstallSourceReadFileRequest['channel'];
      const key = requireString(payload, 'key');
      const relativePath = requireString(payload, 'path');
      return context.install.sourceReadFile(channel, key, relativePath);
    },

    'install:marketDiff': (payload: InstallMarketDiffRequest): InstallScanDiffResult =>
      context.install.marketDiff({ key: requireString(payload, 'key'), relPath: payload.relPath,
        sourceHash: payload.sourceHash, targetHash: payload.targetHash }),

    'install:marketResolveConflict': (payload: InstallMarketResolveRequest): Promise<InstallScanResolveResult> =>
      context.install.marketResolveConflict({ key: requireString(payload, 'key'), choice: payload.choice,
        sourceHash: requireString(payload, 'sourceHash'), targetHash: requireString(payload, 'targetHash') }),

    'install:gitParse': (payload: InstallGitParseRequest): InstallDiscoveryResult => {
      const url = requireString(payload, 'url');
      return context.install.gitParse(url);
    },

    'install:localScan': (payload: InstallLocalScanRequest): InstallDiscoveryResult => {
      const dirPath = requireString(payload, 'dirPath');
      return context.install.localScan(dirPath);
    },

    'install:zipRead': (payload: InstallZipReadRequest): InstallDiscoveryResult => {
      const zipPath = requireString(payload, 'zipPath');
      return context.install.zipRead(zipPath);
    },

    'install:agentScan': () => context.install.agentScan(),

    'install:scanDiff': (payload: InstallScanDiffRequest): InstallScanDiffResult => {
      const channel = payload.channel ?? 'scan';
      if (channel !== 'local' && channel !== 'archive' && channel !== 'scan') throw new AgentError('BAD_REQUEST', '未知的差异来源');
      return context.install.scanDiff({ channel, key: requireString(payload, 'key'), relPath: payload.relPath,
        sourceHash: payload.sourceHash, targetHash: payload.targetHash });
    },

    'install:resolveScanConflict': (payload: InstallScanResolveRequest): Promise<InstallScanResolveResult> => {
      const channel = payload.channel ?? 'scan';
      if (channel !== 'local' && channel !== 'archive' && channel !== 'scan') throw new AgentError('BAD_REQUEST', '未知的差异来源');
      return context.install.resolveScanConflict({ channel, key: requireString(payload, 'key'), choice: payload.choice,
        sourceHash: requireString(payload, 'sourceHash'), targetHash: requireString(payload, 'targetHash') });
    },

    'install:import': (payload: InstallImportRequest): Promise<InstallImportResult> => {
      const channel = requireString(payload, 'channel');
      if (!Array.isArray(payload?.items)) {
        throw new AgentError('BAD_REQUEST', 'items 必须是数组');
      }
      const items: InstallImportRequest['items'] = [];
      for (const item of payload.items) {
        const key = (item as { key?: unknown } | null)?.key;
        if (typeof key !== 'string' || key.trim().length === 0) {
          throw new AgentError('BAD_REQUEST', '每一项都需要非空 key');
        }
        const name = (item as { name?: unknown } | null)?.name;
        if (channel === 'git' && name !== undefined) {
          if (typeof name !== 'string' || name.trim().length === 0) {
            throw new AgentError('BAD_REQUEST', '技能名称不能为空');
          }
          items.push({ key, name });
        } else {
          items.push({ key });
        }
      }
      return context.install.importSelected({
        channel: channel as InstallImportRequest['channel'],
        items,
      });
    },

    /* ────────────────────────── T14：备份与同步 ────────────────────────── */

    'sync:status': (): SyncStatusResult => context.sync.status(),

    'sync:connect': (payload: SyncConnectRequest): Promise<SyncStatusResult> =>
      context.sync.connect(requireString(payload, 'url')),

    'sync:commit': (payload: SyncCommitRequest | undefined): Promise<SyncCommitResult> => {
      const raw = (payload as { message?: unknown } | undefined)?.message;
      if (raw !== undefined && typeof raw !== 'string') {
        throw new AgentError('BAD_REQUEST', 'message 必须是字符串');
      }
      return context.sync.commit(raw as string | undefined);
    },

    'sync:pull': (): Promise<SyncPullResult> => context.sync.pull(),

    'sync:resolve': (payload: SyncResolveRequest): Promise<SyncResolveResult> => {
      const raw = (payload as { decisions?: unknown } | undefined)?.decisions;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new AgentError('BAD_REQUEST', 'decisions 必须是非空数组');
      }
      const decisions: SyncResolveRequest['decisions'] = [];
      for (const item of raw) {
        const record = (item ?? {}) as { conflictId?: unknown; choice?: unknown };
        if (typeof record.conflictId !== 'string' || record.conflictId.trim().length === 0) {
          throw new AgentError('BAD_REQUEST', '每个冲突选择都需要 conflictId');
        }
        if (record.choice !== 'local' && record.choice !== 'remote' && record.choice !== 'both') {
          throw new AgentError('BAD_REQUEST', `未知的冲突处理方式：${String(record.choice)}`);
        }
        decisions.push({ conflictId: record.conflictId.trim(), choice: record.choice });
      }
      return context.sync.resolve({ decisions });
    },

    'sync:continuePull': (): Promise<SyncPullResult> => context.sync.continuePull(),

    'sync:push': (): Promise<SyncPushResult> => context.sync.push(),

    'sync:history': (): SyncHistoryResult => context.sync.history(),

    'sync:versionDetail': (payload: SyncVersionDetailRequest): SyncVersionDetailResult =>
      context.sync.versionDetail(requireSha(payload, 'sha')),

    'sync:restore': (payload: SyncRestoreRequest): Promise<SyncRestoreResult> => {
      const sha = requireSha(payload, 'sha');
      // 恢复会改动库内容，必须经过确认弹层（ui.md「恢复此版本 → 确认后恢复」）
      if ((payload as { confirm?: unknown }).confirm !== true) {
        throw new AgentError('BAD_REQUEST', '恢复需要二次确认（confirm=true）');
      }
      return context.sync.restore(sha);
    },

    /* ---- CLI 接入指引（主页一次性卡片；内置源不入库清单，照 CLI 链路直走 sources） ---- */
    'cliSetup:status': (): CliSetupStatus => {
      // 源在 agents/skills/skills-studio，随 @skills-studio/agent 包构建进 dist/skills；
      // 本文件编译在 dist/ipc/，上两级即包根（开发 = backend/，生产 = app.asar 根）
      const sourceDir = path.resolve(
        __dirname,
        '..',
        '..',
        'node_modules',
        '@skills-studio',
        'agent',
        'dist',
        'skills',
        'skills-studio',
      );
      return {
        installed: cliSetupInstalled(context),
        sourceAvailable: fs.existsSync(path.join(sourceDir, 'SKILL.md')),
        sourceDir,
        card: context.state.get().cliSetupCard,
        agents: context.agents.list().map((a) => ({
          id: a.id,
          name: a.name,
          installed: a.installed,
          enabled: a.enabled,
        })),
      };
    },

    'cliSetup:install': async (payload: CliSetupInstallRequest): Promise<CliSetupInstallResult> => {
      const agentIds = stringArray(payload, 'agentIds');
      const sourceDir = path.resolve(
        __dirname,
        '..',
        '..',
        'node_modules',
        '@skills-studio',
        'agent',
        'dist',
        'skills',
        'skills-studio',
      );
      if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
        throw new AgentError('BAD_REQUEST', `内置 skills-studio 源缺失：${sourceDir}`);
      }

      // 入库（已在库 = skipped，不视为错误）
      const found = context.sources.discoverFromLocalDir(sourceDir);
      let imported = false;
      if (found.items.length > 0) {
        const res = await context.sources.importSkills(found.items);
        imported = res.results.some((r) => r.status === 'imported');
      }

      const row = cliSetupLibraryRow(context);
      if (!row) throw new AgentError('INTERNAL_ERROR', 'skills-studio 入库后未能定位到技能');

      // 只同步已启用且已安装的 Agent，其余如实回报（照 library:syncToAgents 的过滤口径）
      const targets: string[] = [];
      const ignoredAgents: CliSetupInstallResult['ignoredAgents'] = [];
      for (const agentId of agentIds) {
        const agent = context.agents.get(agentId);
        if (!agent) {
          ignoredAgents.push({ agentId, reason: 'Agent 不存在' });
          continue;
        }
        if (!agent.enabled) {
          ignoredAgents.push({ agentId, reason: `${agent.name} 已停用，不作为同步目标` });
          continue;
        }
        if (!agent.installed) {
          ignoredAgents.push({ agentId, reason: `未检测到 ${agent.name} 的 Skills 目录` });
          continue;
        }
        targets.push(agentId);
      }
      const result =
        targets.length > 0
          ? await context.deploy.syncToAgents([row.skillId], targets)
          : { items: [], summary: { deployed: 0, already: 0, conflict: 0, failed: 0, skipped: 0 } };

      context.state.setCliSetupCard('installed');
      return {
        skillId: row.skillId,
        dirName: row.dirName,
        imported,
        deployed: result.items.map((i) => ({ agentId: i.agentId, status: i.status })),
        ignoredAgents,
      };
    },

    'cliSetup:dismiss': () => {
      context.state.setCliSetupCard('dismissed');
      return { card: 'dismissed' as const };
    },

    /* ---- 应用自更新：无控制器（dev/uat/无更新配置）时返回 unsupported 快照 ---- */
    'updates:state': () => deps.updates?.getState() ?? unsupportedAppUpdateState(deps.version),
    'updates:check': () =>
      deps.updates?.checkNow() ?? Promise.resolve(unsupportedAppUpdateState(deps.version)),
    'updates:install': () => {
      if (deps.updates) deps.updates.installNow();
      return { closing: true };
    },
  };
}

/** skills-studio skill 是否已在中心库（按名称精确匹配）。 */
function cliSetupInstalled(context: AppContext): boolean {
  return cliSetupLibraryRow(context) != null;
}

function cliSetupLibraryRow(context: AppContext) {
  return context.catalog
    .list({ query: 'skills-studio' })
    .items.find((row) => row.name === 'skills-studio' && row.missingName !== true);
}
