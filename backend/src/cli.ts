#!/usr/bin/env node
/**
 * Skills 工作台 CLI（prd.md §5.14 M14、tec.md §5.14/§7.2、用例 C-30~C-32）。
 *
 * 设计原则：
 *  - **不引入命令行框架**：参数解析、帮助文本与输出封装全部自写（CJS + 纯 Node，零新依赖）。
 *  - **与 GUI 同一套领域服务、同一把跨进程锁**：不存在 CLI 能绕过的检查，也不存在只有 GUI 能做的动作。
 *  - **结构化输出**：`--json` 时 stdout 只输出一个 JSON 对象
 *    `{ok:true,data}` / `{ok:false,error:{code,detail,retryable,...}}`；
 *    参数错误退出码 2，业务错误退出码 1，成功 0。
 *  - **不泄露密钥**：所有输出与日志统一过 `redactText`（tec.md §5.14：输出中不得出现 API Key 明文）。
 *  - **环境可隔离**：库/数据/临时/日志目录取自 `.env.<mode>`，并允许显式 env 覆盖
 *    （SOFT_DIR / DATA_DIR 两个根，其余由 deriveEnvPaths 派生），
 *    测试因此可只操作 tests/runtime 下的隔离库。
 *
 * 命令：skills list|show|install|deploy|undeploy|remove、agents list|add-custom、
 *       sync status|push|pull、version。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadEnv, selectEnv, type AppEnvMode } from './env';
import { readCliVersionStamp } from './cli-publish';
import { readAppState } from './domain/app-state';
import { WriteLock } from './infra/write-lock';
import { EvalReportStore } from './domain/agent/workflows/report-store';
import { redactText } from './domain/agent/redact';
import { AgentConfigService, selectBuiltinAgents, type BuiltinAgentDef } from './domain/agents';
import { BackupService } from './domain/backup-service';
import { SkillDeployService } from './domain/deploy-service';
import { createPlacementStore } from './domain/placement-store';
import { SkillLibraryService } from './domain/library';
import { MarketService } from './domain/market/market-service';
import { SkillRemovalService } from './domain/skill-removal';
import { SkillSourceService } from './domain/sources/source-service';
import type { SkillDetail, SkillSummary } from './domain/types';

// node:sqlite 在 Node 22 仍是实验特性，默认会在 stderr 打 ExperimentalWarning；
// CLI 的 stderr 需要留给错误码（脚本会解析），故只屏蔽这一类告警，其余照常输出。
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

// ────────────────────────── 输出契约 ──────────────────────────

/** 结构化 CLI 错误：code 供脚本分支，exitCode 区分参数错误(2)与业务错误(1)。 */
class CliError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly exitCode: 1 | 2 = 1,
    readonly retryable = false,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CliError';
  }
}

function usageError(code: string, detail: string): CliError {
  return new CliError(code, detail, 2);
}

interface Logger {
  info(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
}

// ────────────────────────── 参数解析 ──────────────────────────

const BOOLEAN_FLAGS = new Set(['json', 'yes', 'help']);
const VALUE_FLAGS = new Set([
  'env',
  'group',
  'source-type',
  'origin',
  'agents',
  'name',
  'skills-dir',
  'message',
]);
/** 每个命令允许的flag（env/help 为全局） */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  'skills list': ['json', 'group', 'source-type', 'origin'],
  'skills show': ['json'],
  'skills install': ['json'],
  'skills deploy': ['json', 'agents'],
  'skills undeploy': ['json', 'agents'],
  'skills remove': ['json', 'yes'],
  'agents list': ['json'],
  'agents add-custom': ['json', 'name', 'skills-dir'],
  'sync status': ['json'],
  'sync push': ['json', 'message'],
  'sync pull': ['json'],
  version: ['json'],
};

const GLOBAL_FLAGS = new Set(['help', 'env']);

interface ParsedArgs {
  group: string;
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body.length === 0) throw usageError('UNKNOWN_OPTION', '空的选项：--');
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw usageError('INVALID_OPTION', `选项 --${name} 不接受取值`);
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw usageError('UNKNOWN_OPTION', `未知选项：--${name}（用 --help 查看用法）`);
    }
    let value: string;
    if (eq !== -1) {
      value = body.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) {
        throw usageError('MISSING_VALUE', `选项 --${name} 需要一个值`);
      }
      value = next;
      i++;
    }
    if (value.length === 0) throw usageError('MISSING_VALUE', `选项 --${name} 的值为空`);
    flags[name] = value;
  }

  const [group, command] = positional;
  return { group: group ?? '', command: command ?? '', positional: positional.slice(2), flags };
}

