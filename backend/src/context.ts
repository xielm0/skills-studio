/**
 * 主进程业务上下文（T10）：把 T01~T08 的领域服务装配成一份可复用的运行时。
 *
 * 职责边界：
 *  - 只做装配与生命周期（打开/关闭、库迁移后的重建），不含业务规则；
 *  - 库路径可变：迁移成功后 switchLibrary 关闭旧连接、按新路径重建并重扫；
 *  - 不依赖 electron，主进程与测试都可用同一份装配逻辑。
 */
import type { CredentialBackend } from './infra/win-credential';
import * as path from 'node:path';
import { WriteLock } from './infra/write-lock';
import { AgentConfigService, type BuiltinAgentDef } from './domain/agents';
import { AppStateService } from './domain/app-state';
import { SkillCatalogService } from './domain/catalog';
import { SkillUpdateService } from './domain/update-service';
import { AgentSkillsService } from './domain/agent-skills';
import { SkillDeployService } from './domain/deploy-service';
import { createPlacementStore } from './domain/placement-store';
import { FirstRunService } from './domain/first-run';
import { LibraryMigrationService } from './domain/library-migration';
import { SkillLibraryService } from './domain/library';
import { OverviewService } from './domain/overview';
import { SkillRemovalService } from './domain/skill-removal';
import { SkillSourceService } from './domain/sources';
import { MarketService } from './domain/market/market-service';
import { SkillHubService } from './domain/market/skillhub-service';
import type { MarketHttpClient } from './domain/market/http';
import { InstallService } from './domain/install-service';
import { ConversationService } from './domain/agent/conversation-service';
import { ProviderConfigService } from './domain/agent/providers';
import { SkillWorkflowService } from './domain/agent/workflows/skill-workflows';
import { listBuiltinSkills } from './domain/agent/workflows/quick-prompts';
import { EvalReportStore } from './domain/agent/workflows/report-store';
import { BackupService } from './domain/backup-service';
import { SyncService } from './domain/sync-service';
import type { AppEnvName, LibraryChangeDirectoryResult, LibraryMigrationPolicy } from './shared/ipc';

export interface AppContextOptions {
  /** 生效的中心库目录（已含用户本机配置/环境默认值的解析结果） */
  libraryDir: string;
  dataDir: string;
  tempDir: string;
  /** 用户主目录：内置 adapter 的目录 = <homeDir>/<skillsDirRel>（生产 os.homedir()；测试/截图传临时 home） */
  homeDir: string;
  /**
   * 软件根（生产 = 安装目录 resources；开发 = 仓库根）：内部 Skill 根 = <softDir>/agents/skills。
   * 生产该目录在 asar 之外（extraResources），可投放新 Skill；缺省由 agents 模块自动定位。
   */
  softDir?: string;
  /** 本次生效的 adapter 清单（`.env` 的 ADAPTERS 筛选结果；缺省 = 全集） */
  adapters?: readonly BuiltinAgentDef[];
  appEnv: AppEnvName;
  version: string;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
  /** 测试可注入凭据后端与前缀；生产留空走 Windows 凭据管理器 */
  credentialBackend?: CredentialBackend;
  credentialPrefix?: string;
  /** 迁移失败注入点（仅测试） */
  migrationFailPoint?: 'after-copy' | 'after-config' | 'after-link' | 'after-verify' | null;
  /** T11：文件保存失败注入点（仅测试，验证「失败保留旧内容」） */
  fileWriteFailPoint?: 'before-rename' | null;
  /** T12：市场 HTTP 注入点（测试用本地回放服务器；缺省走真实 fetch） */
  marketHttp?: MarketHttpClient;
}

export class AppContext {
  readonly dataDir: string;
  readonly tempDir: string;
  readonly appEnv: AppEnvName;
  readonly version: string;
  readonly state: AppStateService;
  readonly agents: AgentConfigService;
  readonly providers: ProviderConfigService;
  /** T06/T07 会话与运行（跨库共享同一 DATA_DIR） */
  readonly conversations: ConversationService;

