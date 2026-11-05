/**
 * Agent 配置服务（prd.md M5/M11、tec.md §5.5/§6.2）。
 *
 * 真相 = 本机设置文件 DATA_DIR/agents.json（**不进库、不进 Git**，因为里面是本机绝对路径）。
 * 内置 adapter 目录（56 项，照竞品 `core/tool_adapters.rs` 的 `default_tool_adapters()`）
 * + 不限数量的自定义 Agent；字段：id / 名称 / skills 目录 / 启用开关 / 是否内置。
 * 「已安装」不是持久状态，而是每次读取时按目录是否存在实时判定（PRD 5.5：按已知目录是否存在判断）。
 *
 * **本次运行加载哪些 adapter 由 `.env` 的 `ADAPTERS` 决定**（dev 写子集、prod 写 ALL）：
 * 常量里写的是「支持能力全集」，`selectBuiltinAgents()` 按参数筛出本次生效的清单，
 * 首启默认项、Agents 页列表、扫描本机、部署目标、CLI 全部吃筛后的结果。
 *
 * 隔离纪律：默认目录 = `<homeDir>/<skillsDirRel>`，homeDir 由调用方传入
 * （生产 os.homedir()，测试/截图传临时 home）。本模块绝不自己去读 homedir。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const AGENT_CONFIG_SCHEMA_VERSION = 2;

export interface BuiltinAgentDef {
  id: string;
  name: string;
  /** 相对 home 的 skills 目录（生产：<home>/.claude/skills） */
  skillsDirRel: string;
}

/**
 * 支持能力全集（照竞品 56 项，字段取 id / 名称 / 相对目录）。
 * **实际加载哪些由 `.env` 的 `ADAPTERS` 过滤**，加/减上线项不需要改这份常量。
 * `<dataDir>/agents.json` 只存**用户改过的路径与开关**（overlay），不承载「支持哪些 Agent」。
 *
 * 与竞品的两处偏离（2026-11-02，用户确认）：
 * - Cline：用 Cline 官方 global 目录 `.cline/skills`（竞品写 `.agents/skills`）。
 * - Warp → Universal：`~/.agents/skills` 是 Agent Skills 开放标准的跨工具通用目录
 *   （Warp 等工具读它，但并非其专属；本机未安装 Warp），故 id 定为 `universal`、名 Universal。
 *
 * 竞品另有 additional_scan_dirs / project_relative_skills_dir / recursive_scan 三个字段，
 * 本项目的扫描器尚未实现对应行为（递归是全局固定策略），故此处先不登记。
 */