// ────────────────────────── 运行环境 ──────────────────────────

interface CliRuntime {
  mode: AppEnvMode;
  libraryDir: string;
  dataDir: string;
  tempDir: string;
  logDir: string;
  homeDir: string;
  softDir: string;
  adapters: readonly BuiltinAgentDef[];
  credentialPrefix: string;
}

function envValue(name: string): string | null {
  const raw = process.env[name];
  return raw != null && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * 解析运行目录：`.env.<mode>` 写四个物理位置（SOFT_DIR / HOME_DIR / DATA_DIR / TEMP_DIR），库与日志由 `deriveEnvPaths()` 派生。
 * 显式 process.env 优先（测试夹具依赖这一点）；CLI 无 Electron，生产数据根按 AppData 兜底。
 */
function resolveRuntime(mode: AppEnvMode): CliRuntime {
  const stamp = readCliVersionStamp(__dirname);
  const effectiveMode: AppEnvMode = stamp?.mode ?? mode;
  const envFile = stamp ? path.join(__dirname, '.env.selected') : path.resolve(__dirname, `../.env.${mode}`);
  const env = loadEnv(effectiveMode, envFile);
  const home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');

  const dataDir = path.resolve(
    envValue('DATA_DIR') ?? (env.DATA_DIR || path.join(appData, 'skills-studio')),
  );
  // 显式 HOME_DIR 优先（测试夹具依赖这一点）；库根默认 = <HOME_DIR>/.skills-studio/skills-library
  // （.skills-studio 是 home 固定根，bin/ 为 CLI 发布产物；库根可被本机配置 libraryPath 搬走）
  const homeDir = path.resolve(envValue('HOME_DIR') || env.HOME_DIR || home);
  const libraryDir = path.resolve(
    envValue('LIBRARY_ROOT')
      ?? readAppState(path.join(dataDir, 'app-state.json')).libraryPath
      ?? path.join(homeDir, '.skills-studio', 'skills-library'),
  );
  const softDir = env.SOFT_DIR || stamp?.installDir || path.resolve(__dirname, '..');
  const tempDir = path.resolve(envValue('TEMP_DIR') ?? (env.TEMP_DIR || path.join(softDir, 'tmp')));
  const logDir = path.resolve(envValue('LOG_DIR') ?? (env.LOG_DIR || path.join(dataDir, 'logs')));
  const adapters = selectBuiltinAgents(envValue('ADAPTERS') || env.ADAPTERS);

  return {
    mode: effectiveMode,
    libraryDir,
    dataDir,
    tempDir,
    logDir,
    homeDir,
    softDir,
    adapters,
    credentialPrefix: envValue('SKILLS_CREDENTIAL_PREFIX') ?? 'skills-studio/',
  };
}

/** CLI 日志只写文件（stdout 必须留给结构化输出）。 */
function createCliLogger(logDir: string): Logger {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `cli-${new Date().toISOString().slice(0, 10)}.log`);
  const write = (level: 'info' | 'error', event: string, data?: unknown) => {
    let safeData: unknown = undefined;
    if (data !== undefined) {
      try {
        safeData = JSON.parse(redactText(JSON.stringify(data)) ?? 'null');
      } catch {
        safeData = '[unserializable]';
      }
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      source: 'cli',
      event: redactText(event),
      data: safeData,
    });
    try {
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch {
      /* 日志写失败不影响命令结果 */
    }
  };
  return { info: (e, d) => write('info', e, d), error: (e, d) => write('error', e, d) };
}

// ────────────────────────── 服务装配（懒加载 + 统一释放） ──────────────────────────

class CliSession {
  private _lock: WriteLock | null = null;
  private _library: SkillLibraryService | null = null;
  private _sources: SkillSourceService | null = null;
  private _agents: AgentConfigService | null = null;
  private _deploy: SkillDeployService | null = null;
  private _backup: BackupService | null = null;
  private _removal: SkillRemovalService | null = null;

  constructor(
    readonly runtime: CliRuntime,
    readonly logger: Logger,
  ) {}

  get lock(): WriteLock {
    this._lock ??= new WriteLock();
    return this._lock;
  }

  get library(): SkillLibraryService {
    this._library ??= SkillLibraryService.create({
      libraryDir: this.runtime.libraryDir,
      dataDir: this.runtime.dataDir,
      lock: this.lock,
      logger: this.logger,
    });
    return this._library;
  }

