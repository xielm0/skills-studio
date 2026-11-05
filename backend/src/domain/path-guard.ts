/**
 * Windows 路径安全清洗（tec.md §5.1 / §9.2：任何来自外部的名字落盘前都必须过这一步）。
 * 思路对齐竞品 path_guard.rs（AGENTS.md 允许参考），按本项目 TypeScript 重写。
 */
import * as path from 'node:path';

const MAX_NAME_LEN = 200;
const FALLBACK_NAME = 'unnamed';

/** Windows 文件名非法字符（含两种路径分隔符）。 */
const ILLEGAL_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);

/** Windows 保留设备名，不能单独作为目录名（含扩展名前的基名）。 */
const RESERVED_BASENAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * 清洗单个文件/目录名：
 *  - 剔除 Windows 非法字符与控制字符
 *  - 折叠点序列（`..`、`...` 无法存活）
 *  - 去除首尾点与空白（Windows 忽略尾部点/空格，会造成静默不一致）
 *  - 保留设备名时加 `_` 前缀
 *  - 超长按码点截断到 200
 *  - 全部清洗掉后回退 'unnamed'
 */
export function sanitizeName(input: string): string {
  let out = '';
  for (const ch of input) {
    if (ILLEGAL_CHARS.has(ch) || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) continue;
    out += ch;
  }

  // 折叠连续点，杜绝 `..` 穿越
  let collapsed = '';
  let prevDot = false;
  for (const ch of out) {
    if (ch === '.') {
      if (!prevDot) collapsed += '.';
      prevDot = true;
    } else {
      collapsed += ch;
      prevDot = false;
    }
  }

  let trimmed = collapsed.replace(/^[.\s]+|[.\s]+$/g, '');

  // 按码点截断
  if ([...trimmed].length > MAX_NAME_LEN) {
    trimmed = [...trimmed].slice(0, MAX_NAME_LEN).join('');
  }

  if (trimmed.length === 0) return FALLBACK_NAME;

  const base = trimmed.split('.')[0].toUpperCase();
  if (RESERVED_BASENAMES.has(base)) trimmed = `_${trimmed}`;

  return trimmed;
}

/**
 * 清洗并判定：用于「创建新目录」场景。输入为 `.` / `..`、纯非法字符或清洗后为空
 * 时拒绝（返回 null），否则返回安全名。清洗结果回退 unnamed 的也视为拒绝。
 */
export function validateNewDirName(input: string): string | null {
  if (input === '.' || input === '..') return null;
  if (input.trim().length === 0) return null;
  const cleaned = sanitizeName(input);
  return cleaned === FALLBACK_NAME ? null : cleaned;
}

/**
 * 技能目录相对 skills 根的最大层数：`skills/a` = 1 层，`skills/group/a` = 2 层。
 * 扫描、Agents 页条目名、入库入口共用同一常量，避免各自写死。
 */
export const MAX_SKILL_DEPTH = 2;

/**
 * 校验「相对 skills 根的技能路径」（如 `a`、`group/a`）：
 * 只接受纯相对段、层数 ≤ MAX_SKILL_DEPTH，拒绝空段、`.`/`..`、反斜杠、盘符与绝对路径。
 * 合法时返回规范化后的 `/` 分隔路径，非法返回 null。
 */
export function validateSkillRelPath(input: string): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (value.length === 0 || value.length > MAX_NAME_LEN) return null;
  if (value !== input) return null;
  if (value.includes('\\') || value.startsWith('/')) return null;
  if (path.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return null;
  const segments = value.split('/');
  if (segments.length > MAX_SKILL_DEPTH) return null;
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return null;
    // 段内出现会被清洗掉的字符（`:`、`*` 等）一律拒绝，不做静默改写
    if (sanitizeName(segment) !== segment) return null;
  }
  return segments.join('/');
}

/** 取嵌套技能路径的 group 名（`group/a` → `group`；一层直放 → null）。 */
export function groupOfSkillRelPath(relPath: string): string | null {
  const slash = relPath.indexOf('/');
  return slash > 0 ? relPath.slice(0, slash) : null;
}

/** 规范化路径（解析 `.`/`..` 段，不触碰文件系统）。 */
function normalize(p: string): string {
  return path.normalize(path.resolve(p));
}

/**
 * 校验 target 位于 base 内部（含 base 本身）。写入/删除/复制前必须调用；
 * 无法安全判定时返回 false（调用方按拒绝处理）。
 */
export function isPathSafe(base: string, target: string): boolean {
  const b = normalize(base);
  const t = normalize(target);
  if (t === b) return true;
  return t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** 是否形似本机绝对路径（盘符 / UNC / POSIX 绝对）。 */
function looksLikeLocalPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith('/');
}

/**
 * T04：是否为「本机绝对路径」形态。备份提交前用它把这类来源 origin 抽到
 * DATA_DIR 的本地映射，库内元数据只保留类型与相对标识（tec.md §5.10）。
 */
export function isLocalAbsolutePath(value: string | null | undefined): boolean {
  return typeof value === 'string' && looksLikeLocalPath(value);
}

/**
 * T02：两个来源 origin 是否指向同一位置。本机路径按 Windows 语义大小写不敏感比较；
 * URL 等其他形态按精确字符串比较。
 */
export function sameOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  if (a === b) return true;
  if (looksLikeLocalPath(a) && looksLikeLocalPath(b)) {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }
  return false;
}
