/**
 * 从 Git 对象库构建「按技能」的库快照（合并引擎的输入）。
 *
 * 快照只取合并需要的组件：内容树 OID / 元数据逻辑字段 / 报告 blob OID。
 * 与磁盘工作树无关（工作树里可能带着本机绝对路径 origin，提交树里没有）。
 */
import { isSkillId } from '../skill-id';
import { parseReportFile, safeReportName } from '../agent/workflows/report-store';
import { SYNC_PROTOCOL_DIR } from './protocol';
import type {
  GitTreeEntry,
  LibrarySnapshot,
  PortableSkillMeta,
  PortableSourceInfo,
  SkillSnapshot,
} from './types';

/** 只读 git 对象访问接口（infra/git-objects.ts 提供实现；测试可注入假实现）。 */
export interface GitObjectReader {
  /** 递归列出 treeish 下的所有 blob（路径相对仓库根，'/' 分隔） */
  listTree(treeish: string): GitTreeEntry[];
  /** 把 `<rev>^{tree}` 解析成 tree OID；不存在返回 null */
  resolveTree(treeish: string): string | null;
  readBlob(oid: string): Buffer;
  readFileAt(commit: string, filePath: string): Buffer | null;
  commitMessage(commit: string): string;
}

export class SnapshotError extends Error {
  readonly code = 'LIBRARY_INCONSISTENT';
  constructor(detail: string) {
    super(`LIBRARY_INCONSISTENT: ${detail}`);
    this.name = 'SnapshotError';
  }
}

/**
 * 元数据文件在提交树里的三种位置（布局演进都认）：
 *  - 现：sync/<dirName>.skill.json（2026-11-03 起元数据收在库根 sync/）
 *  - 中：skills/.meta/<dirName>.skill.json（2026-11-02 布局的历史提交）
 *  - 旧：skills/<dirName>.skill.json（平铺布局的历史提交）
 */
const META_RE_SYNC = /^sync\/([^/]+)\.skill\.json$/;
const META_RE_NEW = /^skills\/\.meta\/([^/]+)\.skill\.json$/;
const META_RE_LEGACY = /^skills\/([^/]+)\.skill\.json$/;

/** 元数据里 relPath 的合法性与末段校验（与 fs-meta.skillRelPathOf 同口径）。 */
function resolveMetaRelPath(raw: unknown, dirName: string): string {
  const rel = (raw as { relPath?: unknown } | null)?.relPath;
  if (typeof rel === 'string' && rel !== dirName) {
    const segments = rel.split('/');
    const valid =
      segments.length <= 2 &&
      segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && !seg.startsWith('.') && !seg.includes('\\'));
    if (valid && segments[segments.length - 1] === dirName) return segments.join('/');
  }
  return dirName;
}

