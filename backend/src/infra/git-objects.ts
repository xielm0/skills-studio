/**
 * git 对象读取适配器（T04）：把 `ls-tree` / `rev-parse` / `cat-file` 包装成
 * 合并引擎所需的只读接口。领域层只依赖 `GitObjectReader` 接口，测试可注入假实现。
 */
import { runGit, runGitBuffer, runGitOk } from './git';
import type { GitObjectReader } from '../domain/merge/snapshot';
import type { GitTreeEntry } from '../domain/merge/types';

/** 解析 `git ls-tree -r -z` 输出：`<mode> <type> <oid>\t<path>\0`。 */
export function parseLsTreeZ(stdout: string): GitTreeEntry[] {
  const out: GitTreeEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    if (meta.length < 3) continue;
    const [mode, type, oid] = meta;
    if (type !== 'blob') continue;
    out.push({ mode, oid, path: record.slice(tab + 1) });
  }
  return out;
}

/** 以库目录为工作树创建对象读取器（所有命令都在库根执行）。 */
export function createGitObjectReader(cwd: string): GitObjectReader {
  return {
    listTree(treeish: string): GitTreeEntry[] {
      const res = runGit(['ls-tree', '-r', '-z', '--full-tree', treeish], {
        cwd,
        operation: 'ls-tree',
      });
      return parseLsTreeZ(res.stdout);
    },
    resolveTree(treeish: string): string | null {
      const res = runGit(['rev-parse', '--verify', '--quiet', treeish], {
        cwd,
        allowFailure: true,
        operation: 'rev-parse',
      });
      const oid = res.stdout.trim();
      if (res.status !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) return null;
      // `<commit>:<path>^{tree}` 不是合法 rev 语法，因此先解析对象再确认类型
      const type = runGit(['cat-file', '-t', oid], { cwd, allowFailure: true, operation: 'cat-file' });
      return type.status === 0 && type.stdout.trim() === 'tree' ? oid : null;
    },
    readBlob(oid: string): Buffer {
      return runGitBuffer(['cat-file', 'blob', oid], { cwd, operation: 'cat-file' });
    },
    readFileAt(commit: string, filePath: string): Buffer | null {
      const rev = `${commit}:${filePath}`;
      const probe = runGit(['rev-parse', '--verify', '--quiet', rev], {
        cwd,
        allowFailure: true,
        operation: 'rev-parse',
      });
      if (probe.status !== 0 || !probe.stdout.trim()) return null;
      return runGitBuffer(['cat-file', 'blob', probe.stdout.trim()], { cwd, operation: 'cat-file' });
    },
    commitMessage(commit: string): string {
      return runGitOk(['log', '-1', '--format=%B', commit], { cwd, operation: 'log' });
    },
  };
}