  get sources(): SkillSourceService {
    this._sources ??= new SkillSourceService({
      library: this.library,
      tempDir: this.runtime.tempDir,
      lock: this.lock,
      logger: this.logger,
    });
    return this._sources;
  }

  get agents(): AgentConfigService {
    this._agents ??= AgentConfigService.create({
      dataDir: this.runtime.dataDir,
      homeDir: this.runtime.homeDir,
      adapters: this.runtime.adapters,
      logger: this.logger,
    });
    return this._agents;
  }

  get deploy(): SkillDeployService {
    if (this._deploy == null) {
      this._deploy = new SkillDeployService({
        library: this.library,
        agents: this.agents,
        lock: this.lock,
        sources: this.sources,
        logger: this.logger,
        placement: createPlacementStore({ libraryDir: this.library.libraryDir, logger: this.logger }),
      });
      this.library.setDeploymentProbe(this._deploy.createProbe());
    }
    return this._deploy;
  }

  get backup(): BackupService {
    this._backup ??= new BackupService({
      library: this.library,
      dataDir: this.runtime.dataDir,
      lock: this.lock,
      logger: this.logger,
    });
    return this._backup;
  }

  get removal(): SkillRemovalService {
    this._removal ??= new SkillRemovalService({
      library: this.library,
      agents: this.agents,
      deploy: this.deploy,
      lock: this.lock,
      logger: this.logger,
    });
    return this._removal;
  }

  get reports(): EvalReportStore {
    return new EvalReportStore(path.join(this.runtime.libraryDir, 'reports'), (skillId) => this.library.getSkillDetail(skillId)?.name ?? null);
  }

  /**
   * 查询类命令也需要部署探针：否则 deployedAgents 只是元数据里的同步意图，
   * 无法反映「意向还在、链接已被换成实体目录」这类真实状态。
   */
  attachDeploymentProbe(): void {
    void this.deploy;
  }

  close(): void {
    this._library?.close();
  }
}

// ────────────────────────── 通用工具 ──────────────────────────

function flagString(flags: ParsedArgs['flags'], name: string): string | null {
  const value = flags[name];
  return typeof value === 'string' ? value : null;
}

/** 技能引用解析：先按 Skill ID，再按名称/目录名（大小写不敏感）；重名要求用 ID。 */
function resolveSkill(session: CliSession, ref: string): SkillSummary {
  const all = session.library.listSkills();
  const byId = all.find((s) => s.skillId === ref);
  if (byId) return byId;
  const lower = ref.toLowerCase();
  const hits = all.filter((s) => s.name.toLowerCase() === lower || s.dirName.toLowerCase() === lower);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new CliError(
      'SKILL_AMBIGUOUS',
      `名称「${ref}」匹配到多个技能，请改用 Skill ID：${hits.map((s) => s.skillId).join('、')}`,
    );
  }
  throw new CliError('SKILL_NOT_FOUND', `技能不存在：${ref}`);
}

function parseAgentIds(flags: ParsedArgs['flags']): string[] {
  const raw = flagString(flags, 'agents');
  if (raw == null) throw usageError('MISSING_ARG', '缺少 --agents（如 --agents codebuddy,cursor）');
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
  if (ids.length === 0) throw usageError('MISSING_ARG', '--agents 至少需要一个 Agent ID');
  return ids;
}

function skillView(session: CliSession, skill: SkillSummary): Record<string, unknown> {
  const hasReport = session.reports.has(skill.skillId);
  return {
    skillId: skill.skillId,
    name: skill.name,
    dirName: skill.dirName,
    description: skill.description,
    groups: skill.groups,
    source: skill.source,
    deployedAgents: skill.deployedAgents,
    configuredAgents: skill.configuredAgents ?? [],
    configuredNotDeployed: skill.configuredNotDeployed ?? false,
    missing: skill.missing,
    missingSince: skill.missingSince,
    addedAt: skill.addedAt,
    updatedAt: skill.updatedAt,
    hasReport,
    reportPath: hasReport ? session.reports.path(skill.skillId) : null,
  };
}