export const BUILTIN_AGENTS: readonly BuiltinAgentDef[] = [
  { id: 'cursor',                                    name: 'Cursor',                  skillsDirRel: '.cursor/skills' },
  { id: 'claude_code',                               name: 'Claude Code',             skillsDirRel: '.claude/skills' },
  { id: 'omp_agent',                                 name: 'OMP Agent',               skillsDirRel: '.omp/agent/skills' },
  { id: 'codex',                                     name: 'Codex',                   skillsDirRel: '.codex/skills' },
  { id: 'grok',                                      name: 'Grok',                    skillsDirRel: '.grok/skills' },
  { id: 'opencode',                                  name: 'OpenCode',                skillsDirRel: '.config/opencode/skills' },
  { id: 'antigravity',                               name: 'Antigravity',             skillsDirRel: '.gemini/antigravity/skills' },
  { id: 'amp',                                       name: 'Amp',                     skillsDirRel: '.config/agents/skills' },
  { id: 'kilo_code',                                 name: 'Kilo Code',               skillsDirRel: '.kilocode/skills' },
  { id: 'roo_code',                                  name: 'Roo Code',                skillsDirRel: '.roo/skills' },
  { id: 'goose',                                     name: 'Goose',                   skillsDirRel: '.config/goose/skills' },
  { id: 'gemini_cli',                                name: 'Gemini CLI',              skillsDirRel: '.gemini/skills' },
  { id: 'github_copilot',                            name: 'GitHub Copilot',          skillsDirRel: '.copilot/skills' },
  { id: 'openclaw',                                  name: 'OpenClaw',                skillsDirRel: '.openclaw/skills' },
  { id: 'droid',                                     name: 'Droid',                   skillsDirRel: '.factory/skills' },
  { id: 'windsurf',                                  name: 'Windsurf',                skillsDirRel: '.codeium/windsurf/skills' },
  { id: 'trae',                                      name: 'TRAE IDE',                skillsDirRel: '.trae/skills' },
  { id: 'cline',                                     name: 'Cline',                   skillsDirRel: '.cline/skills' },
  { id: 'deepagents',                                name: 'Deep Agents',             skillsDirRel: '.deepagents/agent/skills' },
  { id: 'firebender',                                name: 'Firebender',              skillsDirRel: '.firebender/skills' },
  { id: 'kimi',                                      name: 'Kimi Code CLI',           skillsDirRel: '.kimi-code/skills' },
  { id: 'replit',                                    name: 'Replit',                  skillsDirRel: '.config/agents/skills' },
  { id: 'universal',                                 name: 'Universal',               skillsDirRel: '.agents/skills' },
  { id: 'augment',                                   name: 'Augment',                 skillsDirRel: '.augment/skills' },
  { id: 'bob',                                       name: 'IBM Bob',                 skillsDirRel: '.bob/skills' },
  { id: 'codebuddy',                                 name: 'CodeBuddy',               skillsDirRel: '.codebuddy/skills' },
  { id: 'command_code',                              name: 'Command Code',            skillsDirRel: '.commandcode/skills' },
  { id: 'continue',                                  name: 'Continue',                skillsDirRel: '.continue/skills' },
  { id: 'cortex',                                    name: 'Cortex Code',             skillsDirRel: '.snowflake/cortex/skills' },
  { id: 'crush',                                     name: 'Crush',                   skillsDirRel: '.config/crush/skills' },
  { id: 'iflow',                                     name: 'iFlow CLI',               skillsDirRel: '.iflow/skills' },
  { id: 'junie',                                     name: 'Junie',                   skillsDirRel: '.junie/skills' },
  { id: 'kiro',                                      name: 'Kiro CLI',                skillsDirRel: '.kiro/skills' },
  { id: 'kode',                                      name: 'Kode',                    skillsDirRel: '.kode/skills' },
  { id: 'mcpjam',                                    name: 'MCPJam',                  skillsDirRel: '.mcpjam/skills' },
  { id: 'mistral_vibe',                              name: 'Mistral Vibe',            skillsDirRel: '.vibe/skills' },
  { id: 'mux',                                       name: 'Mux',                     skillsDirRel: '.mux/skills' },
  { id: 'neovate',                                   name: 'Neovate',                 skillsDirRel: '.neovate/skills' },
  { id: 'openhands',                                 name: 'OpenHands',               skillsDirRel: '.openhands/skills' },
  { id: 'pi',                                        name: 'Pi',                      skillsDirRel: '.pi/agent/skills' },
  { id: 'pochi',                                     name: 'Pochi',                   skillsDirRel: '.pochi/skills' },
  { id: 'qoder',                                     name: 'Qoder',                   skillsDirRel: '.qoder/skills' },
  { id: 'qwen_code',                                 name: 'Qwen Code',               skillsDirRel: '.qwen/skills' },
  { id: 'trae_cn',                                   name: 'TRAE CN',                 skillsDirRel: '.trae-cn/skills' },
  { id: 'zencoder',                                  name: 'Zencoder',                skillsDirRel: '.zencoder/skills' },
  { id: 'zcode',                                     name: 'ZCode',                   skillsDirRel: '.zcode/skills' },
  { id: 'adal',                                      name: 'AdaL',                    skillsDirRel: '.adal/skills' },
  { id: 'hermes',                                    name: 'Hermes Agent',            skillsDirRel: '.hermes/skills' },
  { id: 'qclaw',                                     name: 'QClaw',                   skillsDirRel: '.qclaw/skills' },
  { id: 'easyclaw',                                  name: 'EasyClaw',                skillsDirRel: '.easyclaw/skills' },
  { id: 'autoclaw',                                  name: 'AutoClaw',                skillsDirRel: '.openclaw-autoclaw/skills' },
  { id: 'workbuddy',                                 name: 'WorkBuddy',               skillsDirRel: '.workbuddy/skills' },
  { id: 'workbuddy_overseas',                        name: 'WorkBuddy AI',            skillsDirRel: '.workbuddy-ai/skills' },
  { id: 'deepseek_harness',                          name: 'DeepSeek Harness',        skillsDirRel: '.dsh/skills' },
  { id: 'gitlab_duo',                                name: 'GitLab Duo',              skillsDirRel: '.gitlab/duo/skills' },
  { id: 'minimax_code',                              name: 'MiniMax Code',            skillsDirRel: '.minimax/skills' },
];

