/**
 * T06 通用对话基础设施的类型定义（prd.md M9 与 §6、tec.md §5.9/§6.2）。
 *
 * 边界：本任务只提供「供应商/模型配置 + Pi 会话 + 受限工具 + 事件流 + 持久会话」，
 * 创建/改进/评测的业务编排在 T07。
 */
/** Agent 可用的推理强度档位。 */
export type ThinkingLevel = 'low' | 'high' | 'max';

/** 运行状态机（tec.md §7.1「发起 → 事件流 → 结束」，支持中断）。 */
export type RunStatus = 'queued' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

/** 结构化错误码（tec.md §8 / prd.md §6.1）。 */
export type AgentErrorCode =
  | 'NO_MODEL_CONFIGURED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'TOOL_OUT_OF_SCOPE'
  | 'TASK_CANCELLED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY'
  | 'NO_ACTIVE_RUN'
  | 'INVALID_PROMPT'
  | 'INVALID_PROVIDER'
  | 'INVALID_MODEL'
  | 'INVALID_SCOPE'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_ACCESS_FAILED'
  | 'CREDENTIAL_INVALID_TARGET'
  | 'CREDENTIAL_INVALID_SECRET'
  | 'PI_LOAD_FAILED'
  | 'PI_SESSION_FAILED'
  | 'PI_RUN_FAILED'
  | 'PI_RUN_INTERRUPTED'
  // T07：创建/改进/评测工作流的业务错误
  | 'TARGET_INVALID'
  | 'NAME_CONFLICT'
  | 'SKILL_NOT_FOUND'
  | 'EVAL_REPORT_EMPTY'
  | 'EVAL_SAVE_FAILED'
  | 'WORKFLOW_RESOURCE_MISSING';

/** 旧会话可能存有 read-only；载入时统一迁移为授权目录内可读写。 */
export type SandboxToolPolicy = 'read-write' | 'read-only';

/**
 * 供应商预设（tec.md §7.3）：按厂商选，选完即带入 Endpoint 与协议。
 * 顺序即设置页下拉顺序，末两项是本地与自定义兜底。
 */
export type ProviderPreset =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'moonshotai'
  | 'zhipu'
  | 'qwen'
  | 'minimax'
  | 'siliconflow'
  | 'volcengine'
  | 'xai'
  | 'openrouter'
  | 'ollama'
  | 'openai-compatible';

/**
 * Pi 支持的 API 线协议（docs/models.md「Supported APIs」）。
 * 取值必须与 Pi 的 `api` 完全一致，多一个少一个都会在 registerProvider 时配置出错。
 */
export type ApiFormat =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

/** 预设定义（设置页数据契约，UI 在 T10 使用）。 */
export interface ProviderPresetDef {
  preset: ProviderPreset;
  label: string;
  apiFormat: ApiFormat;
  /** 预设默认 Endpoint；openai-compatible 必须由用户填写 */
  defaultBaseUrl: string;
  /** 是否必须配置 API Key（本地 Ollama 用占位键） */
  requiresApiKey: boolean;
  /**
   * 候选模型 ID（Pi 厂商目录抽取，见 provider-models.generated.ts）。
   * 只作「添加模型」的候选项提示，不写入配置；空数组 = 只能手填。
   */
  suggestedModels: readonly string[];
}