function briefSkillLine(view: Record<string, unknown>): string {
  const groups = Array.isArray(view.groups) && view.groups.length > 0 ? ` [${(view.groups as string[]).join(',')}]` : '';
  const deployed =
    Array.isArray(view.deployedAgents) && view.deployedAgents.length > 0
      ? ` → ${(view.deployedAgents as string[]).join(',')}`
      : '';
  const missing = view.missing === true ? ' (已丢失)' : '';
  const report = view.hasReport === true ? ' · 有评测' : '';
  return `${String(view.skillId)}  ${String(view.name)}${groups}${deployed}${missing}${report}`;
}

// ────────────────────────── 命令实现 ──────────────────────────

interface CommandResult {
  data: unknown;
  lines: string[];
}

async function runSkillsList(session: CliSession, flags: ParsedArgs['flags']): Promise<CommandResult> {
  session.attachDeploymentProbe();
  await session.library.rescan(); // 另一端的写入立即反映（C-32 秒级一致性）
  const group = flagString(flags, 'group');
  const sourceType = flagString(flags, 'source-type');
  const origin = flagString(flags, 'origin');
  let skills = session.library.listSkills({
    sourceType: sourceType ?? undefined,
    origin: origin ?? undefined,
  });
  if (group != null) skills = skills.filter((s) => s.groups.includes(group));
  const views = skills.map((s) => skillView(session, s));
  return {
    data: { count: views.length, skills: views },
    lines: views.length === 0 ? ['（没有匹配的技能）'] : views.map(briefSkillLine),
  };
}

async function runSkillsShow(session: CliSession, positional: string[]): Promise<CommandResult> {
  const ref = positional[0];
  if (ref == null) throw usageError('MISSING_ARG', '用法：skills show <id|名称>');
  session.attachDeploymentProbe();
  await session.library.rescan();
  const skill = resolveSkill(session, ref);
  const detail = session.library.getSkillDetail(skill.skillId) as SkillDetail | null;
  const view = skillView(session, detail ?? skill);
  const data = {
    ...view,
    contentHash: detail?.contentHash ?? null,
    sizeBytes: detail?.sizeBytes ?? null,
    fileTree: detail?.fileTree ?? null,
  };
  const lines = [
    `${view.name}  (${view.skillId})`,
    `目录：${view.dirName}`,
    `描述：${String(view.description) || '（无）'}`,
    `Group：${Array.isArray(view.groups) && view.groups.length > 0 ? (view.groups as string[]).join(', ') : '（无）'}`,
    `来源：${view.source == null ? '（无）' : `${(view.source as { type: string }).type} ${(view.source as { origin?: string }).origin ?? ''}`.trim()}`,
    `同步：${Array.isArray(view.deployedAgents) && view.deployedAgents.length > 0 ? (view.deployedAgents as string[]).join(', ') : '（未同步）'}`,
    `评测报告：${view.hasReport === true ? String(view.reportPath) : '（无）'}`,
  ];
  if (view.missing === true) lines.push('状态：技能目录已丢失（元数据保留，可从备份恢复或移除）');
  return { data, lines };
}

