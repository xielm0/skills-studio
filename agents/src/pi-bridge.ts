/**
 * T06：Pi 内核桥（tec.md §2「Agent 内核 = @earendil-works/pi-coding-agent」）。
 *
 * 实测结论（1.4.0，MIT，Node ≥22.19）：
 *  - 包只提供 ESM 入口，本仓库编译为 CJS，故用**懒加载动态 import**（`await import(...)`）；
 *  - `ModelRuntime.create({ credentials, modelsPath: null })` + `registerProvider()` 可完全绕开
 *    磁盘上的 auth.json / models.json：凭据由 CredentialStore 在请求时提供（= Windows 凭据管理器）；
 *  - `createAgentSession({ cwd, tools, resourceLoader, sessionManager, ... })` 是唯一的会话入口；
 *    工具调用事件 `tool_call` 可返回 `{ block, reason, terminate }` 在**执行前**拦截；
 *  - 会话持久化由 `SessionManager.create(cwd, dir)` / `open(file, dir, cwd)` 负责（JSONL）；
 *  - 取消用 `session.abort()`，`prompt()` 正常 resolve，assistant 消息 stopReason='aborted'；
 *  - provider 错误不抛异常，而是 assistant 消息 stopReason='error' + errorMessage。
 *
 * 隔离纪律：ResourceLoader 关闭全部自动发现（skills/themes/prompts/context files/扩展文件），
 * 因此不会读本机真实 Agent 技能目录、~/.pi 或项目 AGENTS.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentSession,
  AgentSessionEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { Credential, CredentialStore } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import { AgentRunError } from './errors';
import { modelProfile } from './model-meta';
import type { AgentUsage, ProviderSelection } from './types';
import type { ProviderConfigService } from './providers';
import { registerSecret } from './redact';
import { ToolScopeGuard, type ScopeCheck, type ScopeViolation } from './tool-scope';

type PiModule = typeof import('@earendil-works/pi-coding-agent', { with: { 'resolution-mode': 'import' } });
type PiRuntime = Awaited<ReturnType<PiModule['ModelRuntime']['create']>>;

let piPromise: Promise<PiModule> | null = null;

/** 懒加载 Pi（ESM-only）。失败归一为 PI_LOAD_FAILED，便于 UI 明确提示而不是白屏。 */
export function loadPi(): Promise<PiModule> {
  if (!piPromise) {
    piPromise = import('@earendil-works/pi-coding-agent').catch((err: unknown) => {
      piPromise = null;
      const message = err instanceof Error ? err.message : String(err);
      throw new AgentRunError('PI_LOAD_FAILED', `Agent 内核加载失败：${message.slice(0, 300)}`);
    });
  }
  return piPromise;
}

export interface PiBridgeOptions {
  /** Pi 全局配置目录（DATA_DIR/pi-agent；不读用户 ~/.pi） */
  agentDir: string;
  /** Pi 会话目录（DATA_DIR/sessions/pi） */
  sessionsDir: string;
  /** 供应商配置服务（提供 provider/模型/凭据） */
  providers: ProviderConfigService;
}

export interface PiSessionOptions {
  /** 授权目录：同时是 Pi 的 cwd（工具相对路径基准） */
  authorizedDir: string;
  providerId: string;
  modelId: string;
  /**
   * 推理强度（§model-meta）：未指定 = off，不发送任何推理参数。
   * 具体档位是否生效由模型的 thinkingLevelMap 决定，Pi 会自行裁剪。
   */
  thinkingLevel?: 'off' | 'low' | 'high' | 'max';
  /** 会话系统提示（应用上下文 + T07 注入的技能流程约束） */
  systemPrompt: string;
  /** 既有 Pi 会话文件（resume）；null/不存在则新建 */
  sessionFile: string | null;
  /** 授权目录守卫 */
  scope: ToolScopeGuard;
  /** 越界回调（运行层据此中止并落 TOOL_OUT_OF_SCOPE） */
  onViolation: (violation: ScopeViolation) => void;
  /** 合法工具调用回调（事件流用） */
  onToolAllowed?: (check: ScopeCheck) => void;
  /** 全局取消信号（cancelRun 时 abort） */
  signal?: AbortSignal;
}

