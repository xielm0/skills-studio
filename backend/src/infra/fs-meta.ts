/**
 * 技能元数据文件存取（tec.md §5.1/§6.1）：
 *  - 每技能一份 JSON，统一收在库根 sync/ 目录（2026-11-03 用户定：同步信息与 skills/ 同级；
 *    2026-11-02 曾收在 skills/.meta/，更早平铺技能区，迁移链见 migrateSkillMetaLayout /
 *    migrateSkillMetaDirLayout；放技能目录内部 = 错误，避免复制/部署技能时带走管理信息）；
 *  - 文件名 = `<dirName>.skill.json`（dirName 是技能目录末段名，与技能的稳定关联键；
 *    技能被手动挪进一层子目录时 relPath 更新、文件名不变）；
 *  - relPath 记录技能相对 skills 根的位置（如 `lark/lark-crawler`），支持手动分组子目录；
 *  - 随库进 Git（库目录内，不进 DATA_DIR）；
 *  - 库级 schema 版本标记在 <库根>/library.json。
 * 真相层级：技能文件 + 元数据文件是真相；SQLite 索引是纯派生物。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSkillId } from '../domain/skill-id';
import { validateSkillRelPath } from '../domain/path-guard';
import type { LibraryMetadataFile, SkillMetadataFile } from '../domain/types';

export const LIBRARY_META_FILE = 'library.json';
export const SKILL_META_SUFFIX = '.skill.json';
/** 元数据统一收在库根下此目录（与 skills/ 同级；2026-11-03 前为 skills/.meta/，迁移见 migrateSkillMetaDirLayout） */
export const SKILL_META_DIRNAME = 'sync';
export const SKILL_META_SCHEMA_VERSION = 1;
export const LIBRARY_SCHEMA_VERSION = 1;

export function skillsDirOf(libraryDir: string): string {
  return path.join(libraryDir, 'skills');
}

/**
 * 元数据目录绝对路径：库根 sync/（SKILL_META_DIRNAME）。
 * 入参沿用历史签名的 skillsDir（恒为 <库根>/skills，见 skillsDirOf），据此推导库根；
 * 全部调用方都传 library.skillsDir，推导安全。
 */
export function skillMetaDir(skillsDir: string): string {
  return path.join(path.dirname(skillsDir), SKILL_META_DIRNAME);
}

export function skillMetaPath(skillsDir: string, dirName: string): string {
  return path.join(skillMetaDir(skillsDir), dirName + SKILL_META_SUFFIX);
}

/**
 * 解析元数据里的技能位置（相对 skills 根，'/' 分隔）：
 * 缺失/非法（层数、段名、末段与 dirName 不一致）一律回退平铺 dirName。
 */
export function skillRelPathOf(meta: Pick<SkillMetadataFile, 'dirName' | 'relPath'>): string {
  if (typeof meta.relPath === 'string' && meta.relPath !== meta.dirName) {
    const validated = validateSkillRelPath(meta.relPath);
    if (validated != null && validated.split('/').pop() === meta.dirName) return validated;
  }
  return meta.dirName;
}

/** relPath 的绝对路径（skillsDir + 段拼接）。 */
export function skillsDirJoin(skillsDir: string, relPath: string): string {
  return path.join(skillsDir, ...relPath.split('/'));
}

/**
 * 解析入库/替换的目标目录：库内已有同名技能（元数据存在）→ 沿用其现有位置
 * （用户手动分组后重新入库不产生第二份）；没有 → 平铺 skills/<dirName>。
 */
export function libraryDestDirOf(skillsDir: string, dirName: string): string {
  const meta = readSkillMeta(skillsDir, dirName);
  return meta ? skillsDirJoin(skillsDir, skillRelPathOf(meta)) : path.join(skillsDir, dirName);
}

/**
 * 启动迁移：把更旧的布局（<dirName>.skill.json 平铺在 skills/ 技能区）收进元数据目录
 * （skillMetaDir，现指向库根 sync/；紧随其后的 migrateSkillMetaDirLayout 会把历史
 * skills/.meta/ 残留一并归位到同处）。
 * 幂等：旧位置没有文件即跳过；目标已存在（异常残留）以元数据目录为准删除旧文件。
 * 单个失败不阻断启动（下次启动重试）。在库服务创建、文件监视启动之前调用，无监视回声。
 */
export function migrateSkillMetaLayout(skillsDir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const flat = entries.filter((e) => e.isFile() && e.name.endsWith(SKILL_META_SUFFIX));
  if (flat.length === 0) return 0;
  const dir = skillMetaDir(skillsDir);
  fs.mkdirSync(dir, { recursive: true });
  let moved = 0;
  for (const entry of flat) {
    const from = path.join(skillsDir, entry.name);
    const to = path.join(dir, entry.name);
    try {
      if (fs.existsSync(to)) fs.rmSync(from, { force: true });
      else fs.renameSync(from, to);
      moved++;
    } catch {
      /* 单个失败不阻断启动，下次启动重试 */
    }
  }
  return moved;
}

/** 旧布局的元数据目录名（skills/ 下点开头，2026-11-03 前的收拢位置），迁移完成后不应再存在 */
const LEGACY_SKILL_META_DIRNAME = '.meta';