async function runSkillsInstall(
  session: CliSession,
  positional: string[],
  flags: ParsedArgs['flags'],
): Promise<CommandResult> {
  const kind = positional[0];
  const arg = positional[1];
  if (kind == null || arg == null) {
    throw usageError('MISSING_ARG', '用法：skills install <dir|git|zip|market> <路径|URL|owner/repo/skill>');
  }
  if (positional.length > 2) throw usageError('TOO_MANY_ARGS', 'skills install 只接受一个来源参数');

  let items: Array<{ name: string; skillId: string | null; status: string; reason?: string; code?: string }> = [];
  let sessionDir: string | undefined;

  switch (kind) {
    case 'dir': {
      const dir = path.resolve(arg);
      if (!fs.existsSync(dir)) throw new CliError('SOURCE_NOT_FOUND', `目录不存在：${dir}`);
      const found = session.sources.discoverFromLocalDir(dir);
      if (found.items.length === 0) throw new CliError('IMPORT_NO_ITEMS', `目录中没有可导入的 Skill：${dir}`);
      const res = await session.sources.importSkills(found.items);
      items = res.results.map(toItemView);
      break;
    }
    case 'git': {
      const found = await session.sources.discoverFromGit(arg);
      sessionDir = found.sessionDir;
      if (found.items.length === 0) throw new CliError('IMPORT_NO_ITEMS', `仓库中没有可导入的 Skill：${arg}`);
      const res = await session.sources.importSkills(found.items, { sessionDir });
      items = res.results.map(toItemView);
      break;
    }
    case 'zip': {
      const zip = path.resolve(arg);
      if (!fs.existsSync(zip)) throw new CliError('SOURCE_NOT_FOUND', `压缩包不存在：${zip}`);
      const found = session.sources.discoverFromZip(zip);
      sessionDir = found.sessionDir;
      if (found.items.length === 0) throw new CliError('IMPORT_NO_ITEMS', `压缩包中没有可导入的 Skill：${zip}`);
      const res = await session.sources.importSkills(found.items, { sessionDir });
      items = res.results.map(toItemView);
      break;
    }
    case 'market': {
      const { source, skillId } = parseMarketRef(arg);
      const market = new MarketService({
        dataDir: session.runtime.dataDir,
        tempDir: session.runtime.tempDir,
        sources: session.sources,
        logger: session.logger,
      });
      const res = await market.installItems([{ source, skillId, name: skillId }]);
      items = res.results.map((r) => ({
        name: r.name,
        skillId: r.skillId,
        status: r.status,
        reason: r.reason,
        code: r.code,
      }));
      break;
    }
    default:
      throw usageError('INVALID_SOURCE_TYPE', `未知安装来源：${kind}（支持 dir/git/zip/market）`);
  }

  const imported = items.filter((i) => i.status === 'imported').length;
  const skipped = items.filter((i) => i.status === 'already-in-library').length;
  const failed = items.filter((i) => i.status === 'failed');
  const data = { source: kind, imported, skipped, failed: failed.length, results: items };

  if (failed.length > 0) {
    const summary = failed
      .slice(0, 3)
      .map((f) => `${f.name}（${f.code ?? 'FAILED'}：${f.reason ?? ''}）`)
      .join('；');
    throw new CliError(
      imported + skipped > 0 ? 'IMPORT_PARTIAL_FAILED' : 'IMPORT_FAILED',
      `${failed.length} 个条目导入失败：${summary}`,
      );
  }
  const lines = items.map((i) => `${i.status === 'imported' ? '+' : '='} ${i.name}${i.skillId ? `  ${i.skillId}` : ''}`);
  return { data, lines: lines.length > 0 ? lines : ['（没有条目）'] };
}

function toItemView(r: { name: string; skillId: string | null; status: string; reason?: string; code?: string }) {
  return { name: r.name, skillId: r.skillId, status: r.status, reason: r.reason, code: r.code };
}

/** 市场引用 owner/repo/skill（上游 skills.sh 的 GitHub 来源形态）。 */
function parseMarketRef(raw: string): { source: string; skillId: string } {
  const parts = raw.split('/').filter((s) => s.length > 0);
  if (parts.length < 3) {
    throw usageError('MISSING_ARG', `市场引用格式为 owner/repo/skill：${raw}`);
  }
  const skillId = parts.slice(2).join('/');
  return { source: `${parts[0]}/${parts[1]}`, skillId };
}

async function runSkillsDeploy(
  session: CliSession,
  positional: string[],
  flags: ParsedArgs['flags'],
): Promise<CommandResult> {
  const ref = positional[0];
  if (ref == null) throw usageError('MISSING_ARG', '用法：skills deploy <id|名称> --agents <id[,id]>');
  const agentIds = parseAgentIds(flags);
  await session.library.rescan();
  const skill = resolveSkill(session, ref);
  const result = await session.deploy.syncToAgents([skill.skillId], agentIds);
  assertDeployOutcome(result.items, 'DEPLOY_FAILED');
  const lines = result.items.map((i) => `${i.agentId}: ${i.status}${i.linkType ? ` (${i.linkType})` : ''}`);
  return { data: { skillId: skill.skillId, dirName: skill.dirName, summary: result.summary, items: result.items }, lines };
}

async function runSkillsUndeploy(
  session: CliSession,
  positional: string[],
  flags: ParsedArgs['flags'],
): Promise<CommandResult> {
  const ref = positional[0];
  if (ref == null) throw usageError('MISSING_ARG', '用法：skills undeploy <id|名称> --agents <id[,id]>');
  const agentIds = parseAgentIds(flags);
  await session.library.rescan();
  const skill = resolveSkill(session, ref);
  const items = await session.deploy.undeployFromAgents(skill.skillId, agentIds);
  assertDeployOutcome(items, 'UNDEPLOY_FAILED');
  const lines = items.map((i) => `${i.agentId}: ${i.status}${i.removedVia ? ` (${i.removedVia})` : ''}`);
  return { data: { skillId: skill.skillId, dirName: skill.dirName, items }, lines };
}

