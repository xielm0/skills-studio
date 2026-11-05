/**
 * 主进程 ↔ 渲染层共享契约（tec.md §7.1、§9.2）。
 *
 * 约束：本文件只允许纯类型与常量，禁止 import node:/electron，
 * 因为渲染层会直接引用它做类型校验（frontend/src/ipc/client.ts）。
 *
 * 通道分两类：
 * - 已实现：T09 外壳元信息（app:ping/app:info）+ T10 首启、主页、设置
 *   + T11 中心库列表/详情/文件读写/Group/同步/更新/删除/评测查看/对话预填
 *   + T12 安装 Skills + T14 备份与同步（sync:*）
 * - 类型化占位：后续任务的领域通道，调用返回 NOT_IMPLEMENTED，契约随对应任务细化
 */

export type AppEnvName = 'development' | 'production' | 'uat';

export interface AppPingResult {
  ok: boolean;
  appEnv: AppEnvName;
}

export interface AppInfoResult {
  productName: string;
  version: string;
  appEnv: AppEnvName;
  /** 中心技能库目录（开发期为 tests/runtime 隔离区） */
  libraryDir: string;
  /** 本机数据目录（索引、会话、设置） */
  dataDir: string;
  logDir: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
}

/* ────────────────────────── T10：首次启动 ────────────────────────── */

/** 应用启动态：渲染层据此决定先显示首次启动还是主页。 */
export interface InitialStateResult {
  /** 首启流程是否已完成（持久在 DATA_DIR/app-state.json） */
  firstRunCompleted: boolean;
  /** 当前中心库路径（用户改过则以本机配置为准） */
  libraryPath: string;
  mode: AppEnvName;
  version: string;
}

/** 目录选择（仅主进程可调用 Electron dialog）；取消返回 path=null。 */
export interface PickDirectoryResult {
  path: string | null;
}

/** 文件选择（T12：压缩包）；取消返回 path=null。 */
export interface PickFileResult {
  path: string | null;
}

/** 首启扫描条目：某 Agent 目录下发现的一个技能（尚未入库）。 */
export interface FirstRunScanItem {
  /** 选择键（不把本机绝对路径交给渲染层用作指令） */
  key: string;
  name: string;
  description: string;
  agentId: string;
  agentLabel: string;
  /** 源目录绝对路径（仅用于展示与排障，不作为导入参数） */
  path: string;
  /** 清洗名与库内目录名相同（提示「已入库」，导入仍按内容判定） */
  inLibrary: boolean;
  /** 是否合法技能目录（缺 SKILL.md 时为 false） */
  valid: boolean;
  invalidReason?: string;
}

export interface FirstRunScanAgent {
  id: string;
  label: string;
  skillsDir: string;
  count: number;
}

export interface FirstRunScanResult {
  items: FirstRunScanItem[];
  agents: FirstRunScanAgent[];
  /** 已启用且目录存在的 Agent 数 */
  agentCount: number;
}

export interface FirstRunImportRequest {
  /** 扫描结果里的 key（服务端用最近一次扫描缓存解析，不接受任意路径） */
  keys: string[];
}

export type FirstRunImportStatus = 'imported' | 'skipped' | 'failed';

export interface FirstRunImportItem {
  key: string;
  name: string;
  agentLabel: string;
  status: FirstRunImportStatus;
  /** 失败原因（人读文案） */
  reason?: string;
}

export interface FirstRunImportResult {
  items: FirstRunImportItem[];
  summary: { imported: number; skipped: number; failed: number };
}

export interface FirstRunCompleteResult {
  firstRunCompleted: boolean;
}

/* ────────────────────────── T10：主页 ────────────────────────── */

export interface LibraryOverview {
  /** 库中技能数（不含「已丢失」） */
  skillCount: number;
  /** 同步覆盖：至少一条实测链接的技能数 / 技能总数 */
  syncCoverage: { deployed: number; total: number };
  /** 已启用且目录存在的 Agent 数 */
  agentsConnected: number;
}

export interface RecentActivityItem {
  skillId: string;
  dirName: string;
  name: string;
  /** 行内说明，如「已同步至 Claude Code」「内容已变更」「新入库 · 尚未同步」 */
  text: string;
  /** 真实发生时间（ISO 8601） */
  occurredAt: string;
  /** 相对时间（刚刚 / 12 分钟前 / 昨天 / 3 天前） */
  relativeTime: string;
  /** 技能目录已丢失 */
  missing: boolean;
}

export interface RecentActivityResult {
  items: RecentActivityItem[];
}

/* ────────────────────────── T10：库目录迁移 ────────────────────────── */

/** 非空目标的处理策略：仅接受空目录 / 合并。 */
export type LibraryMigrationPolicy = 'empty' | 'merge';

export interface LibraryChangeDirectoryRequest {
  targetDir: string;
  /** 省略时按「空目录」校验；目标非空会返回 status='needs-policy' */
  policy?: LibraryMigrationPolicy;
}

export interface LibraryMigrationLinkItem {
  skillId: string;
  dirName: string;
  agentId: string;
  agentName: string;
  targetPath: string;
  status: 'rebuilt' | 'unchanged' | 'skipped' | 'failed';
  reason?: string;
}

export interface LibraryMigrationLinkSummary {
  rebuilt: number;
  unchanged: number;
  skipped: number;
  failed: number;
  items: LibraryMigrationLinkItem[];
}

/**
 * 迁移结果（业务结果用 payload 表达，不用错误信封：
 * 「目标非空需选择策略」是正常分支，不是异常）。
 */
export interface LibraryChangeDirectoryResult {
  status: 'moved' | 'needs-policy' | 'failed';
  /** 迁移后（或失败时仍在用的）中心库路径 */
  libraryPath: string;
  targetDir: string;
  /** 本次搬入目标的技能数 */
  movedSkills?: number;
  links?: LibraryMigrationLinkSummary;
  /** 失败后是否已回退到旧路径并恢复链接 */
  rolledBack?: boolean;
  /** 可直接展示的失败原因 */
  error?: string;
  /** 结构化失败码：TARGET_NOT_WRITABLE / SAME_DIRECTORY / NESTED_DIRECTORY / MERGE_CONFLICT / MIGRATION_FAILED */
  errorCode?: string;
  /** 迁移成功但旧目录清理失败等非阻塞提示 */
  warning?: string;
}

export interface LibraryOpenFolderResult {
  ok: boolean;
  path: string;
  error?: string;
}

/* ────────────────────────── T10：Agent 设置 ────────────────────────── */

export interface AgentView {
  id: string;
  name: string;
  /** 全局 Skills 目录（绝对路径） */
  skillsDir: string;
  enabled: boolean;
  builtin: boolean;
  /** 目录存在即「已检测」 */
  installed: boolean;
}

export interface AgentsStats {
  detected: number;
  enabled: number;
  custom: number;
  total: number;
}

export interface AgentsResult {
  agents: AgentView[];
  stats: AgentsStats;
}

/** agentId 省略 = 批量设置全部 Agent。 */
export interface AgentsSetEnabledRequest {
  agentId?: string;
  enabled: boolean;
}

export interface AgentsUpdatePathRequest {
  agentId: string;
  skillsDir: string;
}

export interface AgentsAddCustomRequest {
  name: string;
  skillsDir: string;
}

/* ────────────────────────── T13：Agents 页与 agent 源详情 ────────────────────────── */

/**
 * 本机技能四态（安装 Skills 扫描结果与 Agents 页共用，服务端算一次、两端同口径）：
 * - not-in-library：中心库没有同名技能
 * - in-library：中心库有同名且内容一致
 * - synced：Agent 目录项已是指向中心库的链接（或命中已登记的部署路径）
 * - conflict：中心库有同名但内容不同，导入必然失败
 */
export type SkillStatus = 'not-in-library' | 'in-library' | 'synced' | 'conflict';

/** Agent Tab 的一行（只列该 Agent 目录中实际存在的技能）。 */
export interface AgentSkillRow {
  /** Agent skills 目录中的目录项名（详情与文件操作以它定位） */
  dirName: string;
  name: string;
  description: string;
  /** 绿灯：实测为链接且指向中心库（悬停文案「来自中心库的链接」） */
  isManagedLink: boolean;
  /** 链接指向的中心库技能 ID（仅 isManagedLink 时可靠） */
  linkedSkillId?: string | null;
  /** 同名中心库 Skill（冲突时用于精确定位差异与部署）。 */
  matchingSkillId?: string | null;
  /** 中心库已有同名技能（按清洗后的目录名判断） */
  inLibrary?: boolean;
  /** 同名且内容哈希一致 → 入库会复用（仅灰灯行有意义） */
  inLibrarySameContent?: boolean;
  /** 四态判定（由 isManagedLink / inLibrary / inLibrarySameContent 派生） */
  status: SkillStatus;
  /** 技能内容总字节数（按内容哈希同款忽略清单统计） */
  sizeBytes?: number;
}

