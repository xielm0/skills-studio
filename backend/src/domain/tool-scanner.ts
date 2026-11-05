/**
 * 本机扫描器（对应竞品 src-tauri/src/core/scanner.rs 的 scan_local_skills + group_discovered）。
 *
 * 与竞品一致的部分：安装目录判定后扫描 → `stat` 跟随符号链接 → 排除指向中心库的链接 →
 * 已管理路径去重 → 内容哈希 fingerprint → 按内容分组折叠同一技能的多处位置。
 *
 * 与竞品的差异：
 *  1. 扫描目标**不来自代码常量**，而由调用方传入 `targets`（本项目取自 `agents.json`）。
 *     未传入的 Agent 目录不会被访问。另加 `includeSynced` 开关：为真时保留已接管位置并标记
 *     `isManagedLink`（安装页四态要看到「已同步」项，首启扫描保持竞品的排除行为）。
 *  2. 竞品按 adapter 的 `recursive_scan` 逐工具开关递归（只有 hermes 开）；本项目一律递归，
 *     层数由 `MAX_SKILL_DEPTH` 封顶：`skills/a` = 1 层、`skills/group/a` = 2 层。命中即停
 *     （父目录自带 SKILL.md 说明它就是技能，不再下钻）。
 *  3. 嵌套目录里的父目录名（group）随发现记录返回，入库时写成技能标签（`meta.groups`）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashAndSizeSkillDir, isIgnoredDirName, skillContentMtime } from './content-hash';
import { isSkillDir } from './frontmatter';
import { MAX_SKILL_DEPTH, groupOfSkillRelPath } from './path-guard';
import { describeSkillDir as describeForDiscovery } from './sources/discovery';

/** 一个待扫描的目标目录（来自本机配置 `agents.json` 的 Agent 记录）。 */
export interface ScanTarget {
  /** 稳定 id（写入来源标签与去重键） */
  key: string;
  /** 展示名（来源 origin 用它，不落本机绝对路径） */
  label: string;
  /** 该 Agent 的全局 Skills 目录绝对路径 */
  dir: string;
}

export interface DiscoveredToolSkill {
  /** 目标 id（如 codebuddy） */
  tool: string;
  /** 目标显示名（如 CodeBuddy） */
  toolLabel: string;
  /** 技能目录绝对路径（链接形态时为链接路径） */
  path: string;
  /** 相对扫描根的路径（`a` 或 `group/a`） */
  relPath: string;
  /** 嵌套目录的父目录名（`group/a` → `group`）；一层直放时为 null */
  group: string | null;
  name: string;
  nameSource: 'frontmatter' | 'dirname';
  description: string;
  sizeBytes: number;
  /** scripts/ 下的可执行脚本（PRD 5.12：导入前须列出） */
  hasExecutableScripts: boolean;
  executableScripts: string[];
  /** 内容哈希（竞品 fingerprint）：同内容出现在多个 Agent 时用于折叠 */
  fingerprint: string | null;
  /** 该位置已由本工具接管：链接指向中心库，或命中已登记的部署路径（= 已同步） */
  isManagedLink: boolean;
  /** 参与内容比较的文件中最新的 mtime（毫秒） */
  foundAt: number;
}

export interface ToolScanPlan {
  toolsScanned: number;
  skillsFound: number;
  discovered: DiscoveredToolSkill[];
}

export interface ToolSkillGroup {
  name: string;
  fingerprint: string | null;
  /** 同一技能的所有出现位置（竞品 DiscoveredGroup.locations） */
  locations: Array<{ tool: string; toolLabel: string; path: string; relPath: string }>;
  foundAt: number;
}

export interface ToolScanOptions {
  targets: readonly ScanTarget[];
  /** 中心库 skills 目录：指向它的链接视为自家部署，不计入发现（竞品 is_symlink_to_central） */
  centralSkillsDir?: string;
  /** 已被管理的目标路径（竞品 managed_paths），命中则不重复发现 */
  managedPaths?: string[];
  /**
   * 默认 false = 排除已接管的位置（竞品行为，首启扫描用）。
   * true = 仍排除但保留并标记 `isManagedLink`（安装页四态需要看到「已同步」项）。
   */
  includeSynced?: boolean;
}

/** 遍历给定目标扫描本机；未传入的目录不访问。 */
export function scanLocalSkills(opts: ToolScanOptions): ToolScanPlan {
  const managed = new Set((opts.managedPaths ?? []).map(canonicalLossy));
  const discovered: DiscoveredToolSkill[] = [];
  let toolsScanned = 0;

  for (const target of opts.targets) {
    if (!isDirectoryFollowingLinks(target.dir)) continue; // 目录不存在 / 断链：跳过该 Agent
    toolsScanned += 1;
    scanDir(target, target.dir, '', 0, opts, managed, discovered);
  }

  return { toolsScanned, skillsFound: discovered.length, discovered };
}