export interface PiSessionHandle {
  session: AgentSession;
  /** Pi 会话文件绝对路径（新建时已存在） */
  sessionFile: string | null;
  /** 是否复用了既有会话（resume） */
  resumed: boolean;
  /** 是否已绑定事件监听 */
  dispose(): void;
}

export class PiBridge {
  private readonly options: PiBridgeOptions;
  private runtime: PiRuntime | null = null;
  private runtimeSignature = '';

  constructor(options: PiBridgeOptions) {
    this.options = options;
    fs.mkdirSync(this.options.agentDir, { recursive: true });
    fs.mkdirSync(this.options.sessionsDir, { recursive: true });
  }

  /** 当前可运行供应商的签名（配置变化时重建 ModelRuntime）。 */
  private signature(selections: ProviderSelection[]): string {
    const map = new Map<
      string,
      { apiFormat: string; baseUrl: string; preset: string; models: string[]; name: string }
    >();
    for (const s of selections) {
      const entry = map.get(s.providerId) ?? {
        apiFormat: s.apiFormat,
        baseUrl: s.baseUrl,
        preset: s.preset,
        models: [],
        name: s.providerName,
      };
      if (!entry.models.includes(s.modelId)) entry.models.push(s.modelId);
      map.set(s.providerId, entry);
    }
    return JSON.stringify([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  /**
   * 构建（或复用）ModelRuntime。
   * 凭据由自定义 CredentialStore 在每次请求时从 Windows 凭据管理器读取，
   * 因此磁盘上不存在 auth.json（Pi 也不会写它）。
   */
  async ensureRuntime(): Promise<PiRuntime> {
    const pi = await loadPi();
    const selections = this.options.providers.listForRuntime();
    const signature = this.signature(selections);
    if (this.runtime && signature === this.runtimeSignature) return this.runtime;

    const credentialStore = this.createCredentialStore(selections);
    let runtime: PiRuntime;
    try {
      runtime = await pi.ModelRuntime.create({
        credentials: credentialStore,
        modelsPath: null,
        refreshOnCreate: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AgentRunError('PI_LOAD_FAILED', `模型运行时初始化失败：${message.slice(0, 300)}`);
    }

    const grouped = new Map<string, ProviderSelection[]>();
    for (const selection of selections) {
      const list = grouped.get(selection.providerId) ?? [];
      list.push(selection);
      grouped.set(selection.providerId, list);
    }
    for (const [providerId, list] of grouped) {
      const head = list[0];
      runtime.registerProvider(providerId, {
        name: head.providerName,
        baseUrl: head.baseUrl,
        api: head.apiFormat as never,
        models: list.map((s) => {
          // 能力来自 Pi 厂商目录（见 model-meta.ts）；未收录模型走保守默认值。
          const profile = modelProfile(s.preset, s.modelId);
          return {
            type: 'chat' as const,
            id: s.modelId,
            name: s.modelId,
            reasoning: profile.thinkingEnabled,
            ...(profile.thinkingEnabled ? { thinkingLevelMap: profile.thinkingLevelMap } : {}),
            input: ['text' as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: profile.contextWindow,
            maxTokens: profile.maxTokens,
          };
        }),
      });
    }

    this.runtime = runtime;
    this.runtimeSignature = signature;
    return runtime;
  }

  /** 把 Windows 凭据管理器包装成 Pi 的 CredentialStore。 */
  private createCredentialStore(selections: ProviderSelection[]): CredentialStore {
    const providers = this.options.providers;
    const keyless = new Set(selections.filter((s) => !s.requiresApiKey).map((s) => s.providerId));
    const known = new Set(selections.map((s) => s.providerId));
    const readKey = (providerId: string): Credential | undefined => {
      if (keyless.has(providerId)) return { type: 'api_key', key: 'ollama' };
      if (!known.has(providerId)) return undefined;
      const key = providers.readApiKey(providerId);
      if (!key) return undefined;
      registerSecret(key);
      return { type: 'api_key', key };
    };
    return {
      read: async (providerId: string) => readKey(providerId),
      list: async () => {
        const out: { providerId: string; type: 'api_key' }[] = [];
        for (const providerId of known) {
          if (readKey(providerId)) out.push({ providerId, type: 'api_key' });
        }
        return out;
      },
      modify: async (providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) => {
        const current = readKey(providerId);
        const next = await fn(current);
        if (next && next.type === 'api_key' && next.key) {
          providers.setApiKey(providerId, next.key);
        }
        return next;
      },
      delete: async (providerId: string) => {
        providers.clearApiKey(providerId);
      },
    };
  }

  /** 创建/恢复会话并绑定受控工具边界。 */
  async createSession(options: PiSessionOptions): Promise<PiSessionHandle> {
    const pi = await loadPi();
    const runtime = await this.ensureRuntime();
    const model = runtime.getModel(options.providerId, options.modelId);
    if (!model) {
      throw new AgentRunError(
        'INVALID_MODEL',
        `Pi 未能解析模型 ${options.providerId}/${options.modelId}（请检查供应商 Endpoint 与模型 ID）`,
      );
    }

    const settingsManager = pi.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });

    const resumed = Boolean(options.sessionFile && fs.existsSync(options.sessionFile));
    const sessionManager = resumed
      ? pi.SessionManager.open(options.sessionFile as string, this.options.sessionsDir, options.authorizedDir)
      : pi.SessionManager.create(options.authorizedDir, this.options.sessionsDir);

    const scope = options.scope;
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: options.authorizedDir,
      agentDir: this.options.agentDir,
      settingsManager,
      // 隔离：不做任何自动发现（否则会读 ~/.pi、项目 AGENTS.md、本机 Agent 技能目录）
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: options.systemPrompt,
      extensionFactories: [
        (api) => {
          api.on('tool_call', async (event): Promise<ToolCallEventResult | undefined> => {
            const check = scope.check(event.toolName, event.input as Record<string, unknown>);
            if (!check.ok) {
              options.onViolation(check);
              return {
                block: true,
                reason: `TOOL_OUT_OF_SCOPE: ${check.reason}`,
                terminate: true,
              };
            }
            options.onToolAllowed?.(check);
            return undefined;
          });
        },
      ],
    });
    await resourceLoader.reload();

    const { session } = await pi.createAgentSession({
      cwd: options.authorizedDir,
      agentDir: this.options.agentDir,
      model,
      modelRuntime: runtime,
      thinkingLevel: options.thinkingLevel ?? 'off',
      // 全部 Pi 内置工具可用；工作目录仅决定相对路径基准。
      tools: [...scope.allowedTools],
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    let disposed = false;
    return {
      session,
      sessionFile: session.sessionFile ?? null,
      resumed,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        session.dispose();
      },
    };
  }
}

/** 从 Pi assistant 消息取纯文本（忽略 thinking / toolCall 内容块）。 */
export function assistantText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

/** 归一 Pi 的 usage（字段缺失按 0）。 */
export function normalizeUsage(usage: unknown): AgentUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const num = (key: string): number => (typeof u[key] === 'number' ? (u[key] as number) : 0);
  const cost = (u.cost && typeof u.cost === 'object' ? (u.cost as Record<string, unknown>).total : 0) ?? 0;
  return {
    input: num('input'),
    output: num('output'),
    cacheRead: num('cacheRead'),
    cacheWrite: num('cacheWrite'),
    totalTokens: num('totalTokens') || num('input') + num('output') + num('cacheRead') + num('cacheWrite'),
    cost: typeof cost === 'number' ? cost : 0,
  };
}

/** 读取 Pi 会话文件的消息条数（resume 证据），损坏行跳过。 */
export function countPiMessages(file: string): number {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string };
      if (entry.type === 'message') count += 1;
    } catch {
      /* 跳过损坏行 */
    }
  }
  return count;
}
export type { AgentSession, AgentSessionEvent };