export interface AgentsSkillsRequest {
  agentId: string;
}

export interface AgentsSkillListResult {
  agentId: string;
  agentLabel: string;
  /** 该 Agent 的全局 Skills 目录（展示/排障用） */
  skillsDir: string;
  /** 目录是否存在（false → 空态说明目录不存在） */
  exists: boolean;
  items: AgentSkillRow[];
  scannedAt: string;
}

/** 灰灯「入库」结果：linked=新建库条目并替换为链接；reused=复用同名同内容；failed=零改动。 */
export type AgentAdoptStatus = 'linked' | 'reused' | 'failed';

export interface AgentsAdoptRequest {
  agentId: string;
  /** Agent skills 目录中的目录项名（不接受路径） */
  dirName: string;
}

export interface AgentsAdoptResult {
  status: AgentAdoptStatus;
  dirName: string;
  name?: string;
  skillId?: string | null;
  /** symlink / junction（status=linked/reused 时给出） */
  linkType?: string;
  /** 失败原因（人读文案；含「中心库已存在同名但内容不同的 Skill」） */
  reason?: string;
  code?: string;
  /** 失败后原位置是否已确认恢复（T03 回滚校验） */
  restored?: boolean;
}

/**
 * 删除该 Agent 目录下的一个技能条目（行菜单「删除」）：
 * - 指向中心库的链接 → 只删链接，库内真身零影响，并清同步意图与落点记忆；
 * - 实体目录 → 删除该技能目录（父目录与其他技能不动）；
 * - 指向别处的链接 → 保留并如实报告（与撤下/库内删除同口径：非归属目标不删）。
 */
export interface AgentsRemoveSkillRequest {
  agentId: string;
  /** Agent skills 目录中的目录项名（一层名或嵌套 `group/技能名`） */
  dirName: string;
}

export interface AgentsRemoveSkillResult {
  status: 'removed' | 'failed';
  dirName: string;
  name?: string;
  /** link=撤下了指向中心库的链接；dir=删除了实体目录 */
  removedType?: 'link' | 'dir';
  /** 失败原因（人读文案） */
  reason?: string;
  code?: string;
}

/** Agents 页「打开文件夹」：打开当前 Agent 的 skills 目录（只接受 agentId，不接受任意路径）。 */
export interface AgentsOpenFolderResult {
  ok: boolean;
  path: string;
  error?: string;
}

/* ────────────────────────── T10：模型供应商设置 ────────────────────────── */

export interface ProviderPresetView {
  preset: string;
  label: string;
  apiFormat: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  /** 「添加模型」候选（Pi 厂商目录抽取，仅提示）；空数组 = 只能手填 */
  suggestedModels: string[];
}

/** 设置页供应商行：模型清单与生效状态一并给出（行内展开管理）。 */
export interface ProviderView {
  id: string;
  name: string;
  preset: string;
  /** 协议类型，取值与 Pi 的 `api` 一致 */
  apiFormat: string;
  baseUrl: string;
  requiresApiKey: boolean;
  /** Key 只写不读：界面只显示是否已配置 */
  credentialConfigured: boolean;
  modelCount: number;
  /** 已添加的模型 ID（顺序即添加顺序） */
  models: string[];
}

export interface ProvidersResult {
  providers: ProviderView[];
  activeProviderId: string | null;
  presets: ProviderPresetView[];
  /** windows-credential-manager / unavailable */
  credentialBackend: string;
  guidance: string | null;
  runnable: boolean;
}

export interface ProvidersAddRequest {
  preset: string;
  name?: string;
  baseUrl?: string;
  apiFormat?: string;
  /** 可选：创建供应商时一并写入的模型 ID（去重后保存） */
  models?: string[];
  /** 可选：创建供应商时一并保存 Key（只写不读） */
  apiKey?: string;
}

export interface ProvidersSetActiveRequest {
  providerId: string;
}

export interface ProvidersSaveKeyRequest {
  providerId: string;
  apiKey: string;
}

export interface ProvidersRemoveRequest {
  providerId: string;
}

/* ────────────────────────── T11：Skills 中心库 ────────────────────────── */

/** 来源展示信息：保留原始 type/origin，label 用于行内展示，detail 用于悬停说明。 */
export interface LibrarySourceView {
  /** scan / local-dir / git / zip / agent:<id> / market / conversation */
  type: string;
  /** 展示分类（技能市场 / Git / 本地 / 压缩包 / 本地开发 / 具体 Agent 名称 / 中心库发现） */
  label: string;
  /** 原始位置或仓库信息（本机绝对路径不进入库元数据，此处可能为空） */
  origin?: string;
  /** 原始来源类型和位置，用于完整的悬停说明 */
  detail?: string;
}

/** 中心库列表行（ui.md：名称 / 描述摘要 / Group 标签 / 来源 / 同步 Agent / ⋯）。 */
export interface LibrarySkillRow {
  skillId: string;
  dirName: string;
  name: string;
  description: string;
  /** frontmatter 缺 name，名称回退目录名 */
  missingName: boolean;
  groups: string[];
  source: LibrarySourceView | null;
  /** 后台检查发现来源内容较入库基线有变化。 */
  updateAvailable: boolean;
  /** 后台检查失败或原始来源已消失时的非破坏性提示。 */
  updateCheckStatus?: 'source-missing' | 'error';
  updateCheckError?: string;
  /** 实测指向本技能中心库目录的 Agent（绿） */
  deployedAgents: string[];
  /** 同步意图中在本机可执行的 Agent（启用且已安装） */
  configuredAgents: string[];
  /** 意图在、链接缺失（「已配置、未执行」） */
  configuredNotDeployed: boolean;
  /** 该技能是否有评测报告（决定「评测查看」是否出现在行菜单） */
  hasReport: boolean;
  /** 技能目录已丢失 */
  missing: boolean;
  updatedAt: string;
}

/** 组合筛选：query 匹配名称/描述；sourceType 支持原始类型或展示分类。 */
export interface LibraryListRequest {
  query?: string;
  group?: string;
  sourceType?: string;
  /** 来源原始位置（Git 仓库 / 本地目录）；按 Windows 路径语义做同位置比较 */
  origin?: string;
  agentId?: string;
}

export interface LibraryListResult {
  items: LibrarySkillRow[];
  total: number;
}

export interface LibraryFacetCount {
  /** 筛选值（Group 名 / 来源类型 / Agent ID） */
  value: string;
  /** 展示名 */
  label: string;
  count: number;
}

export interface LibraryFacetsResult {
  total: number;
  groups: LibraryFacetCount[];
  sources: LibraryFacetCount[];
  /** 只列启用中的 Agent（中心库同步目标） */
  agents: LibraryFacetCount[];
}

/** 真实文件树节点（直接反映磁盘结构，含 references/scripts/assets）。 */
export interface SkillFileNode {
  name: string;
  /** 相对技能目录的路径（'/' 分隔，'.' 为根） */
  relPath: string;
  type: 'file' | 'dir';
  size: number;
  children?: SkillFileNode[];
}

/** 详情来源：中心库（默认）/ Agent 目录中的技能（T13）。 */
export type LibraryDetailOrigin = 'library' | 'agent';

/**
 * 详情请求：既能按中心库 skillId，也能按 Agent 目录项定位（origin='agent'）。
 * 走 agent 源时不要求 skillId（未入库技能没有库 ID）。
 */
export interface LibraryDetailRequest {
  skillId?: string;
  origin?: LibraryDetailOrigin;
  agentId?: string;
  /** Agent skills 目录中的目录项名（origin='agent' 时必填） */
  dirName?: string;
}

export interface LibraryDetailResult extends Omit<LibrarySkillRow, 'skillId'> {
  /** agent 源未入库时为 null */
  skillId: string | null;
  contentHash: string | null;
  sizeBytes: number | null;
  /** 已丢失时为 null */
  fileTree: SkillFileNode | null;
  /** 评测报告的展示路径 */
  reportPath: string | null;
  origin: LibraryDetailOrigin;
  /** 绿灯：当前 Agent 目录项是链接且指向中心库（仅 origin='agent' 有意义） */
  isManagedLink: boolean;
  /** origin='agent' 时的 Agent ID 与目录项名 */
  agentId?: string;
  agentEntry?: string;
}

