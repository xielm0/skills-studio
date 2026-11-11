/**
 * 同步落点记忆（`<库>/agents-skills/<agentId>.skills`，2026-10-30 用户定；目录名
 * 2026-11-03 由 sync 改为 agents-skills，sync 让位给库根的技能元数据目录）。
 *
 * 记录「这个 Agent 的 skills 目录里，每个库内技能实际放在哪个相对路径」：
 *  - 有记录 → 同步就放到记录的位置（media-agent 这类两层目录 `github/lark`）；
 *  - 无记录 → 平铺 `skills/<技能名>`（所有 Agent 至少认一层，平铺永远可用）。
 *
 * 写入口径：扫描时整份重写（快照语义，非增量追加）；同步成功后只更新该条；
 * 失败/冲突不写。文件随库进 Git，跨机恢复后由扫描重写纠正，不做特殊处理。
 * 非法 Agent id（含路径分隔符等）不落盘，避免写出库外路径。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const PLACEMENT_DIR_NAME = 'agents-skills';
/** 旧目录名（2026-11-03 前的落点快照位置），启动迁移把它挪到 PLACEMENT_DIR_NAME */
const LEGACY_PLACEMENT_DIR_NAME = 'sync';
const SCHEMA_VERSION = 1;
/** 与内置 Agent id 同形（下划线分隔）；自定义 id 只要求不含路径分隔符 */
const AGENT_ID_RE = /^[A-Za-z0-9._-]+$/;

export interface PlacementLogger {
  info(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
}

export interface PlacementStore {
  /** 该 Agent 的落点表（相对 skills 根，如 `github/lark`）；无文件/损坏时返回空表 */
  read(agentId: string): Record<string, string>;
  /** read 的异步版（批量探针用，避免首屏列表逐 Agent 同步读文件） */
  readAsync(agentId: string): Promise<Record<string, string>>;
  /** 整份重写；内容未变不写盘，返回是否真的写了 */
  writeAll(agentId: string, skills: Record<string, string>): boolean;
  /** 单条更新（同步成功后） */
  set(agentId: string, dirName: string, relPath: string): void;
  /** 单条移除（撤下后） */
  remove(agentId: string, dirName: string): void;
  /** 整份删除（自定义 Agent 被删除时清理，不留孤儿文件） */
  removeFile(agentId: string): void;
  filePath(agentId: string): string | null;
}

/**
 * 启动迁移：把旧落点快照目录 <库>/sync/ 挪到 <库>/agents-skills/（2026-11-03 目录改名，
 * sync 名字让位给库根的技能元数据目录）。必须先于 migrateSkillMetaDirLayout 执行（腾出 sync 名字）。
 * 幂等：旧目录不存在或新目录已存在即跳过；rename 失败仅记日志不抛错——落点快照可由
 * 扫描整份重建，丢失无害。返回是否发生了迁移。
 */
export function migratePlacementDirLayout(libraryDir: string, logger?: PlacementLogger): boolean {
  const from = path.join(libraryDir, LEGACY_PLACEMENT_DIR_NAME);
  const to = path.join(libraryDir, PLACEMENT_DIR_NAME);
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  // 内容守卫：旧快照目录里只有 <agentId>.skills 文件；若出现 *.skill.json 说明 sync/ 已是
  // 新布局的元数据目录（本库已归位过），绝不能搬走
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch (err) {
    logger?.error('placement:migrate-scan-failed', { from, error: (err as Error).message });
    return false;
  }
  const hasSkillMeta = entries.some((e) => e.isFile() && e.name.endsWith('.skill.json'));
  if (hasSkillMeta) return false;
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // 快照可重建：迁移失败不阻断启动，下次扫描整份重写即可恢复
    logger?.error('placement:migrate-failed', { from, to, error: (err as Error).message });
    return false;
  }
  logger?.info('placement:migrated', { from, to });
  return true;
}

export function createPlacementStore(opts: { libraryDir: string; logger?: PlacementLogger }): PlacementStore {
  const dir = path.join(opts.libraryDir, PLACEMENT_DIR_NAME);

  const filePath = (agentId: string): string | null =>
    AGENT_ID_RE.test(agentId) ? path.join(dir, `${agentId}.skills`) : null;

  const read = (agentId: string): Record<string, string> => {
    const file = filePath(agentId);
    if (file == null) return {};
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return {};
    }
    return parsePlacementRaw(raw, agentId);
  };

  const readAsync = async (agentId: string): Promise<Record<string, string>> => {
    const file = filePath(agentId);
    if (file == null) return {};
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch {
      return {};
    }
    return parsePlacementRaw(raw, agentId);
  };

  /** 落点表原始文本 → 校验后的映射；损坏按「没有记录」处理（下次扫描整份重写恢复）。 */
  const parsePlacementRaw = (raw: string, agentId: string): Record<string, string> => {
    try {
      const parsed = JSON.parse(raw) as { skills?: unknown };
      const skills = parsed?.skills;
      if (!skills || typeof skills !== 'object') return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(skills as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) out[key] = value;
      }
      return out;
    } catch {
      opts.logger?.error('placement:unreadable', { agentId });
      return {};
    }
  };

  const writeAll = (agentId: string, skills: Record<string, string>): boolean => {
    const file = filePath(agentId);
    if (file == null) {
      opts.logger?.error('placement:invalid-agent-id', { agentId });
      return false;
    }
    const ordered: Record<string, string> = {};
    for (const key of Object.keys(skills).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      ordered[key] = skills[key];
    }
    const body = `${JSON.stringify({ version: SCHEMA_VERSION, skills: ordered }, null, 2)}\n`;
    let previous: string | null = null;
    try {
      previous = fs.readFileSync(file, 'utf8');
    } catch {
      previous = null;
    }
    if (previous === body) return false;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    opts.logger?.info('placement:written', { agentId, count: Object.keys(ordered).length });
    return true;
  };

  const set = (agentId: string, dirName: string, relPath: string): void => {
    if (!dirName || !relPath) return;
    const current = read(agentId);
    if (current[dirName] === relPath) return;
    current[dirName] = relPath;
    writeAll(agentId, current);
  };

  const remove = (agentId: string, dirName: string): void => {
    const current = read(agentId);
    if (!(dirName in current)) return;
    delete current[dirName];
    writeAll(agentId, current);
  };

  const removeFile = (agentId: string): void => {
    const file = filePath(agentId);
    if (file == null) return;
    try {
      fs.rmSync(file, { force: true });
      opts.logger?.info('placement:removed', { agentId });
    } catch (err) {
      opts.logger?.error('placement:remove-failed', { agentId, error: (err as Error).message });
    }
  };

  return { read, readAsync, writeAll, set, remove, removeFile, filePath };
}
