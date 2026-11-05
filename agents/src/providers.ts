/**
 * T06：模型供应商与本机配置（tec.md §5.9/§6.2/§7.3）。
 *
 * 真相 = DATA_DIR/agent-providers.json（**本机设置，不进库、不进 Git、不进备份**）。
 *  - 供应商：平台预设（清单唯一真相 = PROVIDER_PRESETS），单选唯一生效；
 *  - 模型：一个供应商可挂多个模型 ID；候选清单来自 Pi 厂商目录，仅作下拉提示，不自动写入；
 *  - 凭据：API Key 只进 Windows 凭据管理器，配置文件只保留 `credentialConfigured: true/false`。
 *
 * 隔离纪律：本模块不主动访问网络、不读用户真实技能目录；测试用 credentialPrefix
 * (`skills-platform-test/`) 与 tests/runtime 下的 dataDir。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CredentialBackend } from './win-credential';
import { CredentialError, WindowsCredentialStore } from './win-credential';
import { AgentRunError } from './errors';
import { modelProfile, normalizeThinkingLevel, type ModelProfile, type ThinkingLevel } from './model-meta';
import { SUGGESTED_MODELS } from './provider-models.generated';
import { registerSecret } from './redact';
import type {
  ApiFormat,
  ProviderConfigFile,
  ProviderConfigView,
  ProviderPreset,
  ProviderPresetDef,
  ProviderRecord,
  ProviderSelection,
} from './types';

export const PROVIDER_CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_CREDENTIAL_PREFIX = 'skills-platform/';
/** 模型 ID 与供应商 ID 的保守允许集（避免注入到 Pi provider id / 凭据键名） */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * 平台预设：选厂商即带入 baseUrl 与协议，用户只需再填 API Key。
 *
 * 数据来源：Pi 内置厂商目录 `pi-ai/dist/providers/data/<provider>.json`（标注「Pi 目录」的项），
 * Pi 未收录的国内厂商按各家官方 OpenAI 兼容端点补充。协议取值仍严格等于 Pi 的 `api`。
 */
const PRESET_DEFS: readonly Omit<ProviderPresetDef, 'suggestedModels'>[] = [
  {
    preset: 'openai',
    label: 'OpenAI',
    // 与 Pi 内置目录一致：OpenAI 官方走 Responses API（`pi-ai/dist/providers/data/openai.json`）
    apiFormat: 'openai-responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
  },
  {
    preset: 'anthropic',
    label: 'Anthropic',
    apiFormat: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
  },
  {
    preset: 'gemini',
    label: 'Google Gemini',
    apiFormat: 'google-generative-ai',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresApiKey: true,
  },
  {
    preset: 'deepseek',
    label: 'DeepSeek',
    apiFormat: 'openai-completions',
    defaultBaseUrl: 'https://api.deepseek.com',
    requiresApiKey: true,
  },
  {
    preset: 'moonshotai',
    label: 'Kimi（Moonshot）',
    apiFormat: 'openai-completions',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    requiresApiKey: true,
  },
  {
    preset: 'zhipu',
    label: '智谱 GLM',
    apiFormat: 'openai-completions',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    requiresApiKey: true,
  },
  {
    preset: 'qwen',
    label: '通义千问（百炼）',
    apiFormat: 'openai-completions',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    requiresApiKey: true,
  },
  {
    preset: 'minimax',
    label: 'MiniMax',
    apiFormat: 'anthropic-messages',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
    requiresApiKey: true,
  },
  {
    preset: 'siliconflow',
    label: '硅基流动',
    apiFormat: 'openai-completions',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    requiresApiKey: true,
  },
  {
    preset: 'volcengine',
    label: '火山方舟（豆包）',
    apiFormat: 'openai-completions',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    requiresApiKey: true,
  },
  {
    preset: 'xai',
    label: 'xAI Grok',
    apiFormat: 'openai-responses',
    defaultBaseUrl: 'https://api.x.ai/v1',
    requiresApiKey: true,
  },
  {
    preset: 'openrouter',
    label: 'OpenRouter',
    apiFormat: 'openai-completions',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
  },
  {
    preset: 'ollama',
    label: '本地 Ollama',
    apiFormat: 'openai-completions',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    requiresApiKey: false,
  },
  {
    preset: 'openai-compatible',
    label: '自定义（OpenAI 兼容）',
    apiFormat: 'openai-completions',
    defaultBaseUrl: '',
    requiresApiKey: true,
  },
];