/** 单个供应商实例（本机配置，不进库/Git；只存凭据「是否已配置」状态）。 */
export interface ProviderRecord {
  /** 供应商 ID，同时作为 Pi provider id 与凭据管理器键名后缀 */
  id: string;
  preset: ProviderPreset;
  name: string;
  /** 协议类型（Pi 的 `api`，http/https 由 baseUrl 自带，不单独配置） */
  apiFormat: ApiFormat;
  baseUrl: string;
  /** 用户逐个添加的模型 ID（不自动发现） */
  models: string[];
  requiresApiKey: boolean;
  /** 只记录凭据是否存在，绝不存明文 */
  credentialConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 本机配置文件 DATA_DIR/agent-providers.json（schemaVersion=1）。 */
export interface ProviderConfigFile {
  schemaVersion: number;
  /** 单选唯一生效供应商（未配置任何供应商时为 null） */
  activeProviderId: string | null;
  /** 当前供应商下选用的模型（未选时取该供应商第一个模型） */
  activeModelId: string | null;
  /**
   * 当前模型使用的推理强度：与 activeModelId 成对记忆，作为新会话的初值。
   * 恒按 activeModelId 的能力归一；当前模型不支持推理时为 null。
   */
  activeThinkingLevel: ThinkingLevel | null;
  providers: ProviderRecord[];
}

/** 设置页读取的供应商视图。 */
export interface ProviderConfigView {
  schemaVersion: number;
  activeProviderId: string | null;
  activeModelId: string | null;
  /** 当前模型使用的推理强度（与 activeModelId 成对；新会话沿用） */
  activeThinkingLevel: ThinkingLevel | null;
  providers: ProviderRecord[];
  presets: readonly ProviderPresetDef[];
  /** 凭据后端标识（windows-credential-manager），仅用于诊断展示 */
  credentialBackend: string;
  /** 是否已选出可运行的 供应商+模型（false → NO_MODEL_CONFIGURED 引导） */
  runnable: boolean;
  /** 未配置时的可读引导文案 */
  guidance: string | null;
}

/** 一次运行可用的供应商+模型选择。 */
export interface ProviderSelection {
  providerId: string;
  preset: ProviderPreset;
  providerName: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  requiresApiKey: boolean;
  modelId: string;
}

/** token 用量（Pi assistant message.usage 归一化）。 */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** 美元成本（Pi 目录价；自定义端点通常为 0） */
  cost: number;
}

/** 会话内的工具调用摘要（脱敏：不存完整文件内容）。 */
export interface SessionToolCall {
  toolCallId: string;
  name: string;
  summary: string;
  isError: boolean;
  at: string;
}

/** 会话消息（应用层 UI 数据；模型上下文由 Pi 会话文件承载）。 */
export interface SessionMessage {
  messageId: string;
  /** 产生这条 assistant 消息的运行；旧会话可缺省。 */
  runId?: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  status: 'streaming' | 'complete' | 'aborted' | 'failed';
  toolCalls: SessionToolCall[];
  usage: AgentUsage | null;
  /** 失败时的结构化错误码 */
  errorCode?: AgentErrorCode;
}

/** 一次运行内同一文件的净改动，详情正文单独保存在 DATA_DIR。 */
export interface SessionFileChange {
  relPath: string;
  status: 'added' | 'modified' | 'removed';
  added: number | null;
  removed: number | null;
}

export interface SessionFileChangeSide {
  exists: boolean;
  content: string | null;
  reason: 'BINARY' | 'TOO_LARGE' | 'NOT_A_FILE' | null;
}

export interface SessionFileChangeSnapshot {
  before: SessionFileChangeSide;
  after: SessionFileChangeSide;
}

/** 生成文件引用（右侧文件区入口；重启后仍可打开）。 */
export interface SessionFileRef {
  /** 相对授权目录的路径（展示用，跨机可读） */
  relPath: string;
  /** 本机绝对路径（会话是本机数据，允许） */
  path: string;
  bytes: number | null;
  at: string;
}

/** 一次运行记录。 */
export interface SessionRun {
  runId: string;
  fileChanges?: SessionFileChange[];
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  providerId: string;
  modelId: string;
  error: { code: AgentErrorCode; detail: string } | null;
  usage: AgentUsage | null;
  durationMs: number | null;
}

/**
 * 持久会话记录（DATA_DIR/sessions/<sessionId>.json，原子写）。
 *
 * 与 Pi 的会话 JSONL（DATA_DIR/sessions/pi/*.jsonl，承载模型上下文）分工：
 * 本记录是应用层真相（状态、消息、文件入口、运行摘要），Pi 文件只用于 resume 时恢复上下文。
 */
