/**
 * 合并结果的落盘辅助（非纯函数；决策与校验分别在 plan.ts / validate.ts）。
 *
 * 原则：
 *  - 技能目录就地同步（删多余文件、只写有变化的文件），不整目录删除重建——
 *    目录本身是 Agent 侧链接的目标，保持其存在可以让部署关系完全不受影响；
 *  - 所有来自 git 树的相对路径先过安全校验（拒绝绝对路径 / `..` / 盘符），
 *    越界直接抛错，由调用方整体回滚；
 *  - 报告按快照里的文件名写入（`reports/<技能名>_review_<时间戳>.md`），没有就删除。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MergeValidationError } from './validate';
import type { GitTreeEntry } from './types';

const FILE_MODES = new Set(['100644', '100755']);

/** 校验并转换 git 相对路径为本地路径段（拒绝越界与 Windows 非法形态）。 */
export function toSafeRelativePath(relPath: string): string[] {
  if (!relPath) throw new MergeValidationError([`技能文件相对路径为空`]);
  if (relPath.startsWith('/') || relPath.startsWith('\\') || /^[a-zA-Z]:/.test(relPath)) {
    throw new MergeValidationError([`技能文件路径是绝对路径：${relPath}`]);
  }
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')) {
      throw new MergeValidationError([`技能文件路径越界：${relPath}`]);
    }
  }
  return segments;
}

function collectWanted(entries: GitTreeEntry[]): Map<string, GitTreeEntry> {
  const wanted = new Map<string, GitTreeEntry>();
  for (const entry of entries) {
    if (!FILE_MODES.has(entry.mode)) {
      throw new MergeValidationError([`不支持的 git 文件模式 ${entry.mode}：${entry.path}`]);
    }
    toSafeRelativePath(entry.path);
    wanted.set(entry.path, entry);
  }
  return wanted;
}

export interface SyncStats {
  written: number;
  deleted: number;
}

/**
 * 把技能目录同步成给定文件集合（相对技能目录的路径）。
 * `readBlob` 由调用方注入（git cat-file），便于在测试中替换。
 */
export function syncSkillDirectory(
  dir: string,
  entries: GitTreeEntry[],
  readBlob: (oid: string) => Buffer,
): SyncStats {
  const wanted = collectWanted(entries);
  const wantedDirs = new Set<string>();
  for (const relPath of wanted.keys()) {
    const segments = relPath.split('/');
    for (let i = 1; i < segments.length; i++) wantedDirs.add(segments.slice(0, i).join('/'));
  }

  fs.mkdirSync(dir, { recursive: true });
  const stats: SyncStats = { written: 0, deleted: 0 };

  const prune = (current: string, prefix: string): void => {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const rel = prefix ? `${prefix}/${child.name}` : child.name;
      const full = path.join(current, child.name);
      const isDir = child.isDirectory() && !child.isSymbolicLink();
      if (isDir) {
        if (wantedDirs.has(rel)) {
          prune(full, rel);
        } else {
          fs.rmSync(full, { recursive: true, force: true });
          stats.deleted++;
        }
      } else if (!wanted.has(rel)) {
        fs.rmSync(full, { force: true });
        stats.deleted++;
      }
    }
  };
  prune(dir, '');

  for (const [relPath, entry] of wanted) {
    const segments = toSafeRelativePath(relPath);
    const target = path.join(dir, ...segments);
    const content = readBlob(entry.oid);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(target);
    } catch {
      existing = null;
    }
    if (existing?.isSymbolicLink()) {
      fs.rmSync(target, { force: true });
      existing = null;
    }
    if (existing?.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
      existing = null;
    }
    if (existing && existing.size === content.length && fs.readFileSync(target).equals(content)) {
      continue;
    }
    fs.writeFileSync(target, content);
    stats.written++;
  }
  return stats;
}

/** 写入/删除单个评测报告文件（相对库根的 `reports/<id>.md`）。内容相同则不重写（避免无谓回声）。 */
export function writeReportFile(file: string, content: Buffer | null): void {
  if (content == null) {
    fs.rmSync(file, { force: true });
    return;
  }
  try {
    if (fs.readFileSync(file).equals(content)) return;
  } catch {
    /* 不存在 → 正常写入 */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
