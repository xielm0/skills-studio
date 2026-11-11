/**
 * 目录链接的创建 / 判定 / 删除（tec.md §5.5、§8）。
 *
 * 纪律（全部由实测与竞品结论确定，改动前请先看测试 t03）：
 *  - 判定一律用 **lstat**：`stat` 会跟随链接，把 junction 当实体目录，从而误判冲突分支。
 *  - Windows 上 junction 的 `lstat().isSymbolicLink()` 为 true，`readlink` 返回绝对目标；
 *    因此「是链接」与「指向谁」对 symlink / junction 用同一套逻辑。
 *  - 创建顺序：symlink(dir) 优先 → 失败（典型 EPERM：未开开发者模式 / 无权限）再 junction 兜底。
 *    这是**预期路径**，不要「优化」成直接 junction：开发者模式下应得到真正的 symlink。
 *    junction 不需要任何权限，是未开开发者模式用户的兜底；两者都失败则报错，绝不降级为复制。
 *  - 删除一律只删链接本身。Windows 上实测 Node 22.22 的 `unlink` 可直接删除 junction；
 *    某些环境下会报 EPERM/EISDIR，故保留 `rmdir` 兜底，并回报实际使用的方式。
 *    绝不用 `rm(recursive)` 去碰链接路径——那有跟随链接删掉库内真身的风险。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type LinkType = 'symlink' | 'junction';

export type TargetKind = 'missing' | 'link' | 'dir' | 'file' | 'other';

export interface TargetInspection {
  /** 被检查的路径 */
  path: string;
  exists: boolean;
  kind: TargetKind;
  /** kind='link' 时 readlink 的原始返回值 */
  linkTarget: string | null;
  /** 链接目标规范化后的绝对路径（相对链接按链接所在目录解析） */
  resolvedTarget: string | null;
}

/** 链接相关结构化错误（code + detail；供上层转成 {status:'failed', code}）。 */
export class LinkError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'LinkError';
  }
}

/** 规范化路径用于比较：去 `\\?\` / `\??\` 前缀、解析相对段、去尾部斜杠。 */
function canonical(p: string): string {
  let out = p;
  if (out.startsWith('\\\\?\\')) out = out.slice(4);
  else if (out.startsWith('\\??\\')) out = out.slice(4);
  const resolved = path.resolve(out);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
}

/** Windows 语义大小写不敏感；其他平台精确比较。 */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const ca = canonical(a);
  const cb = canonical(b);
  return process.platform === 'win32' ? ca.toLowerCase() === cb.toLowerCase() : ca === cb;
}

/**
 * child 是否在 parent 内部（不含 parent 本身）。
 * 用于「目标不在源目录内部」的递归防护：目标等于源或落在源内部都必须拒绝。
 */
export function isPathInside(parent: string, child: string): boolean {
  const cp = canonical(parent);
  const cc = canonical(child);
  const [a, b] = process.platform === 'win32' ? [cp.toLowerCase(), cc.toLowerCase()] : [cp, cc];
  if (a === b) return false;
  return b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/** 链接目标（可能是相对路径）→ 绝对规范化路径。 */
export function resolveLinkPath(linkPath: string, raw: string): string {
  return canonical(path.isAbsolute(raw) ? raw : path.join(path.dirname(linkPath), raw));
}

/** lstat 判定目标现状；不存在返回 kind='missing'（这是三分支的第一支，不是错误）。 */
export function inspectTarget(target: string): TargetInspection {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { path: target, exists: false, kind: 'missing', linkTarget: null, resolvedTarget: null };
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    let raw: string | null = null;
    try {
      raw = fs.readlinkSync(target);
    } catch {
      raw = null;
    }
    return {
      path: target,
      exists: true,
      kind: 'link',
      linkTarget: raw,
      resolvedTarget: raw == null ? null : resolveLinkPath(target, raw),
    };
  }
  if (st.isDirectory()) return { path: target, exists: true, kind: 'dir', linkTarget: null, resolvedTarget: null };
  if (st.isFile()) return { path: target, exists: true, kind: 'file', linkTarget: null, resolvedTarget: null };
  return { path: target, exists: true, kind: 'other', linkTarget: null, resolvedTarget: null };
}