export interface LibraryReadFileRequest {
  skillId?: string;
  /** 相对技能目录的路径（'/' 分隔；拒绝绝对路径与 ..） */
  relPath: string;
  origin?: LibraryDetailOrigin;
  agentId?: string;
  dirName?: string;
}

export type LibraryFileReason = 'MISSING' | 'BINARY' | 'TOO_LARGE' | 'NOT_A_FILE';

export interface LibraryReadFileResult {
  relPath: string;
  /** editable=false 时为 null（不把二进制内容送到渲染层） */
  content: string | null;
  size: number;
  editable: boolean;
  reason: LibraryFileReason | null;
}

export interface LibraryWriteFileRequest {
  skillId?: string;
  relPath: string;
  content: string;
  origin?: LibraryDetailOrigin;
  agentId?: string;
  dirName?: string;
}

export interface LibraryWriteFileResult {
  relPath: string;
  size: number;
  contentHash: string | null;
  savedAt: string;
}

/** Group 变更：add / remove 都是集合语义（幂等）。 */
export interface LibraryGroupsRequest {
  skillId: string;
  add?: string[];
  remove?: string[];
}

export interface LibraryGroupsResult {
  skillId: string;
  groups: string[];
}

export interface LibraryBatchGroupsRequest {
  skillIds: string[];
  add?: string[];
  remove?: string[];
}

export interface LibraryBatchGroupsItem {
  skillId: string;
  groups: string[];
  error?: string;
}

export interface LibraryBatchGroupsResult {
  items: LibraryBatchGroupsItem[];
}

export type LibrarySyncStatus = 'deployed' | 'already' | 'conflict' | 'failed' | 'skipped';

export interface LibrarySyncItem {
  skillId: string;
  dirName: string;
  agentId: string;
  agentName: string;
  status: LibrarySyncStatus;
  /** symlink / junction */
  linkType?: string;
  reason?: string;
  code?: string;
}

export interface LibrarySyncPlanItem {
  skillId: string;
  dirName: string;
  agentId: string;
  agentName: string;
  status: 'ready' | 'already' | 'same-content' | 'conflict' | 'failed' | 'skipped';
  reason?: string;
  fingerprint?: string;
  sourceHash?: string;
}

export interface LibrarySyncPlanRequest {
  skillIds: string[];
  agentIds: string[];
}

export interface LibrarySyncPlanResult {
  items: LibrarySyncPlanItem[];
}

export interface LibrarySyncDiffRequest {
  skillId: string;
  agentId: string;
  fingerprint: string;
  sourceHash: string;
  /** Omit to list files; provide a changed file to read its two sides. */
  relPath?: string;
}

export interface LibrarySyncDiffResult {
  stale: boolean;
  /** 两侧参与内容比较的普通文件中最新的 mtime（ISO 8601）。 */
  sourceMtime: string | null;
  targetMtime: string | null;
  files: Array<{ relPath: string; status: 'added' | 'removed' | 'modified' }>;
  source: LibraryReadFileResult | null;
  target: LibraryReadFileResult | null;
}

export interface LibraryUpdateDiffRequest {
  skillId: string;
  relPath?: string;
  sourceHash?: string;
  targetHash?: string;
}

export interface LibraryUpdateDiffResult extends LibrarySyncDiffResult {
  sourceHash: string;
  targetHash: string;
}

export interface LibraryApplyUpdateRequest {
  skillId: string;
  choice: 'skip' | 'overwrite';
  sourceHash: string;
  targetHash: string;
}

export interface LibraryApplyUpdateResult {
  updated: boolean;
}

export interface LibrarySyncDecision {
  skillId: string;
  agentId: string;
  choice: 'overwrite' | 'skip';
  fingerprint: string;
  sourceHash: string;
}

/** Agents 页单项冲突选择，使用同一预检查指纹。 */
export type AgentsResolveConflictRequest = LibrarySyncDecision;

export interface LibrarySyncRequest {
  skillIds: string[];
  agentIds: string[];
  /** 仅中心库预检查后的调用传入；旧调用保持遇冲突停止的行为。 */
  decisions?: LibrarySyncDecision[];
}

export interface LibrarySyncResult {
  items: LibrarySyncItem[];
  summary: Record<LibrarySyncStatus, number>;
  /** 未启用/未安装而被忽略的 Agent（只列已启用目标） */
  ignoredAgents: Array<{ agentId: string; reason: string }>;
}

export type LibraryUnsyncStatus = 'removed' | 'noop' | 'replaced' | 'failed';

export interface LibraryUnsyncItem {
  skillId: string;
  dirName: string;
  agentId: string;
  agentName: string;
  status: LibraryUnsyncStatus;
  reason?: string;
  code?: string;
}

export interface LibraryUnsyncRequest {
  skillIds: string[];
  agentIds: string[];
}

export interface LibraryUnsyncResult {
  items: LibraryUnsyncItem[];
}

export interface LibraryRemovalTargetView {
  agentId: string;
  agentName: string;
  targetPath: string;
  reason?: string;
}

export interface LibraryRemovePlanRequest {
  skillId: string;
}

export interface LibraryRemovePlanResult {
  skillId: string;
  dirName: string;
  name: string;
  /** 确认指向本技能、将被撤下的受管理链接 */
  linksToRemove: LibraryRemovalTargetView[];
  /** 存在但不是本技能链接 → 保留 */
  skippedTargets: LibraryRemovalTargetView[];
  hasReport: boolean;
  reportPath: string;
}

export interface LibraryRemoveRequest {
  skillId: string;
  /** 必须显式为 true 才执行删除（二次确认） */
  confirm: boolean;
}

export interface LibraryRemoveResult {
  skillId: string;
  name: string;
  removedLinks: number;
  reportDeleted: boolean;
  libraryDirDeleted: boolean;
  remainingSkills: number;
  skippedTargets: LibraryRemovalTargetView[];
}

export interface LibraryReportRequest {
  skillId: string;
}

export interface LibraryReportResult {
  exists: boolean;
  text?: string;
  path?: string;
}

/** 行菜单「编辑 / 评测」：创建会话并预填提示词，不启动运行。 */
export interface ConversationPrefillRequest {
  mode: 'improve' | 'evaluate';
  skillId: string;
}

export interface ConversationPrefillResult {
  mode: 'improve' | 'evaluate';
  sessionId: string;
  /** 可编辑的预填提示词（用户点「发送」后才运行，属 T15） */
  prompt: string;
  skillId: string;
  dirName: string;
  skillName: string;
}

/* ────────────────────────── T12：安装 Skills ────────────────────────── */

/** 五个安装来源（与 ui.md 顶部 Tab 一一对应）。 */
export type InstallChannel = 'market' | 'git' | 'local' | 'archive' | 'scan';

/**
 * 脚本清单元数据：用于读取技能文件信息，不触发导入确认弹窗。
 * 只列文件名，不执行、不读取脚本内容。
 */
export interface InstallScriptManifest {
  hasExecutableScripts: boolean;
  /** scripts/ 下 .py/.sh/.ps1/.bat 的相对路径（'/' 分隔，按路径排序） */
  executableScripts: string[];
}

/** 非市场来源的发现项（临时列表，不落库、不部署）。 */
export interface InstallItemView {
  /** 选择键：服务端用它解析真实来源，渲染层不能凭此传路径 */
  key: string;
  name: string;
  description: string;
  /** 相对发现根的路径（'.' 表示发现根本身） */
  relPath: string;
  sizeBytes: number;
  scriptManifest: InstallScriptManifest;
  valid: boolean;
  invalidReason?: string;
  /** 本地目录 / 压缩包 / 扫描本机：清洗名与库内目录同名 */
  inLibrary?: boolean;
  /** 本地目录 / 压缩包 / 扫描本机：同名且内容哈希一致 */
  inLibrarySameContent?: boolean;
  /** 本地目录 / 压缩包 / 扫描本机：库内状态 */
  status?: SkillStatus;
  /** scan 通道：来源 Agent */
  agentId?: string;
  agentLabel?: string;
  /** scan 通道：该技能出现的全部 Agent id（位置折叠后可能多于一个，用于来源筛选） */
  agentIds?: string[];
}