  private readonly logger: AppContextOptions['logger'];
  private readonly migrationFailPoint: AppContextOptions['migrationFailPoint'];
  private readonly fileWriteFailPoint: 'before-rename' | null;
  private readonly marketHttp: MarketHttpClient | undefined;
  /** 内部 Skill 根（<softDir>/agents/skills）：会话清单与流程文本共用，asar 之外可投放 */
  private readonly agentsSkillsRoot: string | undefined;

  private _libraryDir: string;
  private _library: SkillLibraryService;
  private _sources: SkillSourceService;
  private _deploy: SkillDeployService;
  private _firstRun: FirstRunService;
  private _catalog: SkillCatalogService;
  private _updates: SkillUpdateService;
  private _agentSkills: AgentSkillsService;
  private _removal: SkillRemovalService;
  private _workflows: SkillWorkflowService;
  private _market: MarketService;
  private _install: InstallService;
  private _backup: BackupService;
  private _sync: SyncService;
  private watching = false;

  private constructor(opts: AppContextOptions) {
    this.dataDir = opts.dataDir;
    this.tempDir = opts.tempDir;
    this.appEnv = opts.appEnv;
    this.version = opts.version;
    this.logger = opts.logger;
    this.migrationFailPoint = opts.migrationFailPoint ?? null;
    this.fileWriteFailPoint = opts.fileWriteFailPoint ?? null;
    this.marketHttp = opts.marketHttp;
    this.agentsSkillsRoot = opts.softDir ? path.join(path.resolve(opts.softDir), 'agents', 'skills') : undefined;

    this.state = new AppStateService(opts.dataDir);
    this.agents = AgentConfigService.create({
      dataDir: opts.dataDir,
      homeDir: opts.homeDir,
      adapters: opts.adapters,
      logger: opts.logger,
      // 删除自定义 Agent 时清掉它的落点表，不留孤儿（库可能被切换，调用时再取当前库）
      onRemoved: (agentId) =>
        createPlacementStore({ libraryDir: this._libraryDir, logger: this.logger }).removeFile(agentId),
    });
    this.providers = new ProviderConfigService({
      dataDir: opts.dataDir,
      credentialBackend: opts.credentialBackend,
      credentialPrefix: opts.credentialPrefix,
    });
    this.conversations = new ConversationService({
      dataDir: opts.dataDir,
      providers: this.providers,
      credentialBackend: opts.credentialBackend,
      credentialPrefix: opts.credentialPrefix,
      logger: opts.logger,
      // 内置 skill 作为「Agent 可发现的 skill」：清单进系统提示，目录作为只读根。
      // 根显式指向 <softDir>/agents/skills（asar 之外、与 CLI 上报的投放目录同一根）；
      // 缺省（测试/未传 softDir）沿用 agents 模块自动定位，行为不变。
      builtinSkills: listBuiltinSkills(this.agentsSkillsRoot),
      builtinSkillsRoot: this.agentsSkillsRoot,
    });

    this._libraryDir = opts.libraryDir;
    const built = this.buildLibraryServices(opts.libraryDir);
    this._library = built.library;
    this._sources = built.sources;
    this._deploy = built.deploy;
    this._catalog = built.catalog;
    this._updates = built.updates;
    this._agentSkills = built.agentSkills;
    this._removal = built.removal;
    this._market = built.market;
    this._install = built.install;
    this._backup = built.backup;
    this._sync = built.sync;
    this._firstRun = this.buildFirstRun();
    this._workflows = this.buildWorkflows();
  }

  static create(opts: AppContextOptions): AppContext {
    return new AppContext(opts);
  }

  get libraryDir(): string {
    return this._libraryDir;
  }

  get library(): SkillLibraryService {
    return this._library;
  }

