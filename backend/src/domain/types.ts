/** T01 领域类型定义（prd.md M1 / tec.md §5.1、§6）。 */

/** Group（技能标签）名长度上限：标签是短文本，不允许换行。 */
export const MAX_GROUP_LENGTH = 40;

/** 技能名称来源：frontmatter 的 name 字段，或回退的目录名。 */
export type SkillNameSource = 'frontmatter' | 'dirname';

/** 技能来源类型（prd.md 5.2 / T02）：scan = T01 库目录直接扫描入库；market/conversation 为 T05/T07 占位。 */
export type SkillSourceType =
  | 'scan'
  | 'local-dir'
  | 'git'
  | 'zip'
  | 'machine-scan'
  | 'agent-dir'
  | 'market'
  | 'conversation'
  | `agent:${string}`;

/** 技能来源（prd.md 5.2；T01 只有 scan，其余类型由 T02/T05/T07 填充）。 */
export interface SkillSourceInfo {
  /** 来源类型（SkillSourceType 之一；类型上放宽为 string 以兼容旧元数据） */
  type: string;
  /** 来源 value：URL 或本机原始目录；绝对路径在 Git 备份提交前抽离。 */
  origin?: string;
  /** 入库时间（ISO 8601） */
  importedAt: string;
  /**
   * T02：该技能在来源中的相对路径/目录名（'.' 表示来源根本身）。
   * 来源更新按此定位上游 Skill；旧元数据缺失时无法自动检查。
   */
  sourceRelPath?: string;
  /** 最近一次成功从该来源入库的内容哈希；不随中心库重扫或编辑改变。 */
  sourceHash?: string;
  /** Git 来源选择的分支；缺省为远端默认分支。 */
  sourceBranch?: string;
  /** 最近一次应用的 Git commit，仅作来源记录，更新判定仍按内容哈希。 */
  sourceRevision?: string;
}

/** 同步配置：该技能应部署到哪些 Agent（意图，随库进 Git；真实链接状态由 T03 记录）。 */
export interface SkillSyncConfig {
  agents: string[];
}

/** 每技能一份的元数据文件（统一收在库根 sync/ 下，2026-11-03 前为 skills/.meta/）真身。 */
export interface SkillMetadataFile {
  schemaVersion: number;
  skillId: string;
  dirName: string;
  /**
   * 技能相对 skills 根的位置（'/' 分隔，如 `lark/lark-crawler`；平铺 = dirName）。
   * 支持用户手动把技能挪进一层子目录；缺失/非法时按 dirName 平铺处理（旧元数据兼容）。
   */
  relPath?: string;
  name: string;
  nameSource: SkillNameSource;
  description: string;
  groups: string[];
  source: SkillSourceInfo;
  sync: SkillSyncConfig;
  contentHash: string | null;
  contentHashAt: string | null;
  /**
   * T02：技能内容总字节数（按内容哈希同款忽略清单统计；供 T04 的 100MB 备份排除用）。
   * 旧元数据缺失时由重扫回填。
   */
  sizeBytes?: number | null;
  addedAt: string;
  /** 内容/名称最后变化时间（随元数据持久，索引重建前后一致） */
  updatedAt: string;
}

/** 库级元数据（<库根>/library.json）：schema 版本标记。 */
export interface LibraryMetadataFile {
  schemaVersion: number;
}

/** 中心库列表项（listSkills 返回）。 */
export interface SkillSummary {
  skillId: string;
  dirName: string;
  /** 技能相对 skills 根的位置（'/' 分隔；平铺 = dirName）。定位库内技能目录一律用它 */
  relPath: string;
  name: string;
  description: string;
  nameSource: SkillNameSource;
  /** true = frontmatter 缺 name，名称回退目录名（PRD 5.1「缺少 name」提示） */
  missingName: boolean;
  groups: string[];
  source: SkillSourceInfo | null;
  /**
   * 部署摘要（T03 起叠加真实链接状态）：
   *  - 未挂部署探针时 = 同步配置里的意图（T01/T02 行为保持不变）；
   *  - 挂上探针后 = 意图 ∩ 实际验证通过的链接（lstat + readlink 校验）。
   */
  deployedAgents: string[];
  /** T03：本机可执行的有效意图（意图 ∩ 启用 ∩ 已安装）；用于「已配置、未执行」判定 */
  configuredAgents?: string[];
  /** T03：意图在而链接缺失 → true（UI 显示「已配置、未执行」，不自动部署） */
  configuredNotDeployed?: boolean;
  /** 技能目录被外部删除/改名 → true，元数据保留（PRD 6.3） */
  missing: boolean;
  missingSince: string | null;
  addedAt: string;
  updatedAt: string;
}

/** 文件树节点（按需遍历磁盘构建，不读文件内容）。 */
export interface FileTreeNode {
  name: string;
  /** 相对技能目录的路径，'.' 表示根 */
  relPath: string;
  type: 'file' | 'dir';
  /** 文件字节数；目录为直接子项之和（仅统计，不读内容） */
  size: number;
  children?: FileTreeNode[];
}

/** 技能详情（getSkillDetail 返回）。 */
export interface SkillDetail extends SkillSummary {
  contentHash: string | null;
  /** T02：内容总字节数（旧元数据/已丢失时为 null） */
  sizeBytes: number | null;
  /** missing 时为 null */
  fileTree: FileTreeNode | null;
}

/** 近期动态事件类型（PRD 5.1：创建/导入/内容变更/部署状态变化；查看与评测不产生事件）。 */
export type ActivityType = 'created' | 'imported' | 'content-changed' | 'deploy-status';

/** 单条近期动态事件（持久存 DATA_DIR，与索引 DB 分开；按 skillId 聚合取最新）。 */
export interface ActivityEvent {
  eventId: string;
  skillId: string;
  type: ActivityType;
  /** 真实发生时间（ISO 8601）；索引重建不产生新事件、不改此时间 */
  occurredAt: string;
  detail: string;
}

/** 一次重扫的结果摘要。 */
export interface RescanResult {
  /** 库中技能总数（含已丢失） */
  total: number;
  /** 本次新登记（新建元数据）的数量 */
  added: number;
  /** 内容哈希发生变化的数量 */
  changed: number;
  /** 已丢失数量 */
  missing: number;
  /** 恢复（丢失→正常）数量 */
  restored: number;
  /** 本次产生的事件 */
  events: ActivityEvent[];
}

/**
 * T03：部署状态探针。由部署服务实现并注入库服务（`setDeploymentProbe`）。
 * 库服务本身不 import 部署服务（避免循环依赖），也不碰 Agent 目录；
 * 未注入时 listSkills 的 deployedAgents 保持 T01 语义（= 同步意图）。
 */
export interface DeploymentStatusProbe {
  /**
   * 校验某技能的实际部署状态。
   * 入参的 `deployedAgents` 此时仍是元数据里的同步意图（索引原值），实现据此判断。
   */
  verify(skill: Pick<SkillSummary, 'skillId' | 'dirName' | 'deployedAgents'>): {
    deployed: string[];
    configured: string[];
  };
}