export interface InstallDiscoveryResult {
  items: InstallItemView[];
  /** scan 通道：本次结果涉及的 Agent（来源筛选的下拉选项） */
  agentOptions?: Array<{ id: string; label: string }>;
}

/** 本地目录 / 压缩包 / 扫描本机冲突：以来源内容覆盖中心库后的差异。 */
export type InstallConflictChannel = 'local' | 'archive' | 'scan';

export interface InstallScanDiffRequest {
  /** 省略时兼容旧的扫描本机调用。 */
  channel?: InstallConflictChannel;
  key: string;
  relPath?: string;
  sourceHash?: string;
  targetHash?: string;
}

export interface InstallScanDiffResult extends LibrarySyncDiffResult {
  sourceHash: string;
  targetHash: string;
}

export interface InstallScanResolveRequest {
  /** 省略时兼容旧的扫描本机调用。 */
  channel?: InstallConflictChannel;
  key: string;
  choice: 'overwrite' | 'skip';
  sourceHash: string;
  targetHash: string;
}

export interface InstallScanResolveResult {
  status: 'overwritten' | 'skipped';
  skillId: string | null;
}

/**
 * 技能市场冲突：安装时已下载并解包，冲突那一刻保留下来（不二次下载）。
 * 差异方向：市场版本 → 中心库当前版本。
 */
export interface InstallMarketDiffRequest {
  key: string;
  relPath?: string;
  sourceHash?: string;
  targetHash?: string;
}

export interface InstallMarketResolveRequest {
  key: string;
  choice: 'overwrite' | 'skip';
  sourceHash: string;
  targetHash: string;
}

/** Git、本地目录、压缩包、扫描本机的当前发现条目，只能按 key 预览。 */
export type InstallSourcePreviewChannel = Exclude<InstallChannel, 'market'>;

export interface InstallSourcePreviewRequest {
  channel: InstallSourcePreviewChannel;
  key: string;
}

export interface InstallSourcePreviewResult {
  key: string;
  name: string;
  files: InstallMarketFile[];
  fileCount: number;
  totalBytes: number;
}

export interface InstallSourceReadFileRequest extends InstallSourcePreviewRequest {
  path: string;
}

export interface InstallSourceReadFileResult {
  content: string | null;
  reason?: string;
  size: number;
}

/** 市场列表项（榜单 / 搜索共用；描述字段仅保留兼容，列表不展示）。 */
export interface InstallMarketItem {
  key: string;
  id: string;
  name: string;
  description: string;
  /** GitHub 为 owner/repo；站点自发布为域名 */
  source: string;
  /** 上游页面地址（skills.sh） */
  url: string;
  /** 上游安装量（榜单排序依据） */
  installs: number;
  isOfficial?: boolean;
}

export interface InstallMarketListResult {
  items: InstallMarketItem[];
  /** 缓存已过期且源不可用（UI 必须提示「可能过期」） */
  stale: boolean;
  fromCache: boolean;
  /** 数据获取/缓存写入时间（ISO 8601） */
  fetchedAt: string;
  /** stale 时的人读提示 */
  warning?: string;
  /** 本次数据对应的上游地址（排障用） */
  sourceUrl: string;
  query?: string;
}

export interface InstallMarketLeaderboardRequest {
  /** true = 跳过缓存重新抓取（失败仍回退旧缓存并标 stale） */
  force?: boolean;
}

export interface InstallMarketSearchRequest {
  query: string;
  force?: boolean;
}

/** 市场简介查询兼容接口；当前市场列表不调用。 */
export interface InstallMarketDescriptionRequest {
  source: string;
  skillId: string;
}

export interface InstallMarketDescriptionResult {
  text: string;
  source: 'description' | 'summary' | 'unavailable';
  stale: boolean;
}

/**
 * 市场条目文件信息：文件清单 + 总大小 + 可执行脚本。
 * key 优先（服务端缓存解析）；兼容直接给 source/skillId（仍由市场服务校验）。
 */
export interface InstallMarketPreviewRequest {
  key?: string;
  source?: string;
  skillId?: string;
  name?: string;
}

export interface InstallMarketFile {
  path: string;
  size: number;
}

export interface InstallMarketPreviewResult {
  key: string;
  itemId: string;
  name: string;
  description: string;
  files: InstallMarketFile[];
  fileCount: number;
  totalBytes: number;
  scriptManifest: InstallScriptManifest;
  stale: boolean;
  warning?: string;
  descriptionUnavailable?: boolean;
}

/** 市场详情页按需读取一个文件；非文本文件返回原因，不返回原始字节。 */
export interface InstallMarketReadFileRequest {
  source: string;
  skillId: string;
  path: string;
}

export interface InstallMarketReadFileResult {
  content: string | null;
  reason?: string;
  stale: boolean;
}

export interface InstallGitParseRequest {
  url: string;
}

export interface InstallLocalScanRequest {
  /** 必须由 app:pickDirectory 选择过（服务端白名单校验） */
  dirPath: string;
}

export interface InstallZipReadRequest {
  /** 必须由 app:pickFile 选择过（服务端白名单校验） */
  zipPath: string;
}

export type InstallImportStatus = 'imported' | 'skipped' | 'failed';

export interface InstallImportItemResult {
  key: string;
  name: string;
  status: InstallImportStatus;
  /** 跳过/失败原因（人读文案） */
  reason?: string;
  skillId?: string | null;
  /** 失败结构化错误码（NAME_CONFLICT / NOT_A_SKILL / MARKET_* 等） */
  code?: string;
}

export interface InstallImportRequest {
  channel: InstallChannel;
  /** 只接受当前通道最近一次扫描/列表返回的 key */
  items: Array<{ key: string; name?: string }>;
}

export interface InstallImportResult {
  channel: InstallChannel;
  items: InstallImportItemResult[];
  summary: { imported: number; skipped: number; failed: number };
}

/* ────────────────────────── CLI 接入指引（skills-studio skill 入库 + 同步到 Agent） ────────────────────────── */

/** 主页 CLI 接入卡片的一个候选 Agent。 */
export interface CliSetupAgentOption {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
}

export interface CliSetupStatus {
  /** skills-studio skill 已在中心库 */
  installed: boolean;
  /** 应用内置源存在（dist/resources/skills-studio/SKILL.md） */
  sourceAvailable: boolean;
  /** 内置源目录（排障用） */
  sourceDir: string;
  /** 卡片状态（app-state.json，本机持久） */
  card: 'undecided' | 'dismissed' | 'installed';
  /** 候选同步目标（全部 Agent，含未启用，由前端展示可用性） */
  agents: CliSetupAgentOption[];
}

export interface CliSetupInstallRequest {
  agentIds: string[];
}

export interface CliSetupInstallResult {
  skillId: string | null;
  dirName: string | null;
  /** 本次是否发生了入库（false = 已在库） */
  imported: boolean;
  deployed: Array<{ agentId: string; status: string }>;
  ignoredAgents: Array<{ agentId: string; reason: string }>;
}

/* ────────────────────────── T14：备份与同步（Pull / Push / 版本 / 冲突） ────────────────────────── */

/** 最近一次 Pull / Push 的结果（持久在本机 DATA_DIR，不进库、不随备份）。 */
export interface SyncOperationView {
  /** ISO 8601 */
  at: string;
  /** 业务状态：pulled / up-to-date / conflicts / pushed / rejected */
  status: string;
  /** 人读结果文案 */
  message: string;
}

/** 冲突一侧的摘要（备份页「本机版本 / 远端版本」）。 */
export interface SyncConflictSideView {
  /** 该侧最新提交时间（ISO）；缺失时退化为冲突记录时间 */
  time: string;
  /** 人读变更摘要（如「2 个文件变更：SKILL.md、评测报告」） */
  summary: string;
  /** 相对 base 的变更文件路径（'/' 分隔） */
  files: string[];
}

export interface SyncConflictView {
  /** 应用冲突选择时提交，等值于稳定 Skill ID */
  conflictId: string;
  skillId: string;
  skillName: string;
  dirName: string | null;
  /** component / both-added / deleted-locally / deleted-remotely */
  kind: string;
  /** 冲突组件：content / metadata / report */
  components: string[];
  local: SyncConflictSideView;
  remote: SyncConflictSideView;
  /** 冲突未解决期间远端又发生了变动 */
  remoteAdvanced: boolean;
}

export interface SyncLastCommitView {
  commitId: string;
  shortSha: string;
  /** ISO 8601 */
  time: string;
  message: string;
}

