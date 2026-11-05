/**
 * 来源发现（prd.md 5.7 / tec.md §5.7：各入口先展示发现结果，用户多选后导入）。
 * 纯读操作：不写库、不写元数据、不发事件；git/zip 的解包只落 TEMP_DIR 会话目录。
 * 复用 T01 scanner 的技能判定（SKILL.md/skill.md）与 path-guard 名称清洗。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isIgnoredDirName, isIgnoredFileName } from '../content-hash';
import { isSkillDir, readSkillMd } from '../frontmatter';
import { MAX_SKILL_DEPTH, sanitizeName } from '../path-guard';
import type { DiscoveredSkill, SourceType } from './types';

/** 可执行脚本扩展（用于识别 scripts/ 下的脚本文件）。 */
const EXECUTABLE_EXTS = new Set(['.py', '.sh', '.ps1', '.bat']);

/** 递归收集技能目录的最大深度（git/zip 解包后查找；覆盖 根/包一层/skills 子目录等形态）。 */
const MAX_COLLECT_DEPTH = 4;

type SourceRef = { type: SourceType; origin: string; sourceBranch?: string; sourceRevision?: string };

/**
 * 本地目录发现：目录本身是技能 → 单项；否则枚举子目录。
 * 支持一层 group（`<根>/<group>/<技能名>/`），口径与扫描本机一致：
 * 相对根 ≤ MAX_SKILL_DEPTH 层、父目录自带 SKILL.md 时不再下钻。
 * includeInvalid=true 时列出「既不是技能、其下也没有技能」的目录（isValid=false），
 * 供「全选后逐项失败」的导入语义；group 目录本身不再作为无效项出现。
 *
 * 目录判定**跟随符号链接/联接**（竞品 scanner.rs:132 `!path.is_dir() && !path.is_symlink()`）：
 * 真实 Agent 目录里的技能常以链接形式存在，Dirent 不跟随链接会把它们整批漏掉。
 */
export function discoverInDir(
  dir: string,
  source: SourceRef,
  includeInvalid: boolean,
): DiscoveredSkill[] {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return [];
  if (isSkillDir(root)) {
    return [describeSkillDir(root, '.', source)];
  }
  const items: DiscoveredSkill[] = [];
  collectChildSkills(root, '', 0, includeInvalid, source, items);
  sortItems(items);
  return items;
}

/** 枚举子目录：命中技能即收并停止下钻；否则下钻找嵌套技能，找不到才按无效项处理。 */
function collectChildSkills(
  dir: string,
  rel: string,
  depth: number,
  includeInvalid: boolean,
  source: SourceRef,
  out: DiscoveredSkill[],
): void {
  if (depth >= MAX_SKILL_DEPTH) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (isIgnoredDirName(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const child = path.join(dir, entry.name);
    if (!isDirectoryFollowingLinks(child)) continue;
    const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;

    if (isSkillDir(child)) {
      out.push(describeSkillDir(child, childRel, source));
      continue; // 命中即停：父目录是技能，就不再把子目录当技能
    }

    // 下钻只收有效技能：group 目录下有技能时，它自己不再作为「不是技能目录」出现
    const nested: DiscoveredSkill[] = [];
    collectChildSkills(child, childRel, depth + 1, false, source, nested);
    if (nested.length > 0) {
      out.push(...nested);
      continue;
    }
    if (includeInvalid) out.push(describeSkillDir(child, childRel, source));
  }
}

/** 目录判定跟随链接（等价 Rust `Path::is_dir`，stat 而非 lstat）；断链、普通文件返回 false。 */
function isDirectoryFollowingLinks(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 递归发现（git 克隆 / zip 解包后的根）：收集含 SKILL.md 的目录（含根本身）。
 * 深度 ≤ MAX_COLLECT_DEPTH，跳过忽略目录与符号链接（不跟随链接出解包区）。
 */
export function discoverRecursive(root: string, source: SourceRef): DiscoveredSkill[] {
  const items: DiscoveredSkill[] = [];
  walkCollect(path.resolve(root), '.', 0, source, items);
  sortItems(items);
  return items;
}

function walkCollect(
  dir: string,
  rel: string,
  depth: number,
  source: SourceRef,
  out: DiscoveredSkill[],
): void {
  if (isSkillDir(dir)) out.push(describeSkillDir(dir, rel, source));
  if (depth >= MAX_COLLECT_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (isIgnoredDirName(entry.name)) continue;
    walkCollect(
      path.join(dir, entry.name),
      rel === '.' ? entry.name : `${rel}/${entry.name}`,
      depth + 1,
      source,
      out,
    );
  }
}

/**
 * 描述单个候选目录：名称（frontmatter 优先）、描述、大小、scripts 可执行脚本。
 * 大小与脚本检测使用与内容哈希一致的忽略清单。
 */
export function describeSkillDir(dir: string, relPath: string, source: SourceRef): DiscoveredSkill {
  const valid = isSkillDir(dir);
  const md = valid ? readSkillMd(dir) : null;
  const frontmatterName =
    md?.meta.name != null ? sanitizeName(md.meta.name).trim() : '';
  const useFrontmatter = frontmatterName.length > 0;
  const dirName = path.basename(dir);

  let sizeBytes = 0;
  const executableScripts: string[] = [];
  inspectTree(dir, '.', executableScripts, (n) => {
    sizeBytes += n;
  });

  return {
    path: dir,
    sourceRelPath: relPath,
    dirName,
    name: useFrontmatter ? frontmatterName : dirName,
    nameSource: useFrontmatter ? 'frontmatter' : 'dirname',
    description: md?.meta.description ?? '',
    sizeBytes,
    hasExecutableScripts: executableScripts.length > 0,
    executableScripts,
    isValid: valid,
    invalidReason: valid ? undefined : '不是技能目录（缺少 SKILL.md）',
    source: { type: source.type, origin: source.origin,
      ...(source.sourceBranch ? { sourceBranch: source.sourceBranch } : {}),
      ...(source.sourceRevision ? { sourceRevision: source.sourceRevision } : {}) },
  };
}

/** 遍历目录统计字节数并收集 scripts/ 下的可执行脚本（相对路径）。 */
function inspectTree(
  dir: string,
  rel: string,
  scripts: string[],
  onBytes: (n: number) => void,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (isIgnoredDirName(entry.name) || isIgnoredFileName(entry.name)) continue;
    const relPath = rel === '.' ? entry.name : `${rel}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      inspectTree(full, relPath, scripts, onBytes);
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      onBytes(size);
      if (
        rel.split('/').includes('scripts') &&
        EXECUTABLE_EXTS.has(path.extname(entry.name).toLowerCase())
      ) {
        scripts.push(relPath);
      }
    }
  }
}

function sortItems(items: DiscoveredSkill[]): void {
  items.sort((a, b) =>
    a.sourceRelPath < b.sourceRelPath ? -1 : a.sourceRelPath > b.sourceRelPath ? 1 : 0,
  );
}