/** 部署/撤下结果判定：failed/skipped/conflict/replaced 都算未达成意图。 */
function assertDeployOutcome(
  items: Array<{ agentId: string; status: string; code?: string; reason?: string; targetPath: string }>,
  fallbackCode: string,
): void {
  const bad = items.find((i) => i.status !== 'deployed' && i.status !== 'already' && i.status !== 'removed' && i.status !== 'noop');
  if (bad == null) return;
  throw new CliError(
    bad.code ?? fallbackCode,
    `${bad.agentId}（${bad.status}）：${bad.reason ?? '未完成'} ${bad.targetPath}`.trim(),
  );
}

async function runSkillsRemove(
  session: CliSession,
  positional: string[],
  flags: ParsedArgs['flags'],
): Promise<CommandResult> {
  const ref = positional[0];
  if (ref == null) throw usageError('MISSING_ARG', '用法：skills remove <id|名称> --yes');
  await session.library.rescan();
  const skill = resolveSkill(session, ref);

  if (flags.yes !== true) {
    // 二次确认：只统计不写盘（PRD 5.1「说明会撤下多少个 Agent 的受管理链接」）
    const plan = session.removal.planRemoval(skill.skillId);
    const skipped = plan.skippedTargets.length;
    throw new CliError(
      'CONFIRMATION_REQUIRED',
      `删除技能「${skill.name}」将撤下 ${plan.linksToRemove.length} 个受管理链接，并删除库内目录、元数据${
        plan.hasReport ? '与评测报告' : ''
      }${skipped > 0 ? `；另有 ${skipped} 个非归属目标将保留` : ''}。确认请重新执行并加 --yes。`,
    );
  }

  const result = await session.removal.removeSkill(skill.skillId);
  const lines = [
    `已删除 ${result.name}（${result.skillId}）`,
    `撤下受管理链接：${result.removedLinks}`,
    `保留非归属目标：${result.skippedTargets.length}`,
    `库内目录：${result.libraryDirDeleted ? '已删除' : '原本不存在'}`,
    `元数据：${result.metadataDeleted ? '已删除' : '仍存在（请检查权限）'}`,
    `评测报告：${result.reportDeleted ? '已删除' : '无'}`,
    `库内剩余技能：${result.remainingSkills}`,
  ];
  return { data: result, lines };
}

function runAgentsList(session: CliSession): CommandResult {
  const agents = session.agents.list().map((a) => ({
    id: a.id,
    name: a.name,
    skillsDir: a.skillsDir,
    enabled: a.enabled,
    builtin: a.builtin,
    installed: a.installed,
  }));
  return {
    data: { count: agents.length, agents },
    lines: agents.map((a) => `${a.id}  ${a.name}  ${a.enabled ? 'enabled' : 'disabled'}  ${a.installed ? 'installed' : 'missing'}  ${a.skillsDir}`),
  };
}

function runAgentsAddCustom(session: CliSession, flags: ParsedArgs['flags']): Promise<CommandResult> {
  const name = flagString(flags, 'name');
  const skillsDir = flagString(flags, 'skills-dir');
  if (name == null) throw usageError('MISSING_ARG', '缺少 --name');
  if (skillsDir == null) throw usageError('MISSING_ARG', '缺少 --skills-dir');
  // 本机设置也在同一把锁内写，避免与另一端的 Agent 配置修改互相覆盖
  return session.lock.runExclusive('agents-add-custom', () => {
    const agent = session.agents.addCustom({ name, skillsDir });
    return {
      data: {
        id: agent.id,
        name: agent.name,
        skillsDir: agent.skillsDir,
        enabled: agent.enabled,
        builtin: agent.builtin,
        installed: agent.installed,
      },
      lines: [`已新增 Agent：${agent.name}（${agent.id}）→ ${agent.skillsDir}`],
    };
  });
}

async function runSyncStatus(session: CliSession): Promise<CommandResult> {
  const status = await session.backup.getStatus();
  const conflicts = session.backup.listConflicts().map((c) => ({
    skillId: c.skillId,
    dirName: c.dirName,
    kind: c.kind,
  }));
  const data = { ...status, conflicts };
  return {
    data,
    lines: [
      `git：${status.gitAvailable ? '可用' : '未安装'}`,
      `仓库：${status.initialized ? '已初始化' : '未初始化'}`,
      `远端：${status.remoteUrl ?? '（未配置）'}  分支：${status.branch}`,
      `待处理冲突：${status.pendingConflictCount}`,
    ],
  };
}