export interface SyncStatusResult {
  connected: boolean;
  gitAvailable: boolean;
  remoteUrl: string | null;
  branch: string;
  /** 中心库目录（未连接时说明「备份的就是这个目录」） */
  libraryDir: string;
  /** 最近一次本地备份提交（时间 / 版本号 / 说明）；从未备份为 null */
  lastCommit: SyncLastCommitView | null;
  lastPull: SyncOperationView | null;
  lastPush: SyncOperationView | null;
  pendingConflicts: SyncConflictView[];
  /** 连接后的提示（远端为空/已有版本、git 未安装、冲突未处理） */
  notice: string | null;
}

export interface SyncConnectRequest {
  url: string;
}

export interface SyncCommitRequest {
  message?: string;
}

export interface SyncCommitResult {
  status: 'committed' | 'up-to-date';
  commitId: string | null;
  message: string;
}

export type SyncPullStatus = 'up-to-date' | 'pulled' | 'conflicts';

export interface SyncPullResult {
  status: SyncPullStatus;
  /** 人读结果（成功 / 无变化 / 冲突原因） */
  message: string;
  /** 本次拉取的新版本数 */
  commits: number;
  /** 本次从远端采纳的技能目录名 */
  adopted: string[];
  /** 本次随远端删除的技能数 */
  removed: number;
  conflicts: SyncConflictView[];
}

export type SyncConflictChoice = 'local' | 'remote' | 'both';

export interface SyncResolveDecision {
  conflictId: string;
  choice: SyncConflictChoice;
}

export interface SyncResolveRequest {
  decisions: SyncResolveDecision[];
}

export interface SyncResolveItem {
  conflictId: string;
  choice: SyncConflictChoice;
  status: 'resolved' | 'failed';
  reason?: string;
  /** both：远端版本以新 Skill ID 入库 */
  newSkillId?: string | null;
  /** both：新技能的目录名（`原名 (2)` 规则） */
  newSkillName?: string | null;
}

export interface SyncResolveResult {
  items: SyncResolveItem[];
  summary: { resolved: number; failed: number };
  remainingConflicts: SyncConflictView[];
}

export interface SyncPushResult {
  status: 'pushed' | 'up-to-date' | 'rejected';
  message: string;
  /** 被拒原因（人读） */
  reason?: string;
  /** 被拒时：远端有更新提交，界面给 Pull 入口 */
  remoteAhead?: boolean;
  commitId?: string;
  /** 超过 100MB 未纳入备份的技能目录名 */
  excludedSkills?: string[];
}

export interface SyncHistoryItem {
  sha: string;
  /** ISO 8601 */
  time: string;
  changedSkills: string[];
  changedSkillCount: number;
  /** 说明（提交主题） */
  note: string;
  /** 提交正文（协议 trailer 已剔除） */
  summary: string;
  author: string;
}

export interface SyncHistoryResult {
  items: SyncHistoryItem[];
}

export interface SyncVersionDetailRequest {
  sha: string;
}

export interface SyncSkillChangeView {
  dirName: string;
  /** 当前库中的技能名（技能已删除时为 null，界面退回目录名） */
  name: string | null;
  added: string[];
  modified: string[];
  removed: string[];
  reportChanged: boolean;
}

export interface SyncVersionDetailResult {
  sha: string;
  shortSha: string;
  time: string;
  author: string;
  note: string;
  summary: string;
  changedSkills: SyncSkillChangeView[];
  changedFileCount: number;
}

export interface SyncRestoreRequest {
  sha: string;
  /** 必须显式为 true（恢复前确认弹层） */
  confirm: boolean;
}

export interface SyncRestoreResult {
  status: 'restored';
  sha: string;
  scope: 'library';
  changedSkills: string[];
  /** 恢复前的可回退快照 ref */
  snapshotRef: string | null;
  message: string;
}
/* ────────────────────────── T15：新对话与文件区 ────────────────────────── */

/** 会话入口：空白对话 / 创建 / 改进 / 检查（评测）。 */
export type ConversationMode = 'blank' | 'create' | 'improve' | 'evaluate';

/** 左侧会话列表项（ui.md：当前会话可区分、可滚动）。 */
export interface ConversationListItem {
  id: string;
  title: string;
  /** queued / running / cancelling / done / failed / cancelled */
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  workflow: 'create' | 'improve' | 'evaluate' | null;
  /** 改进/检查会话的目标技能（用于列表与页头说明） */
  targetSkillId: string | null;
  targetSkillName: string | null;
  running: boolean;
  error: { code: string; detail: string } | null;
  lastMessagePreview: string | null;
}

export interface ConversationListResult {
  items: ConversationListItem[];
}

/** 对话消息（已脱敏；工具调用只给摘要，不含文件正文）。 */
export interface ConversationMessageView {
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  status: 'streaming' | 'complete' | 'aborted' | 'failed';
  toolCalls: Array<{ id: string; name: string; summary: string; isError: boolean }>;
  /** 本轮文件净改动，只挂在该轮最后一条 assistant 消息上。 */
  fileChanges: ConversationFileChangeView[];
  changeRunId?: string;
  errorCode?: string;
  usage: { input: number; output: number; totalTokens: number; cost: number } | null;
}

export interface ConversationFileChangeView {
  relPath: string;
  status: 'added' | 'modified' | 'removed';
  added: number | null;
  removed: number | null;
}

export interface ConversationFileChangeResult {
  before: { exists: boolean; content: string | null; reason: ConversationFileReason | null };
  after: { exists: boolean; content: string | null; reason: ConversationFileReason | null };
}

/** 会话内生成文件（右侧文件区入口）。 */
export interface ConversationFileView {
  relPath: string;
  bytes: number | null;
  exists: boolean;
  /** 最近一次写入时间（ISO 8601） */
  at: string;
}

/** skill-doctor 结果：以文本打开，不设独立报告页（prd.md §5.8）。 */
export interface ConversationReportView {
  skillId: string;
  /** 展示名（reports/<技能名>_review_<时间戳>.md） */
  fileName: string;
  relPath: string;
  absolutePath: string;
  exists: boolean;
  text: string | null;
}

export interface ConversationRunSummary {
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  totalTokens: number | null;
  modelId: string | null;
}

/** 会话详情（消息 / 文件 / 运行状态 / 模型就绪状态）。 */
export interface ConversationView {
  sessionId: string;
  title: string;
  status: string;
  workflow: 'create' | 'improve' | 'evaluate' | null;
  targetSkillId: string | null;
  targetSkillName: string | null;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  /** 授权目录仍存在且 Pi 会话可读 → 可以继续对话 */
  canContinue: boolean;
  messages: ConversationMessageView[];
  files: ConversationFileView[];
  report: ConversationReportView | null;
  /** 预填但尚未发送的提示词（重启后仍可恢复） */
  draftPrompt: string | null;
  providerId: string | null;
  modelId: string | null;
  modelConfigured: boolean;
  modelGuidance: string | null;
  /** 本会话生效的推理强度（null = 当前模型不支持推理） */
  thinkingLevel: ThinkingLevel | null;
  /** 当前模型可选的推理强度（不支持推理时为空数组） */
  thinkingLevels: ThinkingLevel[];
  error: { code: string; detail: string } | null;
  lastRun: ConversationRunSummary | null;
}

export interface ConversationGetRequest {
  sessionId: string;
}

/** 建会话并预填提示词；**不启动运行**（用户点「发送」后才执行）。 */
export interface ConversationCreateRequest {
  mode: ConversationMode;
  /** improve / evaluate：目标技能 */
  targetSkillId?: string;
  /** create：目标技能目录名（未提供时按会话工作区建空白会话） */
  targetName?: string;
}

/** 聊天页快捷入口的提示词模板（只取文本，不建会话、不启动运行）。 */
export interface ConversationPromptRequest {
  mode: Exclude<ConversationMode, 'blank'>;
}

export interface ConversationPromptResult {
  prompt: string;
}

/** 工作台 Agent 自带的 Skill；与中心库 Skill 列表无关。 */
export interface ConversationSkillsResult {
  items: { name: string; description: string }[];
}

export interface ConversationCreateResult {
  mode: ConversationMode;
  /** 建会话失败时为 null（error 说明原因；界面显示引导而不是空会话） */
  sessionId: string | null;
  /** 可编辑的预填提示词（用户可继续修改） */
  prompt: string;
  targetSkillId: string | null;
  targetSkillName: string | null;
  dirName: string | null;
  /** 入口不可用时的可读原因（如未配置模型），界面据此显示引导而不崩溃 */
  error?: ConversationEntryError;
}