/** 预设 + 候选模型清单（候选只供设置页下拉提示，不进用户配置）。 */
export const PROVIDER_PRESETS: readonly ProviderPresetDef[] = PRESET_DEFS.map((preset) => ({
  ...preset,
  suggestedModels: SUGGESTED_MODELS[preset.preset] ?? [],
}));

export function findPreset(preset: string): ProviderPresetDef | undefined {
  return PROVIDER_PRESETS.find((p) => p.preset === preset);
}

/**
 * 凭据仓库：把「供应商 ID」映射到 Windows 凭据管理器键名。
 * 键名规范：`<prefix>provider/<providerId>`（生产 prefix = skills-platform/）。
 */
export class CredentialVault {
  private readonly prefix: string;
  private readonly backend: CredentialBackend;

  constructor(backend: CredentialBackend, prefix: string = DEFAULT_CREDENTIAL_PREFIX) {
    this.backend = backend;
    this.prefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  }

  get backendKind(): string {
    return this.backend.backend;
  }

  /** 供应商对应的凭据键名（不含密钥，可安全写日志） */
  target(providerId: string): string {
    if (!ID_PATTERN.test(providerId)) {
      throw new AgentRunError('INVALID_PROVIDER', `供应商 ID 非法：${providerId}`);
    }
    return `${this.prefix}provider/${providerId}`;
  }

  set(providerId: string, secret: string): void {
    if (secret.trim().length < 6) {
      throw new AgentRunError('CREDENTIAL_INVALID_SECRET', 'API Key 过短（至少 6 个字符）');
    }
    this.backend.set(this.target(providerId), secret.trim());
    registerSecret(secret.trim());
  }

  get(providerId: string): string | null {
    const value = this.backend.get(this.target(providerId));
    if (value) registerSecret(value);
    return value;
  }

  has(providerId: string): boolean {
    try {
      return this.get(providerId) !== null;
    } catch {
      return false;
    }
  }

  delete(providerId: string): 'deleted' | 'missing' {
    return this.backend.delete(this.target(providerId));
  }
}