async function runSyncPush(session: CliSession, flags: ParsedArgs['flags']): Promise<CommandResult> {
  const message = flagString(flags, 'message') ?? undefined;
  const result = await session.backup.push(message != null ? { message } : {});
  if (result.status === 'rejected') {
    throw new CliError(result.code ?? 'GIT_PUSH_REJECTED', result.reason ?? '远端拒绝推送，请先 Pull', 1, true);
  }
  return {
    data: result,
    lines: [
      result.status === 'pushed' ? `已推送 ${result.commitId.slice(0, 8)}` : '远端已是最新，无需推送',
      ...(result.excluded.length > 0 ? [`排除（>100MB）技能：${result.excluded.map((e) => e.dirName).join(', ')}`] : []),
    ],
  };
}

async function runSyncPull(session: CliSession): Promise<CommandResult> {
  const result = await session.backup.pull();
  const conflicts = session.backup.listConflicts().map((c) => ({
    skillId: c.skillId,
    dirName: c.dirName,
    kind: c.kind,
    local: c.local,
    remote: c.remote,
  }));
  if (result.conflicts.length > 0) {
    // 冲突未决：本机内容已安全落库/入待处理区，但命令必须失败退出（脚本需要感知）
    throw new CliError(
      'SYNC_CONFLICT_PENDING',
      `拉取后产生 ${result.conflicts.length} 个冲突待处理：${result.conflicts
        .map((c) => `${c.dirName ?? c.skillId}（${c.kind}）`)
        .join('、')}`,
      1,
      false,
      { conflicts },
    );
  }
  return {
    data: { ...result, conflicts },
    lines: [
      `Pull 状态：${result.status}`,
      `采纳远端技能：${result.adopted.length}`,
      `移除：${result.removed.length}`,
    ],
  };
}

function runVersion(session: CliSession): CommandResult {
  const stamp = readCliVersionStamp(__dirname);
  // 内部技能目录（skill-doctor 等能力型 skill 所在，不入中心库、不同步）：
  // 1) 发布副本内与 CLI 同目录的 @skills-studio/agent/dist/skills（首选：agent 找到 CLI 即找到它）；
  // 2) 版本戳记录的安装根 <installDir>/agents/skills；3) 构建态用 SOFT_DIR（开发 = 仓库根）。
  const inPublish = path.join(__dirname, 'node_modules', '@skills-studio', 'agent', 'dist', 'skills');
  const agentsSkillsDir = fs.existsSync(path.join(inPublish, 'skill-doctor'))
    ? inPublish
    : stamp?.installDir
      ? path.join(stamp.installDir, 'agents', 'skills')
      : path.join(session.runtime.softDir, 'agents', 'skills');
  const data = {
    version: cliVersion(),
    published: stamp,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    mode: session.runtime.mode,
    cliPath: __filename,
    builtAt: safeMtime(__filename),
    libraryDir: session.runtime.libraryDir,
    dataDir: session.runtime.dataDir,
    agentsSkillsDir,
  };
  const lines = [
    `Skills 工作台 CLI v${data.version}`,
    `Node ${data.node} / ${data.platform}-${data.arch}`,
    `库：${data.libraryDir}`,
    `数据：${data.dataDir}`,
    `内部技能目录：${agentsSkillsDir}`,
    stamp ? `已发布版本戳：v${stamp.version}（${stamp.publishedAt}）` : '尚未发布到固定位置（可运行 publishCli）',
  ];
  return { data, lines };
}