/** 会话入口/发送的引导型失败（业务分支而非协议错误）。 */
export interface ConversationEntryError {
  /** NO_MODEL_CONFIGURED / TARGET_INVALID / NAME_CONFLICT / SKILL_NOT_FOUND … */
  code: string;
  detail: string;
  /** 界面可据此提供「去设置」等出口 */
  action: 'settings' | 'models' | null;
}

export interface ConversationSendRequest {
  sessionId: string;
  text: string;
  /** DSH composer: plain Enter queues, Ctrl/Cmd+Enter steers while running. */
  mode?: 'queue' | 'steer';
  /** 快捷入口在发送时才绑定流程；没有快捷入口时由 Agent 判断自然语言意图。 */
  workflowIntent?: Exclude<ConversationMode, 'blank'>;
}

/** 发送后立即返回；运行进度经 conversation:event 推送。 */
export interface ConversationSendResult {
  sessionId: string;
  accepted: boolean;
  /** queued：已入队（工作流运行中）；新建运行号可能尚未分配，故可空 */
  status: string;
  /** 未启动的可读原因（如未配置模型），界面据此显示引导 */
  error?: ConversationEntryError;
}

export interface ConversationCancelRequest {
  sessionId: string;
}

export interface ConversationCancelResult {
  sessionId: string;
  canceled: boolean;
}

/** 归档会话：界面叫「归档」，行为是删除会话记录（不可恢复）。 */
export interface ConversationDeleteRequest {
  sessionId: string;
}

export interface ConversationDeleteResult {
  sessionId: string;
  deleted: boolean;
}

export interface ConversationSetModelRequest {
  sessionId: string;
  modelId: string;
}

export interface ConversationSetModelResult {
  sessionId: string;
  modelId: string;
}

/** 会话级推理强度：只影响本会话，不写回供应商的全局模型选择。 */
export interface ConversationSetThinkingLevelRequest {
  sessionId: string;
  thinkingLevel: ThinkingLevel;
}

export interface ConversationSetThinkingLevelResult {
  sessionId: string;
  thinkingLevel: ThinkingLevel;
}

export interface ConversationReadFileRequest {
  sessionId: string;
  /** 相对会话授权目录的路径（'/' 分隔；拒绝绝对路径与 ..） */
  relPath: string;
}

export interface ConversationReadChangeRequest extends ConversationReadFileRequest {
  runId: string;
}

export type ConversationFileReason = 'MISSING' | 'BINARY' | 'TOO_LARGE' | 'NOT_A_FILE';

/** 只读文件查看所需的文本或二进制内容；不提供编辑权限。 */
export interface ConversationPreviewFileResult {
  relPath: string;
  absolutePath: string;
  size: number;
  content: string | null;
  base64: string | null;
  mediaType: string | null;
  reason: ConversationFileReason | null;
}

/**
 * 推理强度（界面与 IPC 的唯一真相）。
 *
 * 取值是 Pi `thinkingLevel` 全集的子集：不提供 off（界面不出现“关闭推理”），
 * 也不暴露 minimal/medium/xhigh 这些中间档。某模型可用的档位由 Pi 厂商目录声明裁剪，
 * 见 `backend/src/domain/agent/model-meta.ts`。
 */
export type ThinkingLevel = 'low' | 'high' | 'max';

/** 三档固定顺序（由弱到强）：取默认档与渲染顺序都用它。 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['low', 'high', 'max'];

/** 输入区模型菜单：只列当前生效供应商已添加的模型。 */
export interface ProviderModelsResult {
  providerId: string | null;
  providerName: string | null;
  models: string[];
  activeModelId: string | null;
  /** 当前模型上次用的推理强度（新会话沿用；与 activeModelId 成对，已按该模型能力归一） */
  activeThinkingLevel: ThinkingLevel | null;
  /** 模型 ID → 该模型可选的推理强度（不支持推理的模型为空数组） */
  modelThinkingLevels: Record<string, ThinkingLevel[]>;
  /** 供应商 + 模型 + 凭据都就绪才可运行 */
  runnable: boolean;
  guidance: string | null;
}

/** 菜单末尾「添加模型」：去重后加入当前（或指定）供应商，随即可以选用。 */
export interface ProvidersAddModelRequest {
  providerId?: string;
  modelId: string;
}

/**
 * 主进程 → 渲染层的对话事件（`conversation:event`）。
 * 与后端 AgentEvent 同形；这里单独声明是为了让渲染层不依赖领域模块。
 */
export type ConversationEvent =
  | { type: 'status'; sessionId: string; runId: string | null; status: string; at: string }
  | {
      type: 'message';
      sessionId: string;
      runId: string | null;
      messageId: string;
      role: 'user' | 'assistant';
      delta?: string;
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
      usage: { input: number; output: number; totalTokens: number; cost: number };
      durationMs: number;
      at: string;
    }
  | { type: 'file'; sessionId: string; runId: string; relPath: string; bytes: number | null; at: string }
  | {
      type: 'error';
      sessionId: string;
      runId: string | null;
      code: string;
      detail: string;
      retryable?: boolean;
      at: string;
    }
  | { type: 'done'; sessionId: string; runId: string; status: string; at: string };

/** 推送通道名（invoke 通道清单之外的单向事件）。 */
export const CONVERSATION_EVENT_CHANNEL = 'conversation:event';

/** preload 只转发白名单事件类型（渲染层拿到的事件一定是可渲染的）。 */
export const CONVERSATION_EVENT_TYPES = [
  'status',
  'message',
  'tool',
  'usage',
  'file',
  'error',
  'done',
] as const;

export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];

/* ────────────────────────── 应用自更新（GitHub Releases + electron-updater） ────────────────────────── */

/** 下载进度（electron-updater download-progress 事件同形）。 */
export interface AppUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

/**
 * 应用自更新状态快照（设置页「检查更新」区域按此渲染）。
 * unsupported：未打包（dev/uat）或安装包未携带更新配置——不提供检查入口，只展示当前版本。
 */
export interface AppUpdateState {
  status: 'unsupported' | 'idle' | 'checking' | 'downloading' | 'downloaded' | 'up-to-date' | 'error';
  currentVersion: string;
  /** 检查到的新版本号 */
  availableVersion?: string;
  progress?: AppUpdateProgress;
  /** 检查/下载失败原因（失败只存在状态里由界面展示，不弹窗打断） */
  error?: string;
  /** 最近一次检查时间（ISO） */
  checkedAt?: string;
}

/** 推送通道：更新状态变化（update:event），payload 即完整快照。 */
export const UPDATE_EVENT_CHANNEL = 'update:event';

/* ────────────────────────── 错误与信封 ────────────────────────── */

/** 错误码；渲染层只做展示与分支，不据此生成路径或命令。 */
export const IPC_ERROR_CODES = [
  'BAD_REQUEST',
  'UNKNOWN_CHANNEL',
  'NOT_IMPLEMENTED',
  'UNTRUSTED_SENDER',
  'INTERNAL_ERROR',
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

export interface IpcError {
  code: IpcErrorCode;
  detail?: string;
  retryable?: boolean;
}

export type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: IpcError };

/** 已实现命令。request 为 undefined 表示不接受参数。 */
export interface IpcCommands {
  'app:ping': { request: undefined; response: AppPingResult };
  'app:info': { request: undefined; response: AppInfoResult };
  'app:getInitialState': { request: undefined; response: InitialStateResult };
  'app:pickDirectory': { request: { title?: string; defaultPath?: string }; response: PickDirectoryResult };
  'app:pickFile': { request: { title?: string; defaultPath?: string }; response: PickFileResult };

  'firstRun:scan': { request: undefined; response: FirstRunScanResult };
  'firstRun:import': { request: FirstRunImportRequest; response: FirstRunImportResult };
  'firstRun:complete': { request: undefined; response: FirstRunCompleteResult };

  'library:getOverview': { request: undefined; response: LibraryOverview };
  'library:getRecentActivity': { request: undefined; response: RecentActivityResult };
  'library:changeDirectory': { request: LibraryChangeDirectoryRequest; response: LibraryChangeDirectoryResult };
  'library:openFolder': { request: undefined; response: LibraryOpenFolderResult };