/**
 * 按 `.env` 的 `ADAPTERS` 筛出本次生效的 adapter 清单。
 * 取值：`ALL`（全集），或 id 列表——容忍 `[codebuddy, cursor]` / `codebuddy,cursor` / 空格分隔、大小写。
 * 结果保持清单顺序（换 env 里的书写顺序不会改变列表与部署顺序）。
 */
export function selectBuiltinAgents(spec: string): readonly BuiltinAgentDef[] {
  const raw = String(spec ?? '').trim();
  if (raw.toUpperCase() === 'ALL') return BUILTIN_AGENTS;
  const ids = raw
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  if (ids.length === 0) return [];
  const names = new Set(BUILTIN_AGENTS.map((def) => def.id));
  const unknown = ids.filter((id) => !names.has(id));
  if (unknown.length > 0) {
    throw new AgentError(
      'AGENT_ADAPTER_UNKNOWN',
      `ADAPTERS 里有未知 adapter：${unknown.join(', ')}`,
    );
  }
  const picked = new Set(ids);
  return BUILTIN_AGENTS.filter((def) => picked.has(def.id));
}

/** 持久化的 Agent 记录（本机配置，不含派生状态）。 */
export interface AgentRecord {
  id: string;
  name: string;
  /** 全局 Skills 目录（绝对路径） */
  skillsDir: string;
  enabled: boolean;
  builtin: boolean;
}

/** 对外 Agent 视图（追加实时探测结果）。 */
export interface AgentInfo extends AgentRecord {
  /** 目录存在即视为「已安装」（实时判定，不持久化） */
  installed: boolean;
}

export class AgentError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'AgentError';
  }
}

export interface AgentConfigServiceOptions {
  /** 本机数据目录（设置文件放 <dataDir>/agents.json） */
  dataDir: string;
  /** 用户主目录：生产 = os.homedir()，测试/截图 = 临时 home（默认目录 = <homeDir>/<skillsDirRel>） */
  homeDir: string;
  /** 本次生效的 adapter 清单（来自 `.env` 的 ADAPTERS；缺省 = 全集） */
  adapters?: readonly BuiltinAgentDef[];
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
  /** 删除自定义 Agent 后的清理钩子（如删除 `<库>/agents-skills/<agentId>.skills`，不留孤儿） */
  onRemoved?: (agentId: string) => void;
}

interface AgentsFile {
  schemaVersion: number;
  /** 这份 overlay 是按哪个 home 生成的；home 变了内置项路径必须重建（自定义项保留） */
  homeDir?: string;
  agents: AgentRecord[];
}

/**
 * 内置 adapter 的默认 skills 目录——**homeDir 必填**，本模块内部不取 homedir。
 */
export function defaultSkillsDirFor(
  id: string,
  homeDir: string,
  defs: readonly BuiltinAgentDef[] = BUILTIN_AGENTS,
): string {
  const def = defs.find((b) => b.id === id);
  if (!def) throw new AgentError('AGENT_NOT_BUILTIN', `不是内置 Agent：${id}`);
  return path.join(path.resolve(homeDir), def.skillsDirRel);
}

export class AgentConfigService {
  private readonly file: string;
  private readonly homeDir: string;
  private readonly logger: AgentConfigServiceOptions['logger'];
  private readonly onRemoved: AgentConfigServiceOptions['onRemoved'];
  private records: AgentRecord[];