export interface AgentSessionRecord {
  schemaVersion: number;
  sessionId: string;
  title: string;
  /** 会话工作目录：文件工具相对路径和命令的执行基准 */
  authorizedDir: string;
  /** 工具策略：当前会话统一为 read-write，保留字段以兼容旧记录。 */
  toolPolicy?: SandboxToolPolicy;
  /** T07：该会话属于哪个工作流（创建/改进/评测）；通用对话为 null */
  workflow?: 'create' | 'improve' | 'evaluate' | null;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  providerId: string | null;
  modelId: string | null;
  /**
   * 会话级推理强度（只对本会话生效）。
   * 建会话时按「上次为该模型选的档」写入（见 ProviderConfigFile.activeThinkingLevel）；
   * null / 缺省 = 按当前模型的最低可用档；不支持推理的模型忽略此字段。
   */
  thinkingLevel?: ThinkingLevel | null;
  /** 附加系统提示（T07 注入 Skill 流程约束用） */
  systemPrompt: string | null;
  /**
   * T15：已预填但尚未发送的提示词（快捷项/行菜单带入）。
   * 只用于输入框回填；发送后清空。重启后仍能恢复，避免预填内容丢失。
   */
  draftPrompt?: string | null;
  /** Pi 会话文件（相对 DATA_DIR；null 表示尚未建立） */
  piSessionFile: string | null;
  messages: SessionMessage[];
  files: SessionFileRef[];
  runs: SessionRun[];
  error: { code: AgentErrorCode; detail: string } | null;
  resumedAt: string | null;
}

/** 会话列表项（不含消息正文，供列表页）。 */
export interface AgentSessionSummary {
  sessionId: string;
  title: string;
  authorizedDir: string;
  status: RunStatus;
  providerId: string | null;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  fileCount: number;
  lastMessagePreview: string | null;
  error: { code: AgentErrorCode; detail: string } | null;
}

/** 会话详情（含消息、文件、运行与当前是否可运行）。 */
export interface AgentSessionDetail extends AgentSessionRecord {
  /** 供应商/模型是否已就绪（false 时开始运行会抛 NO_MODEL_CONFIGURED） */
  modelConfigured: boolean;
  /** 供 UI 提示的模型缺失原因 */
  modelGuidance: string | null;
  /** 本会话生效的推理强度（null = 当前模型不支持推理） */
  thinkingLevel: ThinkingLevel | null;
  /** 当前模型可选的推理强度（不支持推理时为空数组） */
  thinkingLevels: ThinkingLevel[];
  /** 当前是否有活动运行 */
  running: boolean;
  /** Pi 会话文件中的消息条数（resume 时恢复的模型上下文规模） */
  piMessageCount: number;
  /** 授权目录仍存在且 Pi 会话文件可读 → 可以继续对话 */
  resumable: boolean;
}

/** 统一事件流（主进程 → 渲染层，tec.md §7.1）。所有字符串在落盘前脱敏。 */
export type AgentEvent =
  | { type: 'status'; sessionId: string; runId: string | null; status: RunStatus; at: string }
  | {
      type: 'message';
      sessionId: string;
      /** 尚未进入运行的用户消息（appendUserMessage）为 null */
      runId: string | null;
      messageId: string;
      role: 'user' | 'assistant';
      /** assistant 文本增量 */
      delta?: string;
      /** 完整文本（final=true 时为权威值） */
      text?: string;
      final: boolean;
      at: string;
    }
  | {
      type: 'tool';
      sessionId: string;
      runId: string;
      toolCallId: string;
      phase: 'start' | 'end';
      name: string;
      summary: string;
      isError?: boolean;
      at: string;
    }
  | {
      type: 'usage';
      sessionId: string;
      runId: string;
      usage: AgentUsage;
      durationMs: number;
      at: string;
    }
  | { type: 'file'; sessionId: string; runId: string; relPath: string; bytes: number | null; at: string }
  | {
      type: 'error';
      sessionId: string;
      runId: string | null;
      code: AgentErrorCode;
      detail: string;
      retryable: boolean;
      at: string;
    }
  | { type: 'done'; sessionId: string; runId: string; status: RunStatus; at: string };

/** 事件监听器（渲染层 IPC / CLI 订阅）。 */
export type AgentEventListener = (event: AgentEvent) => void;

/** 一次运行的最终结果。 */
export interface RunResult {
  sessionId: string;
  runId: string;
  status: RunStatus;
  messageId: string | null;
  text: string;
  usage: AgentUsage | null;
  error: { code: AgentErrorCode; detail: string } | null;
  durationMs: number;
  /** 本次运行产生的文件引用 */
  files: SessionFileRef[];
}