  'agents:list': { request: undefined; response: AgentsResult };
  'agents:redetect': { request: undefined; response: AgentsResult };
  'agents:setEnabled': { request: AgentsSetEnabledRequest; response: AgentsResult };
  'agents:updatePath': { request: AgentsUpdatePathRequest; response: AgentsResult };
  'agents:addCustom': { request: AgentsAddCustomRequest; response: AgentsResult };

  /* ---- T13：Agents 页（实际目录扫描 / 状态灯 / 灰灯入库） ---- */
  'agents:listSkills': { request: AgentsSkillsRequest; response: AgentsSkillListResult };
  'agents:resolveConflict': { request: AgentsResolveConflictRequest; response: LibrarySyncItem };
  'agents:rescan': { request: AgentsSkillsRequest; response: AgentsSkillListResult };
  'agents:adopt': { request: AgentsAdoptRequest; response: AgentsAdoptResult };
  'agents:removeSkill': { request: AgentsRemoveSkillRequest; response: AgentsRemoveSkillResult };
  'agents:openFolder': { request: AgentsSkillsRequest; response: AgentsOpenFolderResult };

  'providers:list': { request: undefined; response: ProvidersResult };
  'providers:add': { request: ProvidersAddRequest; response: ProvidersResult };
  'providers:setActive': { request: ProvidersSetActiveRequest; response: ProvidersResult };
  'providers:saveKey': { request: ProvidersSaveKeyRequest; response: ProvidersResult };
  'providers:remove': { request: ProvidersRemoveRequest; response: ProvidersResult };

  /* ---- T11：Skills 中心库与技能详情 ---- */
  'library:list': { request: LibraryListRequest; response: LibraryListResult };
  'library:facets': { request: undefined; response: LibraryFacetsResult };
  'library:checkUpdates': { request: undefined; response: { checked: true } };
  'library:detail': { request: LibraryDetailRequest; response: LibraryDetailResult };
  'library:readFile': { request: LibraryReadFileRequest; response: LibraryReadFileResult };
  'library:writeFile': { request: LibraryWriteFileRequest; response: LibraryWriteFileResult };
  'library:setGroups': { request: LibraryGroupsRequest; response: LibraryGroupsResult };
  'library:batchGroups': { request: LibraryBatchGroupsRequest; response: LibraryBatchGroupsResult };
  'library:planSyncToAgents': { request: LibrarySyncPlanRequest; response: LibrarySyncPlanResult };
  'library:syncDiff': { request: LibrarySyncDiffRequest; response: LibrarySyncDiffResult };
  'library:updateDiff': { request: LibraryUpdateDiffRequest; response: LibraryUpdateDiffResult };
  'library:applyUpdate': { request: LibraryApplyUpdateRequest; response: LibraryApplyUpdateResult };
  'library:syncToAgents': { request: LibrarySyncRequest; response: LibrarySyncResult };
  'library:unsyncFromAgents': { request: LibraryUnsyncRequest; response: LibraryUnsyncResult };
  'library:removePlan': { request: LibraryRemovePlanRequest; response: LibraryRemovePlanResult };
  'library:remove': { request: LibraryRemoveRequest; response: LibraryRemoveResult };
  'library:report': { request: LibraryReportRequest; response: LibraryReportResult };
  'conversation:prefill': { request: ConversationPrefillRequest; response: ConversationPrefillResult };

  /* ---- T12：安装 Skills（市场 / Git / 本地目录 / 压缩包 / 扫描本机） ---- */
  'install:marketLeaderboard': {
    request: InstallMarketLeaderboardRequest;
    response: InstallMarketListResult;
  };
  'install:marketSearch': { request: InstallMarketSearchRequest; response: InstallMarketListResult };
  'install:marketDescription': { request: InstallMarketDescriptionRequest; response: InstallMarketDescriptionResult };
  'install:marketPreview': {
    request: InstallMarketPreviewRequest;
    response: InstallMarketPreviewResult;
  };
  'install:marketReadFile': { request: InstallMarketReadFileRequest; response: InstallMarketReadFileResult };
  'install:marketDiff': { request: InstallMarketDiffRequest; response: InstallScanDiffResult };
  'install:marketResolveConflict': { request: InstallMarketResolveRequest; response: InstallScanResolveResult };
  'install:sourcePreview': { request: InstallSourcePreviewRequest; response: InstallSourcePreviewResult };
  'install:sourceReadFile': { request: InstallSourceReadFileRequest; response: InstallSourceReadFileResult };
  'install:gitParse': { request: InstallGitParseRequest; response: InstallDiscoveryResult };
  'install:localScan': { request: InstallLocalScanRequest; response: InstallDiscoveryResult };
  'install:zipRead': { request: InstallZipReadRequest; response: InstallDiscoveryResult };
  'install:agentScan': { request: undefined; response: InstallDiscoveryResult };
  'install:scanDiff': { request: InstallScanDiffRequest; response: InstallScanDiffResult };
  'install:resolveScanConflict': { request: InstallScanResolveRequest; response: InstallScanResolveResult };
  'install:import': { request: InstallImportRequest; response: InstallImportResult };

  /* ---- T14：备份与同步（全部复用 T04 备份服务，不另写 Git 逻辑） ---- */
  'sync:status': { request: undefined; response: SyncStatusResult };
  'sync:connect': { request: SyncConnectRequest; response: SyncStatusResult };
  'sync:commit': { request: SyncCommitRequest; response: SyncCommitResult };
  'sync:pull': { request: undefined; response: SyncPullResult };
  'sync:resolve': { request: SyncResolveRequest; response: SyncResolveResult };
  'sync:continuePull': { request: undefined; response: SyncPullResult };
  'sync:push': { request: undefined; response: SyncPushResult };
  'sync:history': { request: undefined; response: SyncHistoryResult };
  'sync:versionDetail': { request: SyncVersionDetailRequest; response: SyncVersionDetailResult };
  'sync:restore': { request: SyncRestoreRequest; response: SyncRestoreResult };

  /* ---- CLI 接入指引（主页一次性卡片） ---- */
  'cliSetup:status': { request: undefined; response: CliSetupStatus };
  'cliSetup:install': { request: CliSetupInstallRequest; response: CliSetupInstallResult };
  'cliSetup:dismiss': { request: undefined; response: { card: 'dismissed' } };

  /* ---- 应用自更新（仅打包生产环境真正执行；其余环境返回 unsupported 快照） ---- */
  'updates:state': { request: undefined; response: AppUpdateState };
  'updates:check': { request: undefined; response: AppUpdateState };
  'updates:install': { request: undefined; response: { closing: boolean } };
  /* ---- T15：新对话与文件区 ---- */
  'conversation:list': { request: undefined; response: ConversationListResult };
  'conversation:get': { request: ConversationGetRequest; response: ConversationView };
  'conversation:create': { request: ConversationCreateRequest; response: ConversationCreateResult };
  'conversation:prompt': { request: ConversationPromptRequest; response: ConversationPromptResult };
  'conversation:skills': { request: undefined; response: ConversationSkillsResult };
  'conversation:send': { request: ConversationSendRequest; response: ConversationSendResult };
  'conversation:cancel': { request: ConversationCancelRequest; response: ConversationCancelResult };
  'conversation:delete': { request: ConversationDeleteRequest; response: ConversationDeleteResult };
  'conversation:setModel': { request: ConversationSetModelRequest; response: ConversationSetModelResult };
  'conversation:setThinkingLevel': {
    request: ConversationSetThinkingLevelRequest;
    response: ConversationSetThinkingLevelResult;
  };
  'conversation:previewFile': { request: ConversationReadFileRequest; response: ConversationPreviewFileResult };
  'conversation:fileChange': { request: ConversationReadChangeRequest; response: ConversationFileChangeResult };
  'conversation:showFile': { request: ConversationReadFileRequest; response: { opened: boolean } };
  'conversation:showReport': { request: { skillId: string }; response: { opened: boolean } };
  'providers:models': { request: undefined; response: ProviderModelsResult };
  'providers:addModel': { request: ProvidersAddModelRequest; response: ProviderModelsResult };

  /* ---- 后续任务占位（契约细化在对应任务，本轮仅声明形状与权限边界） ---- */
  'settings:get': { request: undefined; response: unknown };
  'settings:update': { request: { patch: Record<string, unknown> }; response: unknown };
  'library:rescan': { request: undefined; response: { total: number; added: number; changed: number; missing: number; restored: number } };
  'skill:get': { request: { skillId: string }; response: unknown };
  'skill:saveFile': { request: { skillId: string; filePath: string; content: string }; response: unknown };
  'install:discover': { request: { source: string; input?: string }; response: unknown };
  'market:leaderboard': { request: undefined; response: unknown };
  'deploy:adopt': { request: { agentId: string; skillName: string }; response: unknown };
  'backup:status': { request: undefined; response: unknown };
  'backup:pull': { request: undefined; response: unknown };
  'backup:push': { request: undefined; response: unknown };
}