/** 元数据文件 → 可跨机同步的逻辑视图（丢弃派生字段与本机字段）。 */
export function toPortableMeta(raw: unknown, dirName: string): PortableSkillMeta {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') throw new SnapshotError(`元数据格式非法：skills/${dirName}.skill.json`);
  const source = m.source as Record<string, unknown> | undefined;
  const portableSource: PortableSourceInfo | null = source
    ? {
        type: String(source.type ?? 'unknown'),
        ...(typeof source.origin === 'string' && source.origin ? { origin: source.origin } : {}),
        ...(typeof source.importedAt === 'string' ? { importedAt: source.importedAt } : {}),
        ...(typeof source.sourceRelPath === 'string' ? { sourceRelPath: source.sourceRelPath } : {}),
        ...(typeof source.sourceHash === 'string' ? { sourceHash: source.sourceHash } : {}),
        ...(typeof source.sourceBranch === 'string' ? { sourceBranch: source.sourceBranch } : {}),
        ...(typeof source.sourceRevision === 'string' ? { sourceRevision: source.sourceRevision } : {}),
      }
    : null;
  const groups = Array.isArray(m.groups) ? m.groups.filter((g): g is string => typeof g === 'string') : [];
  const sync = m.sync as Record<string, unknown> | undefined;
  const agents = Array.isArray(sync?.agents)
    ? (sync?.agents as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  return {
    schemaVersion: typeof m.schemaVersion === 'number' ? m.schemaVersion : 1,
    dirName,
    relPath: resolveMetaRelPath(m, dirName),
    name: typeof m.name === 'string' ? m.name : dirName,
    nameSource: m.nameSource === 'frontmatter' ? 'frontmatter' : 'dirname',
    description: typeof m.description === 'string' ? m.description : '',
    groups,
    source: portableSource,
    sync: { agents },
  };
}

/**
 * 构建某次提交的库快照。
 *
 * 一致性要求（合并结果树校验的口径）：每个技能目录都必须有且只有一份元数据；
 * 元数据可以没有目录（T01「已丢失」语义），此时 contentTree = null。
 */
export function buildLibrarySnapshot(reader: GitObjectReader, commit: string): LibrarySnapshot {
  const entries = reader.listTree(commit);
  const metaEntries = new Map<string, GitTreeEntry>(); // dirName → entry
  /** 含 SKILL.md/skill.md 的 skills/ 下目录前缀（技能目录的可靠标志，组目录没有） */
  const skillDirs = new Set<string>();
  const reportEntries = new Map<string, { entry: GitTreeEntry; stamp: string }>(); // 技能名 → 最新报告

  for (const entry of entries) {
    const parts = entry.path.split('/');
    if (parts[0] === 'skills') {
      const meta = META_RE_NEW.exec(entry.path) ?? META_RE_LEGACY.exec(entry.path);
      if (meta) {
        metaEntries.set(meta[1], entry);
        continue;
      }
      const last = parts[parts.length - 1];
      if (parts.length >= 3 && (last === 'SKILL.md' || last === 'skill.md')) {
        skillDirs.add(parts.slice(1, -1).join('/'));
      }
      continue;
    }
    if (parts[0] === 'sync') {
      // 库根 sync/：现行布局的元数据目录（历史提交里此名可能是落点快照 *.skills，不匹配元数据后缀自然忽略）
      const meta = META_RE_SYNC.exec(entry.path);
      if (meta) {
        metaEntries.set(meta[1], entry);
      }
      continue;
    }
    if (parts[0] === 'reports' && parts.length === 2) {
      // reports/<技能名>_review_<时间戳>.md：同一技能只认最新一份
      const parsed = parseReportFile(parts[1]);
      if (!parsed) continue;
      const known = reportEntries.get(parsed.name);
      if (!known || parsed.stamp > known.stamp) reportEntries.set(parsed.name, { entry, stamp: parsed.stamp });
      continue;
    }
    if (parts[0] === SYNC_PROTOCOL_DIR) continue; // 协议文件不参与技能合并
  }

  const skills: Record<string, SkillSnapshot> = {};
  const rows: { dirName: string; skillId: string; meta: PortableSkillMeta; contentTree: string | null }[] = [];
  for (const [dirName, entry] of metaEntries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(reader.readBlob(entry.oid).toString('utf8'));
    } catch {
      throw new SnapshotError(`元数据不可解析：${dirName}.skill.json`);
    }
    const skillId = (parsed as { skillId?: unknown }).skillId;
    if (typeof skillId !== 'string' || !isSkillId(skillId)) {
      throw new SnapshotError(`元数据缺少合法 Skill ID：${dirName}.skill.json`);
    }
    const duplicated = rows.find((row) => row.skillId === skillId);
    if (duplicated) {
      throw new SnapshotError(`Skill ID 重复：${skillId}（${duplicated.dirName} / ${dirName}）`);
    }
    rows.push({ dirName, skillId, meta: toPortableMeta(parsed, dirName), contentTree: null });
  }

  // 「目录绝不允许没有元数据」：树里的每个技能目录（SKILL.md 标志）必须被某份元数据认领
  const claimedRels = new Set(rows.map((row) => row.meta.relPath));
  for (const dir of skillDirs) {
    if (!claimedRels.has(dir)) {
      throw new SnapshotError(`技能目录 skills/${dir} 缺少元数据文件（无法参与合并）`);
    }
  }
  // 内容树按 meta 记录的位置解析；旧提交（平铺布局）meta 无 relPath = dirName
  for (const row of rows) {
    if (skillDirs.has(row.meta.relPath)) {
      row.contentTree = reader.resolveTree(`${commit}:skills/${row.meta.relPath}`);
      if (!row.contentTree) throw new SnapshotError(`无法解析内容树：skills/${row.meta.relPath}`);
    }
  }

  // 技能名可能重复：重名时报告文件名主体改用目录名（与 EvalReportStore 的取名规则一致）
  const nameCounts = new Map<string, number>();
  for (const row of rows) nameCounts.set(row.meta.name, (nameCounts.get(row.meta.name) ?? 0) + 1);
  for (const row of rows) {
    const reportName = (nameCounts.get(row.meta.name) ?? 0) > 1 ? row.dirName : row.meta.name;
    const latestReport = reportEntries.get(safeReportName(reportName, row.skillId));
    skills[row.skillId] = {
      skillId: row.skillId,
      meta: row.meta,
      contentTree: row.contentTree,
      reportBlob: latestReport?.entry.oid ?? null,
      reportFile: latestReport?.entry.path ?? null,
    };
  }

  return { commit, skills };
}
