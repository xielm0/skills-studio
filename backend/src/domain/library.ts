/**
 * 中心库领域服务（T01：稳定 Skill ID、扁平库布局、元数据、可重建索引、
 * 文件监视与近期动态）。真相 = <库>/skills/<名>/ 技能文件 + skills/<名>.skill.json 元数据；
 * SQLite 索引与事件均为派生/独立持久数据。不做导入、部署、备份（T02+）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActivityStore } from '../infra/activity-jsonl';
import {
  SKILL_META_SCHEMA_VERSION,
  SKILL_META_DIRNAME,
  ensureLibraryMeta,
  listMetaDirNames,
  migrateSkillMetaDirLayout,
  migrateSkillMetaLayout,
  readSkillMeta,
  skillMetaPath,
  skillsDirJoin,
  skillsDirOf,
  writeSkillMeta,
} from '../infra/fs-meta';
import { LibraryWatcher } from '../infra/library-watcher';
import { migratePlacementDirLayout } from './placement-store';
import { SkillIndexStore, type SkillIndexRecord } from '../infra/sqlite-index';
import type { WriteLock } from '../infra/write-lock';
import { hashAndSizeSkillDir } from './content-hash';
import { buildFileTree } from './file-tree';
import { isSkillDir } from './frontmatter';
import { sameOrigin, sanitizeName } from './path-guard';
import { generateSkillId } from './skill-id';
import { scanSkillsDir } from './scanner';
import type {
  ActivityEvent,
  ActivityType,
  DeploymentStatusProbe,
  RescanResult,
  SkillDetail,
  SkillMetadataFile,
  SkillSummary,
} from './types';
import { MAX_GROUP_LENGTH } from './types';

/** 库内一层文件夹（`skills/<组>/`）操作失败：单层目录名非法、不存在或重名。 */
export class FolderError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'FolderError';
  }
}

/**
 * 文件夹改动前技能所在的库内位置：目录移动后调用方据 previousPath 精确识别
 * 「指向旧位置的 Agent 链接」并重建，避免误删用户自己放的链接。
 */
export interface MovedSkill {
  skillId: string;
  dirName: string;
  previousPath: string;
}

export interface SkillLibraryServiceOptions {
  /** 库根目录（含 skills/ 与 library.json） */
  libraryDir: string;
  /** 本机数据目录（索引 DB + 活动事件；开发期为 tests/runtime/data-dev） */
  dataDir: string;
  /**
   * T08：跨进程写锁。注入后重扫/建元数据也在锁内，避免与另一端的导入/删除交错
   * （例如 CLI 正在复制入库，GUI 的监视重扫把半成品目录登记成技能）。
   */
  lock?: WriteLock;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
}