/**
 * 启动迁移：把旧元数据目录 skills/.meta/ 整体归位到库根 sync/（2026-11-03 用户定：
 * 同步信息与 skills/ 同级）。必须在 migratePlacementDirLayout（库根 sync/ → agents-skills/）
 * 之后调用，否则旧落点快照还占着 sync 名字。
 * 幂等：旧目录不存在即跳过；目标已存在（上次复制中断残留）时逐文件补全、不覆盖已有文件。
 * 优先 rename（同盘原子）；rename 失败（如文件被占用）逐文件复制兜底，复制失败抛错——
 * 元数据（来源、同步意图）不可由扫描重建，禁止静默降级成空库。旧目录删除失败仅记日志（数据已在新位置）。
 * 在库服务创建、文件监视启动之前调用，无监视回声。返回是否发生了迁移。
 */
export function migrateSkillMetaDirLayout(libraryDir: string): boolean {
  const legacyDir = path.join(skillsDirOf(libraryDir), LEGACY_SKILL_META_DIRNAME);
  const targetDir = path.join(libraryDir, SKILL_META_DIRNAME);
  if (!fs.existsSync(legacyDir)) return false;
  // ① rename 优先：同盘原子搬移，目标已存在时跳过走补全
  if (!fs.existsSync(targetDir)) {
    try {
      fs.renameSync(legacyDir, targetDir);
      return true;
    } catch {
      /* rename 失败（目录被占用等）→ 走逐文件复制兜底 */
    }
  }
  // ② 兜底：逐文件复制到新位置（目标已存在的文件跳过，中断后重入可补全）
  try {
    fs.cpSync(legacyDir, targetDir, { recursive: true, force: false, errorOnExist: false });
  } catch (err) {
    // 元数据不可重建：复制失败必须显式失败，避免库被当成空库继续运行
    throw new Error(`技能元数据迁移失败（skills/.meta → sync）：${(err as Error).message}`);
  }
  // ③ 数据已在新位置，旧目录尽力清理；删除失败不阻断启动，下次启动重试
  try {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  } catch {
    /* 旧目录残留无害（skills/ 下点开头，扫描器排除），下次启动再清 */
  }
  return true;
}

/** 读取库级元数据；不存在时创建默认值并写盘。 */
export function ensureLibraryMeta(libraryDir: string): LibraryMetadataFile {
  const file = path.join(libraryDir, LIBRARY_META_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LibraryMetadataFile;
    if (typeof parsed.schemaVersion === 'number') return parsed;
  } catch {
    /* 缺失或损坏 → 重建 */
  }
  const meta: LibraryMetadataFile = { schemaVersion: LIBRARY_SCHEMA_VERSION };
  fs.mkdirSync(libraryDir, { recursive: true });
  atomicWriteJson(file, meta);
  return meta;
}

/** readSkillMeta 的返回：relPath 经过规范化，恒为字符串。 */
export type ReadSkillMeta = SkillMetadataFile & { relPath: string };

/** 读取某技能的元数据文件；不存在或结构非法时返回 null。relPath 规范化后补齐。 */
export function readSkillMeta(skillsDir: string, dirName: string): ReadSkillMeta | null {
  let raw: string;
  try {
    raw = fs.readFileSync(skillMetaPath(skillsDir, dirName), 'utf8');
  } catch {
    return null;
  }
  return parseSkillMetaRaw(raw, dirName);
}

/**
 * readSkillMeta 的异步版（解析与校验同源）：批量探针用它把元数据读取改为并行 IO，
 * 避免首屏列表逐技能同步读文件堵住主进程。
 */
export async function readSkillMetaAsync(skillsDir: string, dirName: string): Promise<ReadSkillMeta | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(skillMetaPath(skillsDir, dirName), 'utf8');
  } catch {
    return null;
  }
  return parseSkillMetaRaw(raw, dirName);
}

/** 元数据原始文本 → 校验并补齐派生字段；损坏/不合法返回 null（同步/异步版共用）。 */
function parseSkillMetaRaw(raw: string, dirName: string): ReadSkillMeta | null {
  try {
    const m = JSON.parse(raw) as SkillMetadataFile;
    if (typeof m.skillId !== 'string' || !isSkillId(m.skillId)) return null;
    if (typeof m.dirName !== 'string' || m.dirName !== dirName) return null;
    if (!Array.isArray(m.groups)) return null;
    return {
      ...m,
      relPath: skillRelPathOf(m),
      groups: m.groups.filter((g) => typeof g === 'string'),
      sync: { agents: Array.isArray(m.sync?.agents) ? m.sync.agents.filter((a) => typeof a === 'string') : [] },
    };
  } catch {
    return null;
  }
}

/** 写入元数据文件（临时文件 + rename 原子替换）。relPath 缺省时补平铺值。 */
export function writeSkillMeta(skillsDir: string, meta: SkillMetadataFile): void {
  const normalized: SkillMetadataFile = { ...meta, relPath: skillRelPathOf(meta) };
  fs.mkdirSync(skillMetaDir(skillsDir), { recursive: true });
  atomicWriteJson(skillMetaPath(skillsDir, normalized.dirName), normalized);
}

/**
 * 列出所有元数据文件对应的 dirName（含已丢失技能——目录没了但元数据还在）。
 * 元数据统一在库根 sync/ 下。
 */
export function listMetaDirNames(skillsDir: string): string[] {
  try {
    return fs
      .readdirSync(skillMetaDir(skillsDir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(SKILL_META_SUFFIX))
      .map((e) => e.name.slice(0, -SKILL_META_SUFFIX.length));
  } catch {
    return [];
  }
}

/** 删除技能时同步删除其元数据文件（T01 保留 API，删除流程在后续任务接入）。 */
export function deleteSkillMeta(skillsDir: string, dirName: string): void {
  fs.rmSync(skillMetaPath(skillsDir, dirName), { force: true });
}

function atomicWriteJson(file: string, value: unknown): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