  get sources(): SkillSourceService {
    return this._sources;
  }

  get deploy(): SkillDeployService {
    return this._deploy;
  }

  get firstRun(): FirstRunService {
    return this._firstRun;
  }

  /** T11：中心库列表/详情/文件读写/Group。 */
  get catalog(): SkillCatalogService {
    return this._catalog;
  }

  get updates(): SkillUpdateService {
    return this._updates;
  }

  /** T13：Agents 页（实时目录扫描、状态灯、灰灯入库、agent 源详情/读写）。 */
  get agentSkills(): AgentSkillsService {
    return this._agentSkills;
  }

  /** T08：删除计划与执行（撤下链接 → 删报告 → 删目录 → 删元数据）。 */
  get removal(): SkillRemovalService {
    return this._removal;
  }

  /** T07：创建/改进/评测的会话与预填提示词（本任务只用预填，不启动运行）。 */
  get workflows(): SkillWorkflowService {
    return this._workflows;
  }

  /** T05：技能市场（榜单/搜索/详情/安装）。 */
  get market(): MarketService {
    return this._market;
  }

  /** T12：安装 Skills（五来源发现 + 多选导入，不自动部署）。 */
  get install(): InstallService {
    return this._install;
  }

  /** T04/T14：Git 备份仓库（Pull/Push/历史/恢复）——底层能力，界面走 sync。 */
  get backup(): BackupService {
    return this._backup;
  }

  /** T14：备份页应用服务（状态、连接、Pull/Push、冲突选择、版本详情、恢复）。 */
  get sync(): SyncService {
    return this._sync;
  }

  /** 主页聚合（无状态，每次按当前库/Agent 视图构造）。 */
  overview(): OverviewService {
    return new OverviewService({ library: this._library, agents: this.agents });
  }

  /**
   * 库路径迁移：文件搬迁 → 更新本机配置 → 重建全部链接 → 校验，失败回退旧路径。
   * 迁移服务不持有库实例，通过 switchLibrary 回调让上下文完成重建。
   */
  changeLibraryDirectory(
    targetDir: string,
    policy?: LibraryMigrationPolicy,
  ): Promise<LibraryChangeDirectoryResult> {
    const migration = new LibraryMigrationService({
      dataDir: this.dataDir,
      libraryDir: this._libraryDir,
      agents: this.agents,
      state: this.state,
      switchLibrary: (dir) => this.switchLibrary(dir),
      failPoint: this.migrationFailPoint,
      logger: this.logger,
    });
    return migration.change(targetDir, policy);
  }

  /** 关闭旧库连接并按新目录重建（供迁移与启动复用）。 */
  async switchLibrary(dir: string): Promise<void> {
    const resolved = dir;
    this._install.dispose();
    this.disposeLibraryServices();
    const built = this.buildLibraryServices(resolved);
    this._libraryDir = resolved;
    this._library = built.library;
    this._sources = built.sources;
    this._deploy = built.deploy;
    this._catalog = built.catalog;
    this._updates = built.updates;
    this._agentSkills = built.agentSkills;
    this._removal = built.removal;
    this._market = built.market;
    this._install = built.install;
    this._backup = built.backup;
    this._sync = built.sync;
    this._firstRun = this.buildFirstRun();
    this._workflows = this.buildWorkflows();
    if (this.watching) {
      this._library.startWatching();
      this._updates.start();
    }
    await this._library.rescan();
    this.logger?.info('context:library-switched', { libraryDir: resolved });
  }

  /** 开启文件监视（工作台运行期保持索引新鲜；测试可不开）。 */
  startWatching(): void {
    this.watching = true;
    this._library.startWatching();
    this._updates.start();
  }

  dispose(): void {
    try {
      this._install.dispose();
    } catch (err) {
      this.logger?.error('context:install-dispose-failed', { error: (err as Error).message });
    }
    this.disposeLibraryServices();
  }