export class SkillLibraryService {
  private readonly index: SkillIndexStore;
  private readonly activity: ActivityStore;
  private readonly logger: SkillLibraryServiceOptions['logger'];
  private readonly lock: WriteLock | undefined;
  private watcher: LibraryWatcher | null = null;
  /** T03：部署状态探针；未注入时 deployedAgents 保持「同步意图」语义（T01/T02 兼容） */
  private deploymentProbe: DeploymentStatusProbe | null = null;
  /** 重扫串行化：监视/轮询/手动触发不会交叉写索引 */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly libraryDir: string,
    readonly skillsDir: string,
    index: SkillIndexStore,
    activity: ActivityStore,
    logger: SkillLibraryServiceOptions['logger'],
    lock: WriteLock | undefined,
  ) {
    this.index = index;
    this.activity = activity;
    this.logger = logger;
    this.lock = lock;
  }

  /** 打开（或初始化）库服务：迁移元数据布局、建 skills/、library.json、索引 DB、事件文件。 */
  static create(opts: SkillLibraryServiceOptions): SkillLibraryService {
    const libraryDir = path.resolve(opts.libraryDir);
    const skillsDir = skillsDirOf(libraryDir);
    fs.mkdirSync(skillsDir, { recursive: true });
    // 旧布局（<dirName>.skill.json 平铺技能区）一次性收进元数据目录；幂等
    migrateSkillMetaLayout(skillsDir);
    // 目录改名迁移（2026-11-03）：先腾出库根 sync 名字（落点快照 → agents-skills/），
    // 再把 skills/.meta/ 归位到库根 sync/（同步信息与 skills/ 同级）；顺序不可颠倒
    migratePlacementDirLayout(libraryDir, opts.logger);
    migrateSkillMetaDirLayout(libraryDir);
    ensureLibraryMeta(libraryDir);
    const index = SkillIndexStore.open(path.join(opts.dataDir, 'index.db'), libraryDir);
    const activity = new ActivityStore(path.join(opts.dataDir, 'activity.jsonl'));
    return new SkillLibraryService(libraryDir, skillsDir, index, activity, opts.logger, opts.lock);
  }

  /**
   * 库内技能目录的绝对路径（按索引 relPath 定位；索引无记录时按平铺）。
   * 所有「从 dirName 定位库内技能目录」的链路（部署源、删除、校验）统一走这里，
   * 保证与重扫对账后的真实位置一致。
   */
  skillDirOf(dirName: string): string {
    const row = this.index.getByDirName(dirName);
    return skillsDirJoin(this.skillsDir, row?.relPath ?? dirName);
  }

  /** 按真实磁盘列出 skills/ 下的一层文件夹；异步读取，避免阻塞 Electron 主进程。 */
  async listFolders(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.skillsDir, { withFileTypes: true });
      const names = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== SKILL_META_DIRNAME)
        .map(async (entry) => {
          const dir = path.join(this.skillsDir, entry.name);
          try {
            const children = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const file of children) {
              if (file.name.toLowerCase() !== 'skill.md') continue;
              if (file.isFile()) return null;
              if (file.isSymbolicLink()) {
                try {
                  if ((await fs.promises.stat(path.join(dir, file.name))).isFile()) return null;
                } catch {
                  // 损坏的标记链接不是技能文件。
                }
              }
            }
            return entry.name;
          } catch {
            return null; // 目录在读取期间消失或不可读
          }
        }));
      return names.filter((name): name is string => name !== null).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  /**
   * 新建一层文件夹（`skills/<name>/`）：只建目录，不登记任何元数据。
   * 侧边栏文件夹列表按磁盘实时枚举（listFolders），建完即可见（空目录也算）。
   */
  createFolder(rawName: string): string {
    const name = this.requireFolderName(rawName);
    const dest = path.join(this.skillsDir, name);
    if (fs.existsSync(dest)) throw new FolderError('BAD_REQUEST', `已存在同名目录：${name}`);
    fs.mkdirSync(dest);
    this.logger?.info('library:folder-created', { name });
    return name;
  }

  /**
   * 重命名一层文件夹：目录改名后由 rescan 对账把技能 relPath 更新到新前缀。
   * 返回移动前的技能位置，调用方据此重建 Agent 侧链接（链接指向库内绝对路径）。
   */
  async renameFolder(rawFrom: string, rawTo: string): Promise<MovedSkill[]> {
    const from = this.requireFolderName(rawFrom);
    const to = this.requireFolderName(rawTo);
    if (from === to) return [];
    this.requireFolderExists(from);
    const source = path.join(this.skillsDir, from);
    const target = path.join(this.skillsDir, to);
    if (fs.existsSync(target)) throw new FolderError('BAD_REQUEST', `已存在同名目录：${to}`);
    const moved = this.collectFolderSkills(from);
    const run = async (): Promise<MovedSkill[]> => {
      fs.renameSync(source, target);
      await this.rescan();
      return moved;
    };
    const result = this.lock != null ? this.lock.runExclusive('folder-rename', run) : run();
    await result;
    this.logger?.info('library:folder-renamed', { from, to, skills: moved.length });
    return moved;
  }

  /**
   * 删除一层文件夹：里面的技能逐个移到库根（变成未分组），最后移除空目录。
   * 根下已有同名目录时整体拒绝，不做半途移动；非技能残留内容不静默删除，目录保留。
   */
  async removeFolder(rawName: string): Promise<MovedSkill[]> {
    const name = this.requireFolderName(rawName);
    this.requireFolderExists(name);
    const source = path.join(this.skillsDir, name);
    const moved = this.collectFolderSkills(name);
    const conflicts = moved.filter((item) => fs.existsSync(path.join(this.skillsDir, item.dirName)));
    if (conflicts.length > 0) {
      throw new FolderError('BAD_REQUEST', `库根已有同名技能目录，未移动：${conflicts.map((item) => item.dirName).join('、')}`);
    }
    const run = async (): Promise<MovedSkill[]> => {
      for (const item of moved) {
        fs.renameSync(path.join(source, item.dirName), path.join(this.skillsDir, item.dirName));
      }
      try {
        fs.rmdirSync(source);
      } catch {
        /* 目录里还有非技能内容：保留原目录，不替用户删除 */
      }
      await this.rescan();
      return moved;
    };
    const result = this.lock != null ? this.lock.runExclusive('folder-remove', run) : run();
    await result;
    this.logger?.info('library:folder-removed', { name, skills: moved.length });
    return moved;
  }

  /**
   * 把单个技能移动到某个文件夹（folder 为空串 = 移回库根）。
   * 与文件夹改名/删除同一条链路：目录移动后由 rescan 对账 relPath，
   * 返回旧位置供调用方重建 Agent 链接。
   */
  async moveSkill(skillId: string, rawFolder: string): Promise<MovedSkill[]> {
    const skill = this.listSkills().find((item) => item.skillId === skillId);
    if (!skill) throw new FolderError('BAD_REQUEST', `技能不存在：${skillId}`);
    const folder = typeof rawFolder === 'string' ? rawFolder.trim() : '';
    if (folder.length > 0) {
      this.requireFolderName(folder);
      this.requireFolderExists(folder);
    }
    const targetRelPath = folder.length > 0 ? `${folder}/${skill.dirName}` : skill.dirName;
    if (targetRelPath === skill.relPath) return [];
    const source = skillsDirJoin(this.skillsDir, skill.relPath);
    const dest = skillsDirJoin(this.skillsDir, targetRelPath);
    if (fs.existsSync(dest)) {
      throw new FolderError('BAD_REQUEST', `目标位置已存在同名目录：${targetRelPath}`);
    }
    const moved: MovedSkill[] = [{ skillId, dirName: skill.dirName, previousPath: source }];
    const run = async (): Promise<MovedSkill[]> => {
      fs.renameSync(source, dest);
      await this.rescan();
      return moved;
    };
    const result = this.lock != null ? this.lock.runExclusive('skill-move', run) : run();
    await result;
    this.logger?.info('library:skill-moved', { skillId, from: skill.relPath, to: targetRelPath });
    return moved;
  }

  /** 文件夹名单层校验：清洗后必须原样等于输入，避免静默改名后再重名。 */
  private requireFolderName(raw: string): string {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length === 0) throw new FolderError('BAD_REQUEST', '文件夹名不能为空');
    if (name.length > MAX_GROUP_LENGTH) throw new FolderError('BAD_REQUEST', `文件夹名过长（最多 ${MAX_GROUP_LENGTH} 字符）`);
    if (name.includes('/') || name.includes('\\')) throw new FolderError('BAD_REQUEST', '文件夹名不能包含路径分隔符');
    if (name.startsWith('.')) throw new FolderError('BAD_REQUEST', '文件夹名不能以点开头');
    if (name === SKILL_META_DIRNAME) throw new FolderError('BAD_REQUEST', `「${SKILL_META_DIRNAME}」是保留目录名`);
    if (sanitizeName(name) !== name) throw new FolderError('BAD_REQUEST', '文件夹名包含不可用的字符');
    return name;
  }

  /** 目标文件夹必须已存在且确实是目录。 */
  private requireFolderExists(name: string): void {
    const dir = path.join(this.skillsDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      throw new FolderError('BAD_REQUEST', `文件夹不存在：${name}`);
    }
    if (!stat.isDirectory()) throw new FolderError('BAD_REQUEST', `不是文件夹：${name}`);
  }

  /** 列出文件夹里的技能子目录（含 SKILL.md）；非技能内容忽略，不留半成品记录。 */
  private collectFolderSkills(folder: string): MovedSkill[] {
    const dir = path.join(this.skillsDir, folder);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: MovedSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const child = path.join(dir, entry.name);
      if (!isSkillDir(child)) continue;
      const meta = readSkillMeta(this.skillsDir, entry.name);
      out.push({ skillId: meta?.skillId ?? '', dirName: entry.name, previousPath: child });
    }
    return out;
  }

  /**
   * 全量重扫（也是「重建索引」的实现）：扫描 → 与元数据对账 → 写回元数据/事件 → 整体替换索引。
   * 纯派生：不改技能文件内容；新事件只在真实状态迁移时产生（新登记/内容变更），
   * 索引重建（DB 删除后）对已有元数据不产生任何事件。
   */
  rescan(): Promise<RescanResult> {
    // 已在本进程写锁链内（例如「保存文件 → 刷新索引」）：直接同步扫描。
    // 否则会排在一个正在等这把锁的重扫之后，而那个重扫又在等本次保存释放锁 → 互相等待。
    // doRescan 是同步实现，直接执行不会与其它扫描交错。
    if (this.lock?.heldByCurrentChain) {
      try {
        return Promise.resolve(this.doRescan());
      } catch (err) {
        return Promise.reject(err);
      }
    }
    const run = () =>
      this.lock != null
        ? this.lock.runExclusive('rescan', () => Promise.resolve().then(() => this.doRescan()))
        : Promise.resolve().then(() => this.doRescan());
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private doRescan(): RescanResult {
    const now = new Date().toISOString();
    const scanned = scanSkillsDir(this.skillsDir);
    const scannedDirNames = new Set(scanned.skills.map((s) => s.dirName));
    const metaDirNames = listMetaDirNames(this.skillsDir);
    const previous = this.index.listPrevious();

    const records: SkillIndexRecord[] = [];
    const events: ActivityEvent[] = [];
    let added = 0;
    let changed = 0;
    let restored = 0;

    for (const s of scanned.skills) {
      const { hash, sizeBytes } = hashAndSizeSkillDir(s.path);
      let meta = readSkillMeta(this.skillsDir, s.dirName);

      if (!meta) {
        // 首次入库：生成稳定 ID 并持久到元数据文件；索引重建时复用，不重新生成
        meta = {
          schemaVersion: SKILL_META_SCHEMA_VERSION,
          skillId: generateSkillId(),
          dirName: s.dirName,
          relPath: s.relPath,
          name: s.name,
          nameSource: s.nameSource,
          description: s.description,
          groups: [],
          source: { type: 'scan', importedAt: now, sourceRelPath: s.dirName },
          sync: { agents: [] },
          contentHash: hash,
          contentHashAt: now,
          sizeBytes,
          addedAt: now,
          updatedAt: now,
        };
        this.writeMeta(meta);
        added++;
        events.push(
          this.activity.append({
            skillId: meta.skillId,
            type: 'imported',
            occurredAt: now,
            detail: `扫描入库：${s.dirName}`,
          }),
        );
        this.logger?.info('library:skill-added', { skillId: meta.skillId, dirName: s.dirName });
      } else {
        let dirty = false;
        // 位置对账（用户手动把技能挪进/挪出一层子目录后自动跟随）：
        // 纯位置修正，不改 updatedAt、不产生事件
        if (meta.relPath !== s.relPath) {
          meta.relPath = s.relPath;
          dirty = true;
        }
        if (meta.contentHash !== hash) {
          meta.contentHash = hash;
          meta.contentHashAt = now;
          meta.sizeBytes = sizeBytes;
          meta.updatedAt = now;
          dirty = true;
          changed++;
          events.push(
            this.activity.append({
              skillId: meta.skillId,
              type: 'content-changed',
              occurredAt: now,
              detail: `内容变更：${s.dirName}`,
            }),
          );
        }
        // 旧元数据缺 sizeBytes 时回填（T02 扩展；不产生事件）
        if (meta.sizeBytes == null) {
          meta.sizeBytes = sizeBytes;
          dirty = true;
        }
        // SKILL.md 名称/描述与磁盘对账（名称变化必然伴随哈希变化，此处只是同步字段）
        if (meta.name !== s.name || meta.description !== s.description || meta.nameSource !== s.nameSource) {
          meta.name = s.name;
          meta.description = s.description;
          meta.nameSource = s.nameSource;
          meta.updatedAt = now;
          dirty = true;
        }
        if (dirty) this.writeMeta(meta);
      }

      const prev = previous.get(meta.skillId);
      if (prev?.missing) {
        restored++; // 丢失→恢复：状态自动复原，ID 不变
        this.logger?.info('library:skill-restored', { skillId: meta.skillId, dirName: s.dirName });
      }
      records.push(this.toRecord(meta, false, null));
    }

    // 元数据存在但目录消失 → 已丢失；保留元数据（Group/来源/同步配置），恢复后自动复原
    let missing = 0;
    for (const dirName of metaDirNames) {
      if (scannedDirNames.has(dirName)) continue;
      const meta = readSkillMeta(this.skillsDir, dirName);
      if (!meta) continue;
      const prev = previous.get(meta.skillId);
      const missingSince = prev?.missing ? prev.missingSince : now;
      missing++;
      records.push(this.toRecord(meta, true, missingSince));
      this.logger?.info('library:skill-missing', { skillId: meta.skillId, dirName });
    }

    this.index.replaceAll(records);
    this.notifyRescanned();
    return { total: records.length, added, changed, missing, restored, events };
  }

  /** 重扫完成回调（context 注入：触发 Agent 侧过期链接自愈）。回调异常不影响重扫结果。 */
  onRescanned: (() => void) | null = null;

  private notifyRescanned(): void {
    if (this.onRescanned == null) return;
    try {
      this.onRescanned();
    } catch (err) {
      this.logger?.info('library:on-rescanned-failed', { error: (err as Error).message });
    }
  }

  /**
   * 中心库列表（名称/描述/Group/来源/部署摘要），从索引读取；可按来源类型与 origin 过滤。
   * T03：注入部署探针后，deployedAgents = 意图 ∩ 实际链接，另给 configuredAgents /
   * configuredNotDeployed 供 UI 显示「已配置、未执行」（不自动部署）。
   */
  listSkills(filter?: { sourceType?: string; origin?: string }): SkillSummary[] {
    const all = this.index.list();
    const filtered = filter
      ? all.filter((s) => {
          if (!s.source) return false;
          if (filter.sourceType != null && s.source.type !== filter.sourceType) return false;
          if (filter.origin != null && !sameOrigin(s.source.origin, filter.origin)) return false;
          return true;
        })
      : all;
    if (this.deploymentProbe == null) return filtered;
    return filtered.map((s) => this.withDeployStatus(s));
  }

  /** T03：挂载部署状态探针（部署服务提供）；传 null 恢复 T01 语义。 */
  setDeploymentProbe(probe: DeploymentStatusProbe | null): void {
    this.deploymentProbe = probe;
  }

  private withDeployStatus<T extends SkillSummary>(summary: T): T {
    const probe = this.deploymentProbe;
    if (probe == null) return summary;
    const intent = summary.deployedAgents;
    const { deployed, configured } = probe.verify({
      skillId: summary.skillId,
      dirName: summary.dirName,
      deployedAgents: intent,
    });
    return {
      ...summary,
      deployedAgents: deployed,
      configuredAgents: configured,
      configuredNotDeployed: configured.length > deployed.length,
    };
  }

  /** 技能详情；含按需构建的真实文件树（不预读文件内容）。 */
  getSkillDetail(skillId: string): SkillDetail | null {
    const row = this.index.getFull(skillId);
    if (!row) return null;
    const dir = skillsDirJoin(this.skillsDir, row.relPath);
    const fileTree = row.missing ? null : buildFileTree(dir);
    const { contentHash: _contentHash, ...summary } = row;
    return { ...this.withDeployStatus(summary), contentHash: row.contentHash, fileTree };
  }

  /** 近期动态：每技能只显示最新一条（创建/导入/内容变更/部署状态变化），按时间倒序。 */
  getRecentActivity(): ActivityEvent[] {
    return this.activity.loadRecentPerSkill();
  }

  /**
   * T02+：导入/重导入等外部流程追加活动事件（真实发生时间取当前时刻）。
   * 索引重建不产生事件；此入口仅供真实状态迁移（导入成功/内容被替换）调用。
   */
  appendEvent(skillId: string, type: ActivityType, detail: string): ActivityEvent {
    return this.activity.append({
      skillId,
      type,
      occurredAt: new Date().toISOString(),
      detail,
    });
  }

  /**
   * T02+：导入/重导入等外部流程写入技能元数据（走与重扫相同的自写回声抑制路径，
   * 保证文件监视不会把本应用写入当成外部改动）。
   */
  writeExternalMeta(meta: SkillMetadataFile): void {
    this.writeMeta(meta);
  }

  /** 事件总数（验证「重建前后事件数量不变」用）。 */
  getActivityCount(): number {
    return this.activity.count();
  }

  /** 启动文件监视 + 3 秒轮询兜底。 */
  startWatching(): void {
    if (this.watcher) return;
    this.watcher = new LibraryWatcher({
      dir: this.skillsDir,
      onExternalChange: (paths) => {
        this.logger?.info('library:external-change', { paths: paths.length });
        void this.rescan();
      },
    });
    this.watcher.start();
  }

  stopWatching(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  close(): void {
    this.stopWatching();
    this.index.close();
  }

  private writeMeta(meta: SkillMetadataFile): void {
    // 先登记自写抑制窗口，再落盘：监视回声按路径跳过，外部真实改动不受影响
    this.watcher?.noteSelfWrite(skillMetaPath(this.skillsDir, meta.dirName));
    writeSkillMeta(this.skillsDir, meta);
  }

  private toRecord(
    meta: SkillMetadataFile,
    missing: boolean,
    missingSince: string | null,
  ): SkillIndexRecord {
    return {
      skillId: meta.skillId,
      dirName: meta.dirName,
      relPath: meta.relPath ?? meta.dirName,
      name: meta.name,
      description: meta.description,
      nameSource: meta.nameSource,
      groups: meta.groups,
      sourceJson: JSON.stringify(meta.source),
      syncJson: JSON.stringify(meta.sync),
      contentHash: meta.contentHash,
      sizeBytes: meta.sizeBytes ?? null,
      missing,
      missingSince,
      addedAt: meta.addedAt,
      updatedAt: meta.updatedAt,
    };
  }
}
