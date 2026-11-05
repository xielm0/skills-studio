/** Read-only, file and line comparison for two Skill directories. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readTextFileInDir } from './catalog';
import { buildFileHashMap, foldCrlf, isIgnoredDirName, isIgnoredFileName, skillContentMtime } from './content-hash';
import type { LibrarySyncDiffResult } from '../shared/ipc';

const ROOT_FILE = '__agent_root_file__';

function isDirectory(root: string): boolean {
  try { return fs.statSync(root).isDirectory(); } catch { return false; }
}

function entriesOf(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!isDirectory(root)) {
    const stat = fs.lstatSync(root);
    out.set(ROOT_FILE, stat.isSymbolicLink()
      ? `L:${fs.readlinkSync(root)}`
      : `F:${crypto.createHash('sha256').update(foldCrlf(fs.readFileSync(root))).digest('hex')}`);
    return out;
  }
  // 按 LF 归一口径判定「这个文件算不算改过」：只有行尾符不同（CRLF / LF）的文件不进差异列表
  for (const [rel, hash] of buildFileHashMap(root, true)) out.set(rel, `F:${hash}`);
  const walkLinks = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isIgnoredDirName(entry.name) || isIgnoredFileName(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) out.set(rel, `L:${fs.readlinkSync(full)}`);
      else if (entry.isDirectory()) walkLinks(full, rel);
    }
  };
  walkLinks(root, '');
  return out;
}

/** 逐行对照统一按 LF 展示：两侧行尾符不同不再被读成「每一行都改了」。 */
function normalizeEol(content: string): string {
  return content.includes('\r\n') ? content.replace(/\r\n/g, '\n') : content;
}

export function compareSkillDirs(sourceRoot: string, targetRoot: string, relPath?: string): LibrarySyncDiffResult {
  const sourceMs = skillContentMtime(sourceRoot);
  const targetMs = skillContentMtime(targetRoot);
  const times = {
    sourceMtime: sourceMs == null ? null : new Date(sourceMs).toISOString(),
    targetMtime: targetMs == null ? null : new Date(targetMs).toISOString(),
  };
  const sourceFiles = entriesOf(sourceRoot);
  const targetFiles = entriesOf(targetRoot);
  const paths = new Set([...sourceFiles.keys(), ...targetFiles.keys()]);
  const files: LibrarySyncDiffResult['files'] = [...paths].sort().flatMap((name) => {
    const source = sourceFiles.get(name);
    const target = targetFiles.get(name);
    if (source === target) return [];
    return [{ relPath: name, status: source == null ? 'removed' as const : target == null ? 'added' as const : 'modified' as const }];
  });
  if (relPath === undefined) return { stale: false, ...times, files, source: null, target: null };
  if (!files.some((file) => file.relPath === relPath)) throw new Error('文件不在差异列表中');
  const readSide = (root: string, entries: Map<string, string>) => {
    if (!entries.has(relPath)) return null;
    if (relPath === ROOT_FILE) {
      const stat = fs.lstatSync(root);
      return stat.isSymbolicLink()
        ? { relPath, content: null, size: stat.size, editable: false, reason: 'NOT_A_FILE' as const }
        : readTextFileInDir(path.dirname(root), path.basename(root));
    }
    const file = path.join(root, relPath);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return { relPath, content: null, size: stat.size, editable: false, reason: 'NOT_A_FILE' as const };
    const read = readTextFileInDir(root, relPath);
    return read.content == null ? read : { ...read, content: normalizeEol(read.content) };
  };
  return { stale: false, ...times, files, source: readSide(sourceRoot, sourceFiles), target: readSide(targetRoot, targetFiles) };
}