  private constructor(opts: AgentConfigServiceOptions, records: AgentRecord[]) {
    this.file = path.join(opts.dataDir, 'agents.json');
    this.homeDir = path.resolve(opts.homeDir);
    this.logger = opts.logger;
    this.records = records;
    this.onRemoved = opts.onRemoved;
  }

  /**
   * 打开（或初始化）本机配置。
   * - 首次运行：按**本次生效清单**（`.env` 的 ADAPTERS 筛后）写入默认路径；仅目录存在时默认启用；
   * - 之后：清单为准，`agents.json` 只是 overlay —— 用户改过的路径与开关保留；
   *         本次清单里不含的旧内置项会被剔除，自定义 Agent 原样保留（所以「一个个上 agents」只需改 env）；
   * - overlay 里记录的 home 与当前 home 不一致（换了 HOME_DIR / 换机器）时，内置项按新 home 重建。
   */
  static create(opts: AgentConfigServiceOptions): AgentConfigService {
    fs.mkdirSync(opts.dataDir, { recursive: true });
    const file = path.join(opts.dataDir, 'agents.json');
    const loaded = readAgentsFile(file);
    const home = path.resolve(opts.homeDir);
    const defs = opts.adapters ?? BUILTIN_AGENTS;
    const defaults = defs.map((def) => {
      const skillsDir = defaultSkillsDirFor(def.id, home, defs);
      return { id: def.id, name: def.name, skillsDir, enabled: isDir(skillsDir), builtin: true };
    });

    const homeChanged = loaded != null && loaded.homeDir !== home;
    let records: AgentRecord[];
    if (loaded == null) {
      records = defaults;
    } else {
      // 清单为准：剔除本次清单里已不存在的旧内置项；home 变了的内置项路径一律重建。
      // 顺序维持「内置在前（按清单序）、自定义在后（按创建序）」。
      const seedIds = new Set(defaults.map((d) => d.id));
      const kept = loaded.agents.filter((r) => r.builtin && !homeChanged && seedIds.has(r.id));
      const customs = loaded.agents.filter((r) => !r.builtin);
      const missing = defaults.filter((def) => !kept.some((r) => r.id === def.id));
      records = [...kept, ...missing, ...customs];
      // v1 将未检测项也默认启用，无法区分旧默认值与手动开启；只迁移未检测项一次。
      if (loaded.schemaVersion < AGENT_CONFIG_SCHEMA_VERSION) {
        records = records.map((rec) => !isDir(rec.skillsDir)
          ? { ...rec, enabled: false }
          : rec);
      }
    }

    const service = new AgentConfigService(opts, records);
    if (loaded == null || homeChanged || loaded.schemaVersion < AGENT_CONFIG_SCHEMA_VERSION || loaded.agents.length !== records.length) service.persist();
    return service;
  }

  /** 全部 Agent（含已停用），带实时 installed 状态；内置在前、自定义按创建顺序。 */
  list(): AgentInfo[] {
    return this.records.map((r) => ({ ...r, installed: isDir(r.skillsDir) }));
  }

  get(id: string): AgentInfo | null {
    const rec = this.records.find((r) => r.id === id);
    return rec ? { ...rec, installed: isDir(rec.skillsDir) } : null;
  }

  requireAgent(id: string): AgentInfo {
    const agent = this.get(id);
    if (!agent) throw new AgentError('AGENT_NOT_FOUND', `Agent 不存在：${id}`);
    return agent;
  }

  /** 重新检测：按目录是否存在重算 installed（无缓存，调用即读磁盘）。 */
  redetect(): AgentInfo[] {
    return this.list();
  }

  /** 同步目标 = 启用中且已安装的 Agent（PRD 5.5：停用 / 未安装的不出现在目标列表）。 */
  syncTargets(): AgentInfo[] {
    return this.list().filter((a) => a.enabled && a.installed);
  }