/** 按内容哈希把同一技能的多处出现折叠成一组（竞品 group_discovered）。 */
export function groupDiscovered(records: readonly DiscoveredToolSkill[]): ToolSkillGroup[] {
  const groups = new Map<string, ToolSkillGroup>();
  for (const rec of records) {
    const key =
      rec.fingerprint != null
        ? `fp:${rec.name}:${rec.fingerprint}`
        : `path:${rec.name}:${rec.path}`;
    let group = groups.get(key);
    if (group == null) {
      group = { name: rec.name, fingerprint: rec.fingerprint, locations: [], foundAt: rec.foundAt };
      groups.set(key, group);
    }
    if (rec.foundAt > group.foundAt) group.foundAt = rec.foundAt;
    group.locations.push({
      tool: rec.tool,
      toolLabel: rec.toolLabel,
      path: rec.path,
      relPath: rec.relPath,
    });
  }
  return [...groups.values()].sort((a, b) => a.name === b.name ? b.foundAt - a.foundAt : a.name < b.name ? -1 : 1);
}

// ────────────────────────── 内部 ──────────────────────────

/** 单个扫描根的子目录（竞品 scan_flat_dir 的递归版本，层数由 MAX_SKILL_DEPTH 封顶）。 */
function scanDir(
  target: ScanTarget,
  root: string,
  rel: string,
  depth: number,
  opts: ToolScanOptions,
  managed: Set<string>,
  out: DiscoveredToolSkill[],
): void {
  // depth 是 root 相对 skills 根的层数；子目录是 depth+1 层，超过上限就不再往下看
  if (depth >= MAX_SKILL_DEPTH) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (isIgnoredDirName(entry.name)) continue;

    const dir = path.join(root, entry.name);
    const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
    // 竞品 scanner.rs:132 `!path.is_dir() && !path.is_symlink()`：stat 跟随链接
    if (!isDirectoryFollowingLinks(dir)) continue;
    const linkedIntoLibrary =
      opts.centralSkillsDir != null && isLinkIntoDir(dir, opts.centralSkillsDir);
    const managedPath = managed.has(canonicalLossy(dir));
    const synced = linkedIntoLibrary || managedPath;

    if (isSkillDir(dir)) {
      // 命中即停：父目录自带 SKILL.md 说明它本身就是技能，不再把子目录当技能（skills don't nest）
      if (synced && opts.includeSynced !== true) continue;
      out.push(
        describeSkillDir(target, dir, childRel, groupOfSkillRelPath(childRel), synced),
      );
      continue;
    }

    // 整个目录已由本工具接管（group 形态）：不再下钻，避免把库内技能重复发现一遍
    if (synced) continue;
    scanDir(target, dir, childRel, depth + 1, opts, managed, out);
  }
}

/** 目录判定跟随链接（等价 Rust Path::is_dir）；断链、普通文件返回 false。 */
function isDirectoryFollowingLinks(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** 链接目标落在中心库内（等价竞品 is_symlink_to_central）。 */
function isLinkIntoDir(target: string, dir: string): boolean {
  let resolved: string;
  let base: string;
  try {
    resolved = fs.realpathSync.native(target);
    base = fs.realpathSync.native(dir);
  } catch {
    return false;
  }
  return resolved === base || resolved.startsWith(base + path.sep);
}

function describeSkillDir(
  target: ScanTarget,
  dir: string,
  relPath: string,
  group: string | null,
  isManagedLink: boolean,
): DiscoveredToolSkill {
  // 复用既有发现器的描述逻辑（名称/描述/大小/可执行脚本），再补竞品需要的 fingerprint 与 mtime
  const base = describeForDiscovery(dir, relPath, {
    type: 'machine-scan',
    origin: target.label,
  });

  let fingerprint: string | null = null;
  try {
    fingerprint = hashAndSizeSkillDir(dir).hash;
  } catch {
    // 读取失败（权限/竞态）不阻断扫描：保留条目，fingerprint 留空
  }

  return {
    tool: target.key,
    toolLabel: target.label,
    path: base.path,
    relPath: base.sourceRelPath,
    group,
    name: base.name,
    nameSource: base.nameSource,
    description: base.description,
    sizeBytes: base.sizeBytes,
    hasExecutableScripts: base.hasExecutableScripts,
    executableScripts: base.executableScripts,
    fingerprint,
    isManagedLink,
    foundAt: skillContentMtime(dir) ?? 0,
  };
}

function canonicalLossy(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

