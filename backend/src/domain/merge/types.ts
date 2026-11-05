/**
 * 对象级三方合并的数据模型（tec.md §5.10）。
 *
 * 同步单位是「技能」：每个技能拆成三个可独立判定的组件
 *  1) 内容树（`skills/<目录>/` 的 git tree 哈希）
 *  2) 元数据（Group 按集合处理，同步 Agent 也按集合处理）
 *  3) 评测报告（`reports/<技能名>_review_<时间戳>.md` 的 blob 哈希与文件名）
 * 只有「两边相对 base 都变了且变得不一样」才会把该技能判为冲突；
 * 任何冲突都保留本机版本并记录待决 pin，绝不把 git 行级冲突标记写进 SKILL.md。
 *
 * 纯函数只依赖这里的普通对象，不做 I/O，保证同样输入在任意机器算出同样计划。
 */

/** git 树中的单个 blob 条目（路径相对仓库根或相对技能目录，由调用方约定）。 */
export interface GitTreeEntry {
  mode: string;
  oid: string;
  path: string;
}

/** 元数据中可跨机同步的部分（不含本机绝对路径、不含派生哈希字段）。 */
export interface PortableSourceInfo {
  type: string;
  /** 仅保留可跨机的 origin（URL / 相对标识）；本机绝对路径在提交前抽到 DATA_DIR */
  origin?: string;
  importedAt?: string;
  sourceRelPath?: string;
  sourceHash?: string;
  sourceBranch?: string;
  sourceRevision?: string;
}

export interface PortableSkillMeta {
  schemaVersion: number;
  dirName: string;
  /**
   * 技能相对 skills 根的位置（'/' 分隔，1-2 段；平铺 = dirName）。随元数据进提交树，
   * 树内内容路径 = skills/<relPath>/、元数据 = sync/<dirName>.skill.json（2026-11-03 起库根 sync/）；
   * 历史提交按布局回退：skills/.meta/<dirName>.skill.json → skills/<dirName>.skill.json。
   */
  relPath: string;
  name: string;
  nameSource: 'frontmatter' | 'dirname';
  description: string;
  groups: string[];
  source: PortableSourceInfo | null;
  sync: { agents: string[] };
}

/** 某次提交中的单个技能组件快照。内容缺失（目录不在）时 contentTree = null（T01「已丢失」）。 */
export interface SkillSnapshot {
  skillId: string;
  meta: PortableSkillMeta;
  /** `skills/<dirName>` 的 tree OID；null = 目录已丢失 */
  contentTree: string | null;
  /** 评测报告的 blob OID；null = 无评测报告 */
  reportBlob: string | null;
  /** 评测报告在仓库里的相对路径（`reports/<技能名>_review_<时间戳>.md`）；null = 无评测报告 */
  reportFile: string | null;
}

/** 一次提交对应的库快照（按稳定 Skill ID 索引）。 */
export interface LibrarySnapshot {
  /** 提交 ID；空库为 null */
  commit: string | null;
  skills: Record<string, SkillSnapshot>;
}

export type MergeComponentName = 'content' | 'metadata' | 'report';

export type MergeConflictKind = 'component' | 'both-added' | 'deleted-locally' | 'deleted-remotely';

/** 合并计划中的冲突条目（只描述，不落盘；落盘记录见 PendingConflictInfo）。 */
export interface PlannedConflict {
  skillId: string;
  kind: MergeConflictKind;
  /** 双改冲突里具体哪些组件对不上（kind=component 时非空） */
  components: MergeComponentName[];
  localDirName: string | null;
  remoteDirName: string | null;
}

/** 合并计划中的技能结果。`from` 仅用于摘要，不影响落盘内容。 */
export interface PlannedSkill {
  skillId: string;
  meta: PortableSkillMeta;
  contentTree: string | null;
  reportBlob: string | null;
  /** 结果树里评测报告使用的相对路径（沿用被采纳一侧的文件名） */
  reportFile: string | null;
  from: 'local' | 'remote' | 'merged';
  /** 目录名因与另一技能同名（大小写不敏感）被安全改名 */
  renamedForCollision: boolean;
}

export interface MergePlan {
  skills: Record<string, PlannedSkill>;
  conflicts: PlannedConflict[];
  /** 冲突未解决、本次被 pin 固定为本机版本的技能 */
  stillPending: string[];
  /** 本次从远端采纳的技能（新出现在本机） */
  adoptedFromRemote: string[];
  /** 本次被删除的技能（对端删除生效） */
  removed: string[];
  /** 冲突后保留本机版本的技能 */
  keptLocal: string[];
}

/** 冲突一侧的摘要（备份页展示「本机 / 远端」用）。 */
export interface ConflictSideSummary {
  present: boolean;
  dirName: string | null;
  name: string | null;
  description: string | null;
  groups: string[];
  /** 内容树 OID（摘要标识，不同 = 内容不同） */
  contentTree: string | null;
  reportPresent: boolean;
  /** 相对 base 的文件级变化（'/' 分隔路径） */
  changedFiles: string[];
  addedFiles: string[];
  removedFiles: string[];
  commit: string;
}

/** 待决冲突（DATA_DIR 持久化；含 base/local/remote 三方提交与摘要）。 */
export interface PendingConflictInfo {
  skillId: string;
  dirName: string | null;
  kind: MergeConflictKind;
  components: MergeComponentName[];
  baseCommit: string;
  localCommit: string;
  /** 最近一次拉取看到的远端提交（远端再变时只推进这个指针，不重复生成冲突） */
  remoteCommit: string;
  pinnedAt: string;
  /** 冲突未解决期间远端又发生了变化的最后时间 */
  remoteAdvancedAt: string | null;
  local: ConflictSideSummary;
  remote: ConflictSideSummary;
}

export type ConflictChoice = 'keep-local' | 'take-remote' | 'keep-both';