  private disposeLibraryServices(): void {
    this._updates.dispose();
    try {
      this._library.stopWatching();
      this._library.close();
    } catch (err) {
      this.logger?.error('context:library-close-failed', { error: (err as Error).message });
    }
  }

  private buildLibraryServices(libraryDir: string): {
    library: SkillLibraryService;
    sources: SkillSourceService;
    deploy: SkillDeployService;
    catalog: SkillCatalogService;
    updates: SkillUpdateService;
    agentSkills: AgentSkillsService;
    removal: SkillRemovalService;
    market: MarketService;
    install: InstallService;
    backup: BackupService;
    sync: SyncService;
    lock: WriteLock;
  } {
    // 写权限只在进程内排队；跨进程文件锁已于 2026-10-30 移除（见 infra/write-lock.ts 头注释）
    const lock = new WriteLock();
    const library = SkillLibraryService.create({
      libraryDir,
      dataDir: this.dataDir,
      lock,
      logger: this.logger,
    });
    const sources = new SkillSourceService({ library, tempDir: this.tempDir, lock, logger: this.logger });
    // 同步落点记忆：<库>/agents-skills/<agentId>.skills，随库进 Git（2026-11-03 前在 <库>/sync/）
    const placement = createPlacementStore({ libraryDir, logger: this.logger });
    const deploy = new SkillDeployService({
      library,
      agents: this.agents,
      lock,
      sources,
      logger: this.logger,
      placement,
    });
    library.setDeploymentProbe(deploy.createProbe());
    const updates = new SkillUpdateService({ library, agents: this.agents,
      tempDir: this.tempDir, lock, logger: this.logger, marketHttp: this.marketHttp });
    const catalog = new SkillCatalogService({
      library,
      agents: this.agents,
      reports: new EvalReportStore(path.join(library.libraryDir, 'reports'), (skillId) => library.getSkillDetail(skillId)?.name ?? null),
      updateState: (skillId, source) => updates.getState(skillId, source),
      lock,
      logger: this.logger,
      writeFailPoint: this.fileWriteFailPoint,
    });
    const removal = new SkillRemovalService({
      library,
      agents: this.agents,
      deploy,
      lock,
      logger: this.logger,
    });
    const agentSkills = new AgentSkillsService({
      library,
      agents: this.agents,
      deploy,
      catalog,
      logger: this.logger,
      placement,
      lock,
    });
    const market = new MarketService({
      dataDir: this.dataDir,
      tempDir: this.tempDir,
      sources,
      http: this.marketHttp,
      logger: this.logger,
    });
    const skillHub = new SkillHubService({ tempDir: this.tempDir, sources, http: this.marketHttp });
    const install = new InstallService({
      library,
      sources,
      market,
      skillHub,
      agents: this.agents,
      logger: this.logger,
      placement,
    });
    const backup = new BackupService({ library, dataDir: this.dataDir, lock, logger: this.logger });
    const sync = new SyncService({ backup, library, dataDir: this.dataDir });
    // 库内技能被手动挪位后：每次重扫完成即自愈 Agent 侧过期链接（文件监视 / 打开中心库页都走重扫）
    library.onRescanned = () => {
      void deploy.reconcileStaleLinks().catch(() => {});
    };
    return { library, sources, deploy, catalog, updates, agentSkills, removal, market, install, backup, sync, lock };
  }

  private buildWorkflows(): SkillWorkflowService {
    return new SkillWorkflowService({
      library: this._library,
      conversations: this.conversations,
      // 流程文本与 / 候选同源：统一走 <softDir>/agents/skills（缺省时 agents 模块自动定位）
      resourcesDir: this.agentsSkillsRoot,
      logger: this.logger,
    });
  }

  private buildFirstRun(): FirstRunService {
    return new FirstRunService({
      library: this._library,
      sources: this._sources,
      state: this.state,
      agents: this.agents,
      logger: this.logger,
    });
  }
}