function cliVersion(): string {
  // 发布副本：<target>/version.json；构建产物：<dist>/../package.json
  const stamp = readCliVersionStamp(__dirname);
  if (stamp != null) return stamp.version;
  for (const candidate of [path.resolve(__dirname, 'package.json'), path.resolve(__dirname, '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {
      /* 试下一个位置 */
    }
  }
  return '0.0.0';
}

function safeMtime(file: string): string | null {
  try {
    return new Date(fs.statSync(file).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

// ────────────────────────── 分发 ──────────────────────────

const HELP = `Skills 工作台 CLI

用法：skills <分组> <命令> [参数] [--json]

  skills list [--group G] [--source-type T] [--origin O]
  skills show <id|名称>
  skills install <dir|git|zip|market> <路径|URL|owner/repo/skill>
  skills deploy <id|名称> --agents <id[,id]>
  skills undeploy <id|名称> --agents <id[,id]>
  skills remove <id|名称> --yes
  agents list
  agents add-custom --name <名称> --skills-dir <绝对路径>
  sync status | sync push [--message <说明>] | sync pull
  version

全局选项：
  --json                输出 {ok,data} / {ok,error} 结构化 JSON
  --yes                 确认删除等不可逆操作
  --env <环境>          源码运行时临时选择 development、uat 或 production
  --help                显示本帮助

退出码：0 成功；1 业务错误；2 参数错误。
`;

async function execute(parsed: ParsedArgs, session: CliSession): Promise<CommandResult> {
  const key = parsed.group === 'version' ? 'version' : `${parsed.group} ${parsed.command}`;
  const allowed = COMMAND_FLAGS[key];
  if (allowed == null) {
    throw usageError(
      parsed.group === '' ? 'UNKNOWN_COMMAND' : 'UNKNOWN_COMMAND',
      `未知命令：${[parsed.group, parsed.command].filter((s) => s.length > 0).join(' ') || '（空）'}（用 --help 查看用法）`,
    );
  }
  for (const name of Object.keys(parsed.flags)) {
    if (GLOBAL_FLAGS.has(name)) continue;
    if (!allowed.includes(name)) throw usageError('UNKNOWN_OPTION', `命令 ${key} 不支持选项 --${name}`);
  }

  switch (key) {
    case 'skills list':
      return runSkillsList(session, parsed.flags);
    case 'skills show':
      return runSkillsShow(session, parsed.positional);
    case 'skills install':
      return runSkillsInstall(session, parsed.positional, parsed.flags);
    case 'skills deploy':
      return runSkillsDeploy(session, parsed.positional, parsed.flags);
    case 'skills undeploy':
      return runSkillsUndeploy(session, parsed.positional, parsed.flags);
    case 'skills remove':
      return runSkillsRemove(session, parsed.positional, parsed.flags);
    case 'agents list':
      return runAgentsList(session);
    case 'agents add-custom':
      return runAgentsAddCustom(session, parsed.flags);
    case 'sync status':
      return runSyncStatus(session);
    case 'sync push':
      return runSyncPush(session, parsed.flags);
    case 'sync pull':
      return runSyncPull(session);
    case 'version':
      return runVersion(session);
    default:
      throw usageError('UNKNOWN_COMMAND', `未知命令：${key}`);
  }
}

function asCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  const shaped = err as { code?: unknown; detail?: unknown; retryable?: unknown };
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof shaped?.code === 'string' && shaped.code.length > 0 ? shaped.code : 'INTERNAL_ERROR';
  const detail = typeof shaped?.detail === 'string' && shaped.detail.length > 0 ? shaped.detail : message;
  return new CliError(code, detail, 1, shaped?.retryable === true);
}

function emitSuccess(result: CommandResult, json: boolean): void {
  if (json) {
    process.stdout.write(redactText(JSON.stringify({ ok: true, data: result.data })) + '\n');
    return;
  }
  for (const line of result.lines) process.stdout.write(redactText(line) + '\n');
}

function emitError(err: CliError, json: boolean): void {
  const payload = {
    ok: false,
    error: { code: err.code, detail: redactText(err.detail), retryable: err.retryable, ...err.extra },
  };
  if (json) {
    process.stdout.write(redactText(JSON.stringify(payload)) + '\n');
    return;
  }
  process.stderr.write(redactText(`${err.code}: ${err.detail}`) + '\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes('--json');
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    emitError(asCliError(err), jsonMode);
    process.exitCode = 2;
    return;
  }

  if (parsed.flags.help === true) {
    process.stdout.write(HELP);
    return;
  }

  let session: CliSession | null = null;
  try {
    const published = readCliVersionStamp(__dirname);
    const override = flagString(parsed.flags, 'env');
    if (published && override) throw usageError('INVALID_OPTION', '发布版 CLI 使用打包时选定的环境');
    const mode = selectEnv(published ? undefined : override ?? process.env.SKILLS_CLI_ENV);
    const runtime = resolveRuntime(mode);
    session = new CliSession(runtime, createCliLogger(runtime.logDir));
    const result = await execute(parsed, session);
    emitSuccess(result, jsonMode);
  } catch (err) {
    const cliErr = asCliError(err);
    emitError(cliErr, jsonMode);
    process.exitCode = cliErr.exitCode;
  } finally {
    try {
      session?.close();
    } catch {
      /* 关闭索引失败不改变命令结果 */
    }
  }
}

void main();