export type IpcChannelName = keyof IpcCommands;
export type IpcRequestOf<K extends IpcChannelName> = IpcCommands[K]['request'];
export type IpcResultOf<K extends IpcChannelName> = IpcResponse<IpcCommands[K]['response']>;

/** 唯一通道清单：preload 白名单与主进程路由都以此为源。 */
export const IPC_CHANNELS = [
  'app:ping',
  'app:info',
  'app:getInitialState',
  'app:pickDirectory',
  'app:pickFile',
  'firstRun:scan',
  'firstRun:import',
  'firstRun:complete',
  'library:getOverview',
  'library:getRecentActivity',
  'library:changeDirectory',
  'library:openFolder',
  'library:rescan',
  'agents:list',
  'agents:redetect',
  'agents:setEnabled',
  'agents:updatePath',
  'agents:addCustom',
  'agents:listSkills',
  'agents:resolveConflict',
  'agents:rescan',
  'agents:adopt',
  'agents:removeSkill',
  'agents:openFolder',
  'providers:list',
  'providers:add',
  'providers:setActive',
  'providers:saveKey',
  'providers:remove',
  'library:list',
  'library:facets',
  'library:checkUpdates',
  'library:detail',
  'library:readFile',
  'library:writeFile',
  'library:setGroups',
  'library:batchGroups',
  'library:planSyncToAgents',
  'library:syncDiff',
  'library:updateDiff',
  'library:applyUpdate',
  'library:syncToAgents',
  'library:unsyncFromAgents',
  'library:removePlan',
  'library:remove',
  'library:report',
  'conversation:prefill',
  'install:marketLeaderboard',
  'install:marketSearch',
  'install:marketDescription',
  'install:marketPreview',
  'install:marketReadFile',
  'install:marketDiff',
  'install:marketResolveConflict',
  'install:sourcePreview',
  'install:sourceReadFile',
  'install:gitParse',
  'install:localScan',
  'install:zipRead',
  'install:agentScan',
  'install:scanDiff',
  'install:resolveScanConflict',
  'install:import',
  'conversation:list',
  'conversation:get',
  'conversation:create',
  'conversation:prompt',
  'conversation:skills',
  'conversation:send',
  'conversation:cancel',
  'conversation:delete',
  'conversation:setModel',
  'conversation:setThinkingLevel',
  'conversation:previewFile',
  'conversation:fileChange',
  'conversation:showFile',
  'conversation:showReport',
  'providers:models',
  'providers:addModel',
  'settings:get',
  'settings:update',
  'skill:get',
  'skill:saveFile',
  'install:discover',
  'market:leaderboard',
  'deploy:adopt',
  'sync:status',
  'sync:connect',
  'sync:commit',
  'sync:pull',
  'sync:resolve',
  'sync:continuePull',
  'sync:push',
  'sync:history',
  'sync:versionDetail',
  'sync:restore',
  'cliSetup:status',
  'cliSetup:install',
  'cliSetup:dismiss',
  'updates:state',
  'updates:check',
  'updates:install',
] as const satisfies readonly IpcChannelName[];

/** 已实现命令（其余按占位返回 NOT_IMPLEMENTED）。 */
export const IMPLEMENTED_CHANNELS = [
  'app:ping',
  'app:info',
  'app:getInitialState',
  'app:pickDirectory',
  'app:pickFile',
  'firstRun:scan',
  'firstRun:import',
  'firstRun:complete',
  'library:getOverview',
  'library:getRecentActivity',
  'library:changeDirectory',
  'library:openFolder',
  'library:rescan',
  'agents:list',
  'agents:redetect',
  'agents:setEnabled',
  'agents:updatePath',
  'agents:addCustom',
  'agents:listSkills',
  'agents:resolveConflict',
  'agents:rescan',
  'agents:adopt',
  'agents:removeSkill',
  'agents:openFolder',
  'providers:list',
  'providers:add',
  'providers:setActive',
  'providers:saveKey',
  'providers:remove',
  'library:list',
  'library:facets',
  'library:checkUpdates',
  'library:detail',
  'library:readFile',
  'library:writeFile',
  'library:setGroups',
  'library:batchGroups',
  'library:planSyncToAgents',
  'library:syncDiff',
  'library:updateDiff',
  'library:applyUpdate',
  'library:syncToAgents',
  'library:unsyncFromAgents',
  'library:removePlan',
  'library:remove',
  'library:report',
  'conversation:prefill',
  'install:marketLeaderboard',
  'install:marketSearch',
  'install:marketDescription',
  'install:marketPreview',
  'install:marketReadFile',
  'install:marketDiff',
  'install:marketResolveConflict',
  'install:sourcePreview',
  'install:sourceReadFile',
  'install:gitParse',
  'install:localScan',
  'install:zipRead',
  'install:agentScan',
  'install:scanDiff',
  'install:resolveScanConflict',
  'install:import',
  'sync:status',
  'sync:connect',
  'sync:commit',
  'sync:pull',
  'sync:resolve',
  'sync:continuePull',
  'sync:push',
  'sync:history',
  'sync:versionDetail',
  'sync:restore',
  'cliSetup:status',
  'cliSetup:install',
  'cliSetup:dismiss',
  'updates:state',
  'updates:check',
  'updates:install',
  'conversation:list',
  'conversation:get',
  'conversation:create',
  'conversation:prompt',
  'conversation:skills',
  'conversation:send',
  'conversation:cancel',
  'conversation:delete',
  'conversation:setModel',
  'conversation:setThinkingLevel',
  'conversation:previewFile',
  'conversation:fileChange',
  'conversation:showFile',
  'conversation:showReport',
  'providers:models',
  'providers:addModel',
] as const satisfies readonly IpcChannelName[];

export type ImplementedChannelName = (typeof IMPLEMENTED_CHANNELS)[number];

/**
 * 主进程处理器签名：每个已实现通道的请求/响应强类型绑定，
 * 放在共享契约里，保证 IPC 处理器与渲染层调用不可能类型漂移。
 */
export type IpcHandlers = {
  [K in ImplementedChannelName]: (
    payload: IpcRequestOf<K>,
  ) => IpcCommands[K]['response'] | Promise<IpcCommands[K]['response']>;
};

/** 不接受参数的通道（payload 必须省略或空对象）。 */
export const NO_ARG_CHANNELS = [
  'app:ping',
  'app:info',
  'app:getInitialState',
  'firstRun:scan',
  'firstRun:complete',
  'library:getOverview',
  'library:getRecentActivity',
  'library:openFolder',
  'agents:list',
  'agents:redetect',
  'providers:list',
  'settings:get',
  'library:facets',
  'library:checkUpdates',
  'install:agentScan',
  'library:rescan',
  'market:leaderboard',
  'agents:rescan',
  'sync:status',
  'sync:pull',
  'sync:continuePull',
  'sync:push',
  'sync:history',
  'cliSetup:status',
  'cliSetup:dismiss',
  'updates:state',
  'updates:check',
  'updates:install',
  'conversation:list',
  // 聊天输入区 `/` 候选清单：契约里 request 就是 undefined（ipc.ts 上方 ConversationSkillsResult）
  'conversation:skills',
  'providers:models',
] as const satisfies readonly IpcChannelName[];

export function isIpcChannelName(value: string): value is IpcChannelName {
  return (IPC_CHANNELS as readonly string[]).includes(value);
}

/** preload 暴露给渲染层的命名空间（contextBridge）。 */
export interface SkpBridge {
  readonly channels: readonly string[];
  invoke<K extends IpcChannelName>(channel: K, payload?: IpcRequestOf<K>): Promise<IpcResultOf<K>>;
  ping(): Promise<IpcResultOf<'app:ping'>>;
  info(): Promise<IpcResultOf<'app:info'>>;
  /**
   * 订阅对话事件（T15：流式增量、工具摘要、文件、状态）。
   * 只转发白名单事件类型；返回取消订阅函数。
   */
  onConversationEvent(listener: (event: ConversationEvent) => void): () => void;
  /** 订阅应用自更新状态推送（update:event，payload 为完整快照）。 */
  onUpdateState(listener: (state: AppUpdateState) => void): () => void;
}