/**
 * inspectTarget 的异步版（判定逻辑与同步版保持一致）：批量探针（列表部署状态）
 * 用它把逐技能×逐 Agent 的 lstat/readlink 从主进程同步等待改为并行 IO，
 * 避免 Windows 冷盘上几十次同步 stat 堵住事件循环（「未响应」的来源之一）。
 */
export async function inspectTargetAsync(target: string): Promise<TargetInspection> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { path: target, exists: false, kind: 'missing', linkTarget: null, resolvedTarget: null };
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    let raw: string | null = null;
    try {
      raw = await fs.promises.readlink(target);
    } catch {
      raw = null;
    }
    return {
      path: target,
      exists: true,
      kind: 'link',
      linkTarget: raw,
      resolvedTarget: raw == null ? null : resolveLinkPath(target, raw),
    };
  }
  if (st.isDirectory()) return { path: target, exists: true, kind: 'dir', linkTarget: null, resolvedTarget: null };
  if (st.isFile()) return { path: target, exists: true, kind: 'file', linkTarget: null, resolvedTarget: null };
  return { path: target, exists: true, kind: 'other', linkTarget: null, resolvedTarget: null };
}

export interface CreateDirLinkResult {
  /** 实际使用的形态（日志/测试证据用） */
  linkType: LinkType;
  /** symlink 首次失败的错误码（走了 junction 兜底时存在） */
  symlinkErrorCode?: string;
}

/**
 * 创建目录链接：symlink 优先，失败再 junction。两者都失败抛 LinkError('LINK_CREATE_FAILED')。
 * 调用方必须先确认目标不存在（三分支判定），本函数不做覆盖。
 */
export function createDirLink(src: string, dst: string): CreateDirLinkResult {
  const absoluteSrc = path.resolve(src);
  try {
    fs.symlinkSync(absoluteSrc, dst, 'dir');
    return { linkType: 'symlink' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    try {
      fs.symlinkSync(absoluteSrc, dst, 'junction');
      return { linkType: 'junction', symlinkErrorCode: code };
    } catch (err2) {
      // 兜底失败：清掉可能残留的半成品（symlink 失败通常无残留，防御性处理）
      try {
        if (fs.lstatSync(dst)) fs.rmdirSync(dst);
      } catch {
        /* 无残留 */
      }
      const code2 = (err2 as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      throw new LinkError(
        'LINK_CREATE_FAILED',
        `symlink 失败（${code}）后 junction 也失败（${code2}）：${(err2 as Error).message}`,
      );
    }
  }
}

export type RemoveLinkMethod = 'unlink' | 'rmdir';

/**
 * 删除链接本身（只删链接，不触碰目标内容）。
 * 先 unlink（Windows Node 22.22 实测可行），EPERM/EACCES/EISDIR/ENOTEMPTY 再 rmdir 兜底。
 * 返回实际生效的方式，供证据记录；删除后回读确认。
 */
export function removeDirLink(target: string): RemoveLinkMethod {
  let method: RemoveLinkMethod = 'unlink';
  try {
    fs.unlinkSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EISDIR' && code !== 'ENOTEMPTY' && code !== 'UNKNOWN') {
      throw new LinkError('LINK_REMOVE_FAILED', `删除链接失败（${code}）：${(err as Error).message}`);
    }
    try {
      fs.rmdirSync(target);
      method = 'rmdir';
    } catch (err2) {
      throw new LinkError(
        'LINK_REMOVE_FAILED',
        `unlink（${code}）与 rmdir（${(err2 as NodeJS.ErrnoException).code ?? 'UNKNOWN'}）均失败`,
      );
    }
  }
  const after = inspectTarget(target);
  if (after.exists) {
    throw new LinkError('LINK_REMOVE_FAILED', `删除后目标仍存在：${target}`);
  }
  return method;
}

/** 保证目录存在（建链前父目录可能尚未创建，例如自定义 Agent 目录）。 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
