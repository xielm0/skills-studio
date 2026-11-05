/**
 * T02 来源与安装入库的类型定义（prd.md M2/M7、tec.md §5.2/§5.7）。
 * 来源四类：本地目录 / Git 仓库 / 压缩包 / 扫描本机（market、conversation 为 T05/T07 占位）。
 * 发现结果是临时列表，不形成来源记录；来源记录只在入库成功时写入技能元数据。
 */
import type { SkillSourceInfo } from '../types';

/** 非市场来源类型（导入时可实际处理的）。 */
export type SourceType = 'local-dir' | 'git' | 'zip' | 'machine-scan' | 'agent-dir' | 'market' | 'conversation' | `agent:${string}`;

/** 结构化来源错误（tec.md §7.2：code + detail，不只一句话）。 */
export class SourceError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'SourceError';
  }
}

/** 单个发现项（安装页「发现列表」的临时条目；不落任何记录）。 */
export interface DiscoveredSkill {
  /** 源侧（或解包后）技能目录的绝对路径 */
  path: string;
  /** 相对发现根的路径（'/' 分隔；'.' 表示发现根本身） */
  sourceRelPath: string;
  /** 源目录名 */
  dirName: string;
  /** 展示名：frontmatter name（清洗后）或目录名 */
  name: string;
  nameSource: 'frontmatter' | 'dirname';
  description: string;
  /** 内容总字节数（按内容哈希同款忽略清单统计） */
  sizeBytes: number;
  /** scripts/ 下是否含可执行脚本（.py/.sh/.ps1/.bat） */
  hasExecutableScripts: boolean;
  /** 可执行脚本相对路径清单 */
  executableScripts: string[];
  /** 是否为合法技能目录（含 SKILL.md/skill.md） */
  isValid: boolean;
  /** 非法原因（isValid=false 时给出，如「缺少 SKILL.md」） */
  invalidReason?: string;
  /** 入库时将记录的来源 */
  source: { type: SourceType; origin: string; sourceBranch?: string; sourceRevision?: string };
  /** machine-scan：清洗名与库内技能目录名匹配 → true（仅提示；导入仍按内容判定） */
  inLibrary?: boolean;
}

/** 一次发现的结果。 */
export interface DiscoveryResult {
  items: DiscoveredSkill[];
  /** git/zip 解包产生的临时会话目录；导入结束或取消后由 importSkills 清理 */
  sessionDir?: string;
}

/** 统一入库的输入项（DiscoveredSkill 是它的超集，可直接传入）。 */
export interface ImportItem {
  /** 源侧技能目录绝对路径（本地目录、agent 目录，或 git/zip 解包后的临时路径） */
  path: string;
  /** 来源记录（type + origin；sourceRelPath 缺省取 path 的 basename） */
  source: Pick<SkillSourceInfo, 'type' | 'origin'> & { sourceRelPath?: string; sourceBranch?: string; sourceRevision?: string };
  /** Git 预览中的自定义名称；入库时写入暂存副本的 frontmatter。 */
  nameOverride?: string;
  /** 入库时写入技能标签（`meta.groups`）：本机扫描时来自嵌套目录的父目录名。 */
  groups?: string[];
}

export type ImportItemStatus = 'imported' | 'already-in-library' | 'failed';

/** 单项导入结果（PRD 5.7：逐项展示已入库、跳过和失败）。 */
export interface ImportItemResult {
  /** 尝试导入的技能名（frontmatter name 或源目录名） */
  name: string;
  skillId: string | null;
  status: ImportItemStatus;
  /** 失败/跳过原因（人读文案） */
  reason?: string;
  /** 失败结构化错误码 */
  code?: string;
}

export interface ImportOptions {
  /** 本次导入关联的发现会话临时目录（git/zip 解包产物）；导入结束或取消后清理 */
  sessionDir?: string;
  /** 外部中止信号（与 service.abort() 等效） */
  signal?: { aborted: boolean };
  /** 每完成一项回调（进度/取消挂点） */
  onProgress?: (result: ImportItemResult) => void;
}

export interface ImportBatchResult {
  results: ImportItemResult[];
  /** 批次是否被外部中止（true = 存在未处理项，已按 failed/ABORTED 如实返回） */
  aborted: boolean;
}