/** 模型 ID 归一化校验（新增供应商与逐个添加共用一套规则）。 */
function normalizeModelId(raw: string): string {
  const model = String(raw ?? '').trim();
  if (!model) throw new AgentRunError('INVALID_MODEL', '模型 ID 不能为空');
  if (model.length > 200) throw new AgentRunError('INVALID_MODEL', '模型 ID 过长（上限 200 字符）');
  if (/[\s"'`]/.test(model)) throw new AgentRunError('INVALID_MODEL', `模型 ID 不能包含空白或引号：${model}`);
  return model;
}

/** 批量模型 ID：去空、去重（保持输入顺序）。 */
function normalizeModelList(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const model = normalizeModelId(raw);
    if (!out.includes(model)) out.push(model);
  }
  return out;
}

export interface ProviderConfigServiceOptions {
  /** 本机数据目录（配置写 <dataDir>/agent-providers.json） */
  dataDir: string;
  /** 凭据后端（默认 Windows 凭据管理器；测试可复用真实后端 + 测试前缀） */
  credentialBackend?: CredentialBackend;
  /** 凭据键名前缀（生产 skills-platform/；测试 skills-platform-test/） */
  credentialPrefix?: string;
  /** 覆盖配置文件路径（默认 <dataDir>/agent-providers.json） */
  configFile?: string;
}

export class ProviderConfigService {
  readonly file: string;
  private readonly vaultLazy: () => CredentialVault;

  constructor(options: ProviderConfigServiceOptions) {
    this.file = options.configFile ?? path.join(options.dataDir, 'agent-providers.json');
    let vault: CredentialVault | null = null;
    const prefix = options.credentialPrefix ?? DEFAULT_CREDENTIAL_PREFIX;
    this.vaultLazy = () => {
      if (vault) return vault;
      try {
        const backend = options.credentialBackend ?? new WindowsCredentialStore();
        vault = new CredentialVault(backend, prefix);
        return vault;
      } catch (err) {
        if (err instanceof CredentialError) {
          throw new AgentRunError(err.code === 'CREDENTIAL_UNAVAILABLE' ? 'CREDENTIAL_UNAVAILABLE' : 'CREDENTIAL_ACCESS_FAILED', err.detail);
        }
        throw err;
      }
    };
    // 预热（失败延迟到真正访问凭据时再报错，避免无凭据环境直接无法读配置）
  }

  /** 凭据仓库（首次访问时构造；平台不支持时抛 CREDENTIAL_UNAVAILABLE）。 */
  get vault(): CredentialVault {
    return this.vaultLazy();
  }

  readConfig(): ProviderConfigFile {
    return readProviderConfig(this.file);
  }

  /** 设置页数据契约。 */
  view(): ProviderConfigView {
    const config = this.readConfig();
    let credentialBackend = 'windows-credential-manager';
    try {
      credentialBackend = this.vault.backendKind;
    } catch {
      credentialBackend = 'unavailable';
    }
    let guidance: string | null = null;
    let runnable = false;
    const active = config.providers.find((p) => p.id === config.activeProviderId);
    if (!active) {
      guidance = '尚未配置模型供应商：请在设置中添加供应商、模型 ID 与 API Key 后再开始对话。';
    } else if (active.models.length === 0) {
      guidance = `供应商「${active.name}」还没有添加模型 ID，请先添加一个模型。`;
    } else if (active.requiresApiKey && !active.credentialConfigured) {
      guidance = `供应商「${active.name}」尚未保存 API Key，请在设置中填写。`;
    } else {
      runnable = true;
    }
    return {
      schemaVersion: config.schemaVersion,
      activeProviderId: config.activeProviderId,
      activeModelId: config.activeModelId,
      activeThinkingLevel: config.activeThinkingLevel,
      providers: config.providers,
      presets: PROVIDER_PRESETS,
      credentialBackend,
      runnable,
      guidance,
    };
  }

  /** 新增或更新一个预设供应商（同一预设只保留一个实例）。 */
  addProvider(input: {
    preset: ProviderPreset | string;
    name?: string;
    baseUrl?: string;
    apiFormat?: ApiFormat | string;
    /** 创建时一并写入的模型 ID；更新时给值即替换清单（不给则保留） */
    models?: readonly string[];
  }): ProviderRecord {
    const preset = findPreset(String(input.preset));
    if (!preset) throw new AgentRunError('INVALID_PROVIDER', `未知供应商预设：${input.preset}`);

    const baseUrlRaw = (input.baseUrl ?? preset.defaultBaseUrl).trim();
    if (!baseUrlRaw) {
      throw new AgentRunError('INVALID_PROVIDER', '供应商 Endpoint 不能为空');
    }
    const baseUrl = normalizeBaseUrl(baseUrlRaw);
    const apiFormat = normalizeApiFormat(input.apiFormat ?? preset.apiFormat);
    const name = (input.name ?? preset.label).trim() || preset.label;
    // 先校验模型，避免校验失败时配置已被改写
    const incomingModels = input.models ? normalizeModelList(input.models) : null;

    const config = this.readConfig();
    const existing = config.providers.find((p) => p.id === preset.preset);
    const now = new Date().toISOString();
    let record: ProviderRecord;
    if (existing) {
      record = {
        ...existing,
        name,
        baseUrl,
        apiFormat,
        requiresApiKey: preset.requiresApiKey,
        models: incomingModels ?? existing.models,
        updatedAt: now,
      };
      // 原地替换数组元素：只改 record 不改数组时，writeConfig 写回的还是旧对象，编辑不生效
      config.providers.splice(config.providers.indexOf(existing), 1, record);
    } else {
      record = {
        id: preset.preset,
        preset: preset.preset,
        name,
        apiFormat,
        baseUrl,
        models: incomingModels ?? [],
        requiresApiKey: preset.requiresApiKey,
        credentialConfigured: false,
        createdAt: now,
        updatedAt: now,
      };
      config.providers.push(record);
    }
    if (!config.activeProviderId) {
      config.activeProviderId = record.id;
      config.activeModelId = record.models[0] ?? null;
    } else if (config.activeProviderId === record.id) {
      // 模型清单被替换后生效模型必须仍在清单内，否则回退到第一个
      if (!config.activeModelId || !record.models.includes(config.activeModelId)) {
        config.activeModelId = record.models[0] ?? null;
      }
    }
    this.writeConfig(config);
    return record;
  }

  /** 删除供应商（同时清除其凭据） */
  removeProvider(providerId: string): void {
    const config = this.readConfig();
    const idx = config.providers.findIndex((p) => p.id === providerId);
    if (idx < 0) throw new AgentRunError('INVALID_PROVIDER', `供应商不存在：${providerId}`);
    config.providers.splice(idx, 1);
    if (config.activeProviderId === providerId) {
      config.activeProviderId = config.providers[0]?.id ?? null;
      config.activeModelId = config.providers[0]?.models[0] ?? null;
    }
    try {
      this.vault.delete(providerId);
    } catch {
      // 凭据删不掉不阻塞配置移除（下一次写入会覆盖）；但要让调用方知道由 clearApiKey 单独报错
    }
    this.writeConfig(config);
  }

  /** 单选唯一生效供应商（null 表示清空选择）。 */
  setActiveProvider(providerId: string | null): void {
    const config = this.readConfig();
    if (providerId === null) {
      config.activeProviderId = null;
      config.activeModelId = null;
      this.writeConfig(config);
      return;
    }
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) throw new AgentRunError('INVALID_PROVIDER', `供应商不存在：${providerId}`);
    config.activeProviderId = provider.id;
    config.activeModelId = provider.models[0] ?? null;
    this.writeConfig(config);
  }

  /** 用户手动添加模型 ID（候选清单见 PROVIDER_PRESETS.suggestedModels，不自动写入）。 */
  addModel(providerId: string, modelId: string): ProviderRecord {
    const model = normalizeModelId(modelId);

    const config = this.readConfig();
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) throw new AgentRunError('INVALID_PROVIDER', `供应商不存在：${providerId}`);
    if (!provider.models.includes(model)) provider.models.push(model);
    provider.updatedAt = new Date().toISOString();
    if (config.activeProviderId === provider.id && !config.activeModelId) {
      config.activeModelId = model;
    }
    this.writeConfig(config);
    return provider;
  }

  removeModel(providerId: string, modelId: string): ProviderRecord {
    const config = this.readConfig();
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) throw new AgentRunError('INVALID_PROVIDER', `供应商不存在：${providerId}`);
    provider.models = provider.models.filter((m) => m !== modelId);
    provider.updatedAt = new Date().toISOString();
    if (config.activeProviderId === provider.id && config.activeModelId === modelId) {
      config.activeModelId = provider.models[0] ?? null;
    }
    this.writeConfig(config);
    return provider;
  }

  /** 选定当前模型（必须在已添加列表内）。 */
  setActiveModel(modelId: string): void {
    const config = this.readConfig();
    const provider = config.providers.find((p) => p.id === config.activeProviderId);
    if (!provider) throw new AgentRunError('NO_MODEL_CONFIGURED', '尚未选择供应商');
    if (!provider.models.includes(modelId)) {
      throw new AgentRunError('INVALID_MODEL', `模型未添加到当前供应商：${modelId}`);
    }
    config.activeModelId = modelId;
    this.writeConfig(config);
  }

  /**
   * 记住当前模型的推理强度（与 activeModelId 成对，作为新会话的初值）。
   * 档位跟模型绑定：只收当前模型支持的档，非法档直接报错，不做静默改写。
   */
  setActiveThinkingLevel(level: ThinkingLevel): void {
    const config = this.readConfig();
    const profile = activeProfileOf(config);
    if (!profile) throw new AgentRunError('NO_MODEL_CONFIGURED', '尚未选择模型，无法设置推理强度');
    if (!profile.thinkingLevels.includes(level)) {
      const available = profile.thinkingLevels.length > 0 ? profile.thinkingLevels.join(' / ') : '无';
      throw new AgentRunError(
        'INVALID_MODEL',
        `模型 ${config.activeModelId} 不支持推理强度 ${level}（可选：${available}）`,
      );
    }
    config.activeThinkingLevel = level;
    this.writeConfig(config);
  }

  /** 新会话的推理强度初值（与 activeModelId 成对记忆；未配置时为 null）。 */
  getActiveThinkingLevel(): ThinkingLevel | null {
    return this.readConfig().activeThinkingLevel;
  }

  /**
   * 保存 API Key：写入 Windows 凭据管理器并做一次真实回读校验，
   * 明文不落配置文件；配置里只写 credentialConfigured=true。
   */
  setApiKey(providerId: string, apiKey: string): void {
    const config = this.readConfig();
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) throw new AgentRunError('INVALID_PROVIDER', `供应商不存在：${providerId}`);
    const key = String(apiKey ?? '').trim();
    if (!key) throw new AgentRunError('CREDENTIAL_INVALID_SECRET', 'API Key 不能为空');
    try {
      this.vault.set(providerId, key);
      const back = this.vault.get(providerId);
      if (back !== key) {
        throw new AgentRunError('CREDENTIAL_ACCESS_FAILED', '凭据写入后回读不一致（Windows 凭据管理器未生效）');
      }
    } catch (err) {
      if (err instanceof CredentialError) {
        throw new AgentRunError('CREDENTIAL_ACCESS_FAILED', err.detail);
      }
      throw err;
    }
    provider.credentialConfigured = true;
    provider.updatedAt = new Date().toISOString();
    this.writeConfig(config);
  }

  /** 清除 API Key（同时把状态置回 false） */
  clearApiKey(providerId: string): void {
    const config = this.readConfig();
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) throw new AgentRunError('INVALID_PROVIDER', `供应商不存在：${providerId}`);
    try {
      this.vault.delete(providerId);
    } catch (err) {
      if (err instanceof CredentialError) {
        throw new AgentRunError('CREDENTIAL_ACCESS_FAILED', err.detail);
      }
      throw err;
    }
    provider.credentialConfigured = false;
    provider.updatedAt = new Date().toISOString();
    this.writeConfig(config);
  }

  /** 真实回读凭据（不返回明文，只返回是否存在与长度是否一致）。 */
  verifyCredential(providerId: string): { present: boolean; matchesStoredState: boolean } {
    const config = this.readConfig();
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) throw new AgentRunError('INVALID_PROVIDER', `供应商不存在：${providerId}`);
    const present = this.vault.has(providerId);
    return { present, matchesStoredState: present === provider.credentialConfigured };
  }

  /** 取本次运行要用的 供应商 + 模型；不可运行时抛 NO_MODEL_CONFIGURED 引导。 */
  getSelection(modelId?: string): ProviderSelection {
    const config = this.readConfig();
    const provider = config.providers.find((p) => p.id === config.activeProviderId);
    if (!provider) {
      throw new AgentRunError(
        'NO_MODEL_CONFIGURED',
        '尚未配置模型供应商：请在设置中添加供应商、模型 ID 与 API Key 后再开始对话。',
      );
    }
    if (provider.models.length === 0) {
      throw new AgentRunError(
        'NO_MODEL_CONFIGURED',
        `供应商「${provider.name}」还没有添加模型 ID，请在设置中添加模型后再开始对话。`,
      );
    }
    const chosen = modelId ?? config.activeModelId ?? provider.models[0];
    if (!provider.models.includes(chosen)) {
      throw new AgentRunError('INVALID_MODEL', `模型未添加到供应商「${provider.name}」：${chosen}`);
    }
    if (provider.requiresApiKey && !provider.credentialConfigured) {
      throw new AgentRunError(
        'NO_MODEL_CONFIGURED',
        `供应商「${provider.name}」尚未保存 API Key，请在设置中填写后再开始对话。`,
      );
    }
    return {
      providerId: provider.id,
      preset: provider.preset,
      providerName: provider.name,
      apiFormat: provider.apiFormat,
      baseUrl: provider.baseUrl,
      requiresApiKey: provider.requiresApiKey,
      modelId: chosen,
    };
  }

  /** 当前所有可用于 Pi 的供应商（供 ModelRuntime 注册） */
  listForRuntime(): ProviderSelection[] {
    const config = this.readConfig();
    const out: ProviderSelection[] = [];
    for (const provider of config.providers) {
      for (const modelId of provider.models) {
        out.push({
          providerId: provider.id,
          preset: provider.preset,
          providerName: provider.name,
          apiFormat: provider.apiFormat,
          baseUrl: provider.baseUrl,
          requiresApiKey: provider.requiresApiKey,
          modelId,
        });
      }
    }
    return out;
  }

  /** 读取明文 Key（仅用于登记脱敏与 Pi 请求，不写盘、不返回给渲染层） */
  readApiKey(providerId: string): string | null {
    return this.vault.get(providerId);
  }

  private writeConfig(config: ProviderConfigFile): void {
    const active = config.providers.find((p) => p.id === config.activeProviderId);
    const payload: ProviderConfigFile = {
      schemaVersion: PROVIDER_CONFIG_SCHEMA_VERSION,
      activeProviderId: config.activeProviderId,
      activeModelId: config.activeModelId,
      // 档位与模型成对：写盘前按当前模型能力归一，落盘的 pair 永远自洽
      activeThinkingLevel: pairThinkingLevel(active, config.activeModelId, config.activeThinkingLevel),
      providers: config.providers,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AgentRunError('INVALID_PROVIDER', `供应商 Endpoint 不是合法 URL：${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AgentRunError('INVALID_PROVIDER', `供应商 Endpoint 只支持 http/https：${input}`);
  }
  return input.replace(/\/+$/, '');
}

/**
 * 协议类型：严格等于 Pi 的 `api` 取值（docs/models.md「Supported APIs」）。
 * 这里多收或少收都会让 registerProvider 拿到 Pi 不认识的 api。
 */
function normalizeApiFormat(input: ApiFormat | string): ApiFormat {
  const allowed: ApiFormat[] = [
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai',
  ];
  if (!allowed.includes(input as ApiFormat)) {
    throw new AgentRunError('INVALID_PROVIDER', `不支持的 API 格式：${input}`);
  }
  return input as ApiFormat;
}

/** 容错读取配置文件：损坏时按空配置重建（本机设置不是库真相，丢配置不影响用户数据）。 */
export function readProviderConfig(file: string): ProviderConfigFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return emptyConfig();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProviderConfigFile>;
    const providers: ProviderRecord[] = [];
    for (const p of Array.isArray(parsed.providers) ? parsed.providers : []) {
      if (!p || typeof p.id !== 'string' || typeof p.baseUrl !== 'string') continue;
      const preset = findPreset(p.preset);
      providers.push({
        id: p.id,
        preset: (preset?.preset ?? p.preset) as ProviderPreset,
        name: typeof p.name === 'string' && p.name ? p.name : (preset?.label ?? p.id),
        apiFormat: (typeof p.apiFormat === 'string' ? p.apiFormat : preset?.apiFormat ?? 'openai-completions') as ApiFormat,
        baseUrl: p.baseUrl,
        models: Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === 'string') : [],
        requiresApiKey: typeof p.requiresApiKey === 'boolean' ? p.requiresApiKey : (preset?.requiresApiKey ?? true),
        // 只信 boolean；即使旧文件里误存了别的字段也不会被当成密钥
        credentialConfigured: p.credentialConfigured === true,
        createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
        updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
      });
    }
    const activeProviderId =
      typeof parsed.activeProviderId === 'string' && providers.some((p) => p.id === parsed.activeProviderId)
        ? parsed.activeProviderId
        : null;
    const activeProvider = providers.find((p) => p.id === activeProviderId);
    const activeModelId =
      activeProvider && typeof parsed.activeModelId === 'string' && activeProvider.models.includes(parsed.activeModelId)
        ? parsed.activeModelId
        : (activeProvider?.models[0] ?? null);
    return {
      schemaVersion: PROVIDER_CONFIG_SCHEMA_VERSION,
      activeProviderId,
      activeModelId,
      // 只认三档枚举值；换过模型后旧档不再适用时按新模型就近归一
      activeThinkingLevel: pairThinkingLevel(activeProvider, activeModelId, parseThinkingLevel(parsed.activeThinkingLevel)),
      providers,
    };
  } catch {
    return emptyConfig();
  }
}

function emptyConfig(): ProviderConfigFile {
  return {
    schemaVersion: PROVIDER_CONFIG_SCHEMA_VERSION,
    activeProviderId: null,
    activeModelId: null,
    activeThinkingLevel: null,
    providers: [],
  };
}

/** 只接受界面暴露的三档；其它值（含旧版本残留）一律视为未选。 */
function parseThinkingLevel(value: unknown): ThinkingLevel | null {
  return value === 'low' || value === 'high' || value === 'max' ? value : null;
}

/** 当前生效的 供应商+模型 的推理能力；未配置时为 null。 */
function activeProfileOf(config: ProviderConfigFile): ModelProfile | null {
  const provider = config.providers.find((p) => p.id === config.activeProviderId);
  return thinkingProfileOf(provider, config.activeModelId);
}

function thinkingProfileOf(
  provider: ProviderRecord | undefined,
  modelId: string | null,
): ModelProfile | null {
  if (!provider || !modelId) return null;
  return modelProfile(provider.preset, modelId);
}

/**
 * 档位是跟模型绑定的：按模型能力归一，模型不支持推理时置 null。
 * 读配置与写配置都过这一道，保证 activeModelId 与 activeThinkingLevel 这对值永远自洽。
 * 从未选过（null）保持 null，由建会话时退回该模型的默认档。
 */
function pairThinkingLevel(
  provider: ProviderRecord | undefined,
  modelId: string | null,
  level: ThinkingLevel | null,
): ThinkingLevel | null {
  const profile = thinkingProfileOf(provider, modelId);
  if (!profile || !profile.thinkingEnabled || !level) return null;
  const normalized = normalizeThinkingLevel(profile, level);
  return normalized === 'off' ? null : normalized;
}
