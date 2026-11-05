/**
 * 真实文件树构建（prd.md 5.3：文件树直接反映磁盘结构，含 references/、scripts/、assets/）。
 * 按需遍历目录项（readdir + lstat），不读取任何文件内容。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileTreeNode } from './types';

/** 构建技能目录的完整文件树；目录不存在返回 null。根节点为技能目录本身（relPath '.'）。 */
export function buildFileTree(rootDir: string): FileTreeNode | null {
  try {
    return buildNode(rootDir, path.basename(rootDir), '.');
  } catch {
    return null;
  }
}

function buildNode(dir: string, name: string, rel: string): FileTreeNode {
  const children: FileTreeNode[] = [];
  let size = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const sorted = entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const dirs: FileTreeNode[] = [];
  const files: FileTreeNode[] = [];

  for (const entry of sorted) {
    const full = path.join(dir, entry.name);
    const childRel = rel === '.' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      dirs.push(buildNode(full, entry.name, childRel));
    } else if (entry.isFile()) {
      const st = fs.lstatSync(full);
      size += st.size;
      files.push({ name: entry.name, relPath: childRel, type: 'file', size: st.size });
    }
    // 套接字等特殊类型不进树；符号链接按 lstat 归入 file（不跟随）
  }

  for (const d of dirs) size += d.size;
  children.push(...dirs, ...files); // 目录在前、文件在后，各按名称序

  return { name, relPath: rel, type: 'dir', size, children };
}

/** 统计树中文件节点总数（用于「72 文件完整浏览」类校验）。 */
export function countFiles(node: FileTreeNode | null): number {
  if (!node) return 0;
  if (node.type === 'file') return 1;
  return (node.children ?? []).reduce((sum, c) => sum + countFiles(c), 0);
}