  setEnabled(id: string, enabled: boolean): AgentInfo {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) throw new AgentError('AGENT_NOT_FOUND', `Agent 不存在：${id}`);
    rec.enabled = enabled;
    this.persist();
    this.logger?.info('agents:enabled-changed', { id, enabled });
    return { ...rec, installed: isDir(rec.skillsDir) };
  }

  setEnabledAll(enabled: boolean): AgentInfo[] {
    for (const rec of this.records) rec.enabled = enabled;
    this.persist();
    return this.list();
  }

  /** 修改全局 Skills 目录（必须是绝对路径；不要求目录已存在——建链时会创建）。 */
  updateDir(id: string, skillsDir: string): AgentInfo {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) throw new AgentError('AGENT_NOT_FOUND', `Agent 不存在：${id}`);
    const next = normalizeSkillsDir(skillsDir);
    rec.skillsDir = next;
    this.persist();
    this.logger?.info('agents:dir-changed', { id, skillsDir: next });
    return { ...rec, installed: isDir(rec.skillsDir) };
  }

  /** 新增自定义 Agent（数量不限）。名称必须唯一；id 由名称派生，不加随机编号。 */
  addCustom(input: { name: string; skillsDir: string; enabled?: boolean }): AgentInfo {
    const name = input.name.trim();
    if (name.length === 0) throw new AgentError('AGENT_INVALID_NAME', 'Agent 名称不能为空');
    // Agent 名称唯一（含内置）：同名会让同步目标与落点表无法区分
    if (this.records.some((r) => r.name.trim().toLowerCase() === name.toLowerCase())) {
      throw new AgentError('AGENT_NAME_DUPLICATED', `Agent 名称已存在：${name}`);
    }
    const skillsDir = normalizeSkillsDir(input.skillsDir);
    const id = this.customIdFor(name);
    const rec: AgentRecord = {
      id,
      name,
      skillsDir,
      enabled: input.enabled ?? isDir(skillsDir),
      builtin: false,
    };
    this.records.push(rec);
    this.persist();
    this.logger?.info('agents:custom-added', { id, name, skillsDir });
    return { ...rec, installed: isDir(rec.skillsDir) };
  }

  /** 删除自定义 Agent；内置 Agent 不可删（只能停用）。 */
  removeCustom(id: string): boolean {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return false;
    if (rec.builtin) throw new AgentError('AGENT_BUILTIN_IMMUTABLE', `内置 Agent 不可删除（可停用）：${id}`);
    this.records = this.records.filter((r) => r.id !== id);
    this.persist();
    // 删掉该 Agent 的落点表，不留孤儿文件
    this.onRemoved?.(id);
    this.logger?.info('agents:custom-removed', { id });
    return true;
  }

  /**
   * 自定义 Agent 的 id：`custom-<名称 slug>`，不加随机编号。
   * 名称本身已保证唯一；只有「不同名称清洗后得到同一个 slug」（中文名 / 纯符号名 → agent）
   * 时才用序号兜底区分。
   */
  private customIdFor(name: string): string {
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'agent';
    const base = `custom-${slug}`;
    const taken = new Set(this.records.map((r) => r.id));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i += 1) {
      const id = `${base}-${i}`;
      if (!taken.has(id)) return id;
    }
  }

  private persist(): void {
    const payload: AgentsFile = {
      schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
      homeDir: this.homeDir,
      agents: this.records,
    };
    atomicWriteJson(this.file, payload);
  }
}

function normalizeSkillsDir(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new AgentError('AGENT_INVALID_DIR', 'skills 目录不能为空');
  if (!path.isAbsolute(trimmed)) {
    throw new AgentError('AGENT_INVALID_DIR', `skills 目录必须是绝对路径：${trimmed}`);
  }
  return path.resolve(trimmed);
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readAgentsFile(file: string): AgentsFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as AgentsFile;
    if (!Array.isArray(parsed.agents)) return null;
    const out: AgentRecord[] = [];
    for (const r of parsed.agents) {
      if (typeof r?.id !== 'string' || typeof r.name !== 'string' || typeof r.skillsDir !== 'string') continue;
      out.push({
        id: r.id,
        name: r.name,
        skillsDir: r.skillsDir,
        enabled: r.enabled !== false,
        builtin: r.builtin === true,
      });
    }
    return {
      schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1,
      homeDir: typeof parsed.homeDir === 'string' ? parsed.homeDir : undefined,
      agents: out,
    };
  } catch {
    // 损坏的配置按「无配置」重建内置项（本机设置不是库真相，丢失可接受）
    return null;
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
