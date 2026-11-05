/**
 * 来源与安装入库服务（T02：prd.md M2/M7、tec.md §5.2/§5.7/§6.3）。
 *
 * 发现：本地目录 / Git 仓库（--depth 1 克隆到 TEMP）/ 压缩包（解压到 TEMP）/ 扫描本机
 * （调用方传入的一组 agent 技能目录）。发现结果是临时列表，不形成来源记录。
 *
 * 统一入库 importSkills：逐项 源校验 → 名称清洗 → 重名判定（同名同内容=已入库跳过；
 * 同名不同内容=单项失败，不覆盖不改名）→ 复制到 TEMP 暂存 → 原子移入库内 →
 * 记录来源与内容哈希 → 发 imported 事件。批量单项失败不影响其他项；支持 abort：
 * 立即停止、TEMP 清空、库内无半成品、已成功项保留并如实返回。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { hashAndSizeSkillDir, hashSkillDir, sameSkillIgnoringEol, isIgnoredDirName, isIgnoredFileName } from '../content-hash';
import { findSkillMdFile, isSkillDir, readSkillMd } from '../frontmatter';
import { isPathSafe, sanitizeName, validateNewDirName } from '../path-guard';
import { generateSkillId } from '../skill-id';
import { SkillLibraryService } from '../library';
import { readSkillMeta, SKILL_META_SCHEMA_VERSION, skillsDirJoin } from '../../infra/fs-meta';
import type { WriteLock } from '../../infra/write-lock';
import { gitCloneShallow, gitRevision, validateGitSource } from '../../infra/git-clone';
import { extractZipSafe } from '../../infra/zip-extract';
import { discoverInDir, discoverRecursive } from './discovery';
import type {
  DiscoveryResult,
  DiscoveredSkill,
  ImportBatchResult,
  ImportItem,
  ImportItemResult,
  ImportOptions,
} from './types';
import { SourceError as SourceErrorClass } from './types';
import type { SkillMetadataFile, SkillSourceInfo } from '../types';
import { MAX_GROUP_LENGTH } from '../types';

export interface SkillSourceServiceOptions {
  library: SkillLibraryService;
  /** 临时目录（TEMP_DIR；开发/测试为 tests/runtime/tmp-dev） */
  tempDir: string;
  /**
   * T08：跨进程写锁。传入后 importSkills 与 GUI 的部署、删除共用同一把锁，
   * 避免「CLI 正在入库、GUI 正在重扫/改名」互相踩。锁可重入，故部署服务的灰灯入库
   * （adoptExisting 已持锁）可以安全嵌套调用。
   */
  lock?: WriteLock;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
}

export class SkillSourceService {
  private readonly library: SkillLibraryService;
  private readonly tempDir: string;
  private readonly lock: WriteLock | undefined;
  private readonly logger: SkillSourceServiceOptions['logger'];
  private abortFlag = false;

  constructor(opts: SkillSourceServiceOptions) {
    this.library = opts.library;
    this.tempDir = path.resolve(opts.tempDir);
    this.lock = opts.lock;
    this.logger = opts.logger;
    fs.mkdirSync(this.tempDir, { recursive: true });
  }

  // ────────────────────────── 发现（不落任何记录） ──────────────────────────

  /** 本地目录：直接扫描（目录本身是技能 → 单项；否则枚举子目录，含无效项）。 */
  discoverFromLocalDir(dir: string): DiscoveryResult {
    const items = discoverInDir(dir, { type: 'local-dir', origin: path.resolve(dir) }, true);
    return { items };
  }

  /**
   * Git 仓库：`git clone --depth 1` 到 TEMP 会话目录后扫描。
   * 网络/凭据失败抛 SourceError（code + detail）。
   */
  discoverFromGit(url: string, opts?: { branch?: string }): DiscoveryResult {
    const origin = url.trim();
    validateGitSource(origin);
    const sessionDir = this.mkSession('git');
    let repoDir: string;
    try {
      repoDir = path.join(sessionDir, 'repo');
      gitCloneShallow(origin, repoDir, { branch: opts?.branch });
    } catch (err) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      throw err;
    }
    const revision = gitRevision(repoDir);
    const items = discoverRecursive(repoDir, { type: 'git', origin,
      ...(opts?.branch ? { sourceBranch: opts.branch } : {}),
      ...(revision ? { sourceRevision: revision } : {}) });
    return { items, sessionDir };
  }

  /** 压缩包：解压到 TEMP 会话目录后扫描；仅支持 .zip，其余格式明确报「暂不支持」。 */
  discoverFromZip(zipPath: string): DiscoveryResult {
    const origin = path.resolve(zipPath);
    const sessionDir = this.mkSession('zip');
    try {
      extractZipSafe(origin, path.join(sessionDir, 'extract'));
    } catch (err) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      throw err;
    }
    const items = discoverRecursive(path.join(sessionDir, 'extract'), { type: 'zip', origin });
    return { items, sessionDir };
  }

  /**
   * 扫描本机：对调用方传入的一组 agent 技能目录枚举技能（目录列表由参数传入，
   * T03 接真实配置）。inLibrary 按清洗名提示是否已入库；导入时仍按内容判定。
   */
  discoverFromAgentDirs(agentDirs: string[]): DiscoveryResult {
    const libraryDirNames = new Set(this.library.listSkills().map((s) => s.dirName));
    const items: DiscoveredSkill[] = [];
    for (const dir of agentDirs) {
      const found = discoverInDir(dir, { type: 'machine-scan', origin: path.resolve(dir) }, false);
      for (const it of found) {
        it.inLibrary = libraryDirNames.has(sanitizeName(it.name));
        items.push(it);
      }
    }
    return { items };
  }

  // ────────────────────────── 统一入库 ──────────────────────────

  /** 外部触发中止：当前批次在下一项边界立即停止（单项内各阶段亦检查）。 */
  abort(): void {
    this.abortFlag = true;
  }

  /** 清空 TEMP_DIR（含所有发现会话与暂存目录）。 */
  clearTempDir(): void {
    fs.rmSync(this.tempDir, { recursive: true, force: true });
    fs.mkdirSync(this.tempDir, { recursive: true });
  }

  /**
   * 批量导入。逐项返回 {skillId, status, reason}；单项失败不影响其他项；
   * 中止后剩余项标记 failed/ABORTED，已成功项保留。finally 中清理 TEMP 并重扫索引。
   * T08：注入 lock 时整批在跨进程写锁内执行（与 GUI 部署/删除串行）。
   */
  async importSkills(items: ImportItem[], opts: ImportOptions = {}): Promise<ImportBatchResult> {
    if (this.lock == null) return this.doImportSkills(items, opts);
    return this.lock.runExclusive('import-skills', () => this.doImportSkills(items, opts));
  }

  /**
   * 用户确认后，把扫描到的实体 Skill 复制覆盖同名中心库目录；保留库内 Skill ID 与同步意图。
   * opts.source 用于把来源记录改写为提供这份内容的来源（技能市场覆盖时用），不传则保留原来源。
   */
  async replaceFromScan(
    sourcePath: string,
    dirName: string,
    sourceHash: string,
    targetHash: string,
    opts: { eventLabel?: string; source?: { origin: string; sourceRelPath?: string } } = {},
  ): Promise<{ skillId: string }> {
    const run = async () => {
      const src = path.resolve(sourcePath);
      const meta = readSkillMeta(this.library.skillsDir, dirName);
      // 替换目标 = 该技能当前在库内的位置（可能被用户手动挪进一层子目录）
      const dest = meta
        ? skillsDirJoin(this.library.skillsDir, meta.relPath)
        : path.join(this.library.skillsDir, dirName);
      if (!meta || !isPathSafe(this.library.skillsDir, dest) || !fs.lstatSync(dest).isDirectory()) {
        throw new SourceErrorClass('NAME_CONFLICT', '中心库目标已变化，请重新扫描');
      }
      const sourceReal = fs.realpathSync(src);
      const targetReal = fs.realpathSync(dest);
      if (!isSkillDir(src) || isPathSafe(sourceReal, targetReal) || isPathSafe(targetReal, sourceReal) ||
          hashSkillDir(src) !== sourceHash || hashSkillDir(dest) !== targetHash) {
        throw new SourceErrorClass('STALE_SCAN', '内容已变化，请重新查看差异');
      }
      const staged = path.join(this.tempDir, `s-${crypto.randomUUID().slice(0, 8)}`);
      const rollback = path.join(this.tempDir, `rollback-${crypto.randomUUID().slice(0, 8)}`);
      let touched = false;
      let restored = false;
      let committed = false;
      try {
        copySkillTree(src, staged, true);
        if (!isSkillDir(staged) || hashSkillDir(staged) !== sourceHash) {
          throw new SourceErrorClass('STALE_SCAN', '来源内容已变化，请重新查看差异');
        }
        if (hashSkillDir(dest) !== targetHash) throw new SourceErrorClass('STALE_SCAN', '中心库内容已变化，请重新查看差异');
        fs.cpSync(dest, rollback, { recursive: true, dereference: false, preserveTimestamps: true });
        if (hashSkillDir(rollback) !== targetHash) throw new Error('中心库临时回滚副本校验失败');
        touched = true;
        mirrorSkillTree(staged, dest);
        const { hash, sizeBytes } = hashAndSizeSkillDir(dest);
        if (hash !== sourceHash) throw new Error('复制结果校验失败');
        const now = new Date().toISOString();
        const md = readSkillMd(dest);
        const frontName = md?.meta.name ? sanitizeName(md.meta.name) : '';
        const source: SkillSourceInfo = opts.source == null ? meta.source : {
          type: 'market',
          origin: opts.source.origin,
          importedAt: meta.source.importedAt,
          ...(opts.source.sourceRelPath == null ? {} : { sourceRelPath: opts.source.sourceRelPath }),
          sourceHash: hash,
        };
        this.library.writeExternalMeta({ ...meta,
          name: frontName || dirName,
          nameSource: frontName ? 'frontmatter' : 'dirname',
          description: md?.meta.description ?? '',
          source,
          contentHash: hash, contentHashAt: now, sizeBytes, updatedAt: now,
        });
        await this.library.rescan();
        this.library.appendEvent(meta.skillId, 'content-changed', `${opts.eventLabel ?? '从本机扫描覆盖'}：${dirName}`);
        committed = true;
        return { skillId: meta.skillId };
      } catch (err) {
        if (touched) {
          try {
            mirrorSkillTree(rollback, dest);
            this.library.writeExternalMeta(meta);
            await this.library.rescan();
            restored = true;
          } catch (restoreError) {
            throw new SourceErrorClass('APPLY_FAILED', `覆盖失败且恢复原内容失败，临时副本位于 ${rollback}：${(restoreError as Error).message}`);
          }
        }
        throw err;
      } finally {
        fs.rmSync(staged, { recursive: true, force: true });
        if (committed || restored || !touched) fs.rmSync(rollback, { recursive: true, force: true });
      }
    };
    return this.lock ? this.lock.runExclusive('scan-overwrite', run) : run();
  }

  private async doImportSkills(items: ImportItem[], opts: ImportOptions = {}): Promise<ImportBatchResult> {
    this.abortFlag = false;
    const checkAborted = (): boolean => this.abortFlag || opts.signal?.aborted === true;
    const staging: string[] = [];
    const results: ImportItemResult[] = [];
    let aborted = false;

    try {
      for (let i = 0; i < items.length; i++) {
        if (checkAborted()) {
          aborted = true;
          for (let j = i; j < items.length; j++) {
            results.push(abortedResult(items[j]));
          }
          break;
        }
        const r = this.importOne(items[i], staging, checkAborted);
        results.push(r);
        opts.onProgress?.(r);
        // 让出事件循环：外部（UI/测试）可在项间触发 abort
        await Promise.resolve();
      }
    } finally {
      for (const d of staging) fs.rmSync(d, { recursive: true, force: true });
      if (opts.sessionDir) fs.rmSync(opts.sessionDir, { recursive: true, force: true });
      await this.library.rescan();
    }
    return { results, aborted };
  }

  private importOne(
    item: ImportItem,
    staging: string[],
    checkAborted: () => boolean,
  ): ImportItemResult {
    const srcDir = path.resolve(item.path);
    const fallbackName = path.basename(srcDir);
    const sourceName = readSkillMd(srcDir)?.meta.name ?? fallbackName;
    const override = item.nameOverride?.trim();
    const display = override || sourceName;

    // 1) 源校验：必须是技能目录
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory() || !isSkillDir(srcDir)) {
      return failed(display, 'NOT_A_SKILL', '不是技能目录（缺少 SKILL.md），无法导入');
    }

    // 2) 名称清洗（任何来自外部的名字都过 path-guard）
    const cleaned = validateNewDirName(display);
    if (cleaned == null) {
      return failed(display, 'INVALID_NAME', `技能名称清洗后无效：${JSON.stringify(display)}`);
    }
    // 库内已有同名技能（元数据存在）→ 沿用其现有位置（可能是手动分组后的一层子目录）；
    // 没有（或目录已丢失）→ 平铺 skills/<dirName>。重新入库绝不制造同名两份。
    const existingMeta = readSkillMeta(this.library.skillsDir, cleaned);
    const dest = existingMeta
      ? skillsDirJoin(this.library.skillsDir, existingMeta.relPath)
      : path.join(this.library.skillsDir, cleaned);
    if (!isPathSafe(this.library.skillsDir, dest)) {
      return failed(display, 'INVALID_NAME', '清洗后的目标路径越出库目录');
    }

    try {
      let staged: string | null = null;
      if (override && override !== sourceName) {
        staged = path.join(this.tempDir, `s-${crypto.randomUUID().slice(0, 8)}`);
        staging.push(staged);
        copySkillTree(srcDir, staged, item.source.type === 'machine-scan' || item.source.type.startsWith('agent:'));
        writeSkillName(staged, override);
      }
      const effectiveSrc = staged ?? srcDir;
      // 3) 重名判定（重命名目录前完成，失败项零 IO 落库）
      if (fs.existsSync(dest)) {
        const stagedHash = hashSkillDir(effectiveSrc);
        let existingHash: string | null = existingMeta?.contentHash ?? null;
        if (existingHash == null) {
          const st = fs.lstatSync(dest);
          if (!st.isDirectory()) {
            return failed(display, 'TARGET_NOT_DIRECTORY', '库内同名位置存在非目录文件，无法导入');
          }
          existingHash = hashSkillDir(dest);
        }
        // 字节哈希不同时再问一次「是否只差行尾符」：Windows git 检出（CRLF）与市场 / GitHub（LF）
        // 是同一份内容，不该报成同名异内容。
        const sameIgnoringEol = existingHash !== stagedHash &&
          fs.lstatSync(dest).isDirectory() &&
          sameSkillIgnoringEol(effectiveSrc, dest);
        if (existingHash === stagedHash || sameIgnoringEol) {
          // 市场安装命中「库内已有同名同内容」时补记来源：市场页的「已入库」按来源判定
          // （type=market 且 origin 等于该条目地址），不补记则先前经扫描/Git 入库的同名技能
          // 在市场上永远显示「安装」，且每点一次都走这条跳过分支。
          this.adoptMarketSource(item, existingMeta);
          return {
            name: display,
            skillId: existingMeta?.skillId ?? null,
            status: 'already-in-library',
            reason: '同名同内容，已入库，跳过',
          };
        }
        return failed(
          display,
          'NAME_CONFLICT',
          '中心库已存在同名但内容不同的 Skill',
        );
      }

      // 4) 暂存复制到 TEMP（剥离 .git/__pycache__ 等忽略项与符号链接）
      if (!staged) {
        staged = path.join(this.tempDir, `s-${crypto.randomUUID().slice(0, 8)}`);
        staging.push(staged);
        copySkillTree(srcDir, staged, item.source.type === 'machine-scan' || item.source.type.startsWith('agent:'));
      }
      if (checkAborted()) {
        return abortedResult(item);
      }
      if (!isSkillDir(staged)) {
        return failed(display, 'NOT_A_SKILL', '复制到暂存目录后校验失败：缺少 SKILL.md');
      }

      // 5) 原子移入库内（同卷 rename；跨卷回退到库内暂存名 + rename）
      this.moveIntoLibrary(staged, dest, item.source.type === 'machine-scan' || item.source.type.startsWith('agent:'));

      try {
        // 6) 记录来源与内容哈希 + imported 事件
        const { hash, sizeBytes } = hashAndSizeSkillDir(dest);
        const now = new Date().toISOString();
        const meta: SkillMetadataFile = {
          schemaVersion: SKILL_META_SCHEMA_VERSION,
          skillId: generateSkillId(),
          dirName: cleaned,
          // 实际落点：沿用同名已有技能的 relPath；新入库 = 平铺
          relPath: existingMeta?.relPath ?? cleaned,
          name: override || this.libraryNameOf(srcDir, cleaned),
          nameSource: override ? 'frontmatter' : readSkillMd(srcDir)?.meta.name != null ? 'frontmatter' : 'dirname',
          description: readSkillMd(srcDir)?.meta.description ?? '',
          groups: normalizeImportGroups(item.groups),
          source: {
            type: item.source.type,
            origin: item.source.origin,
            importedAt: now,
            sourceRelPath: item.source.sourceRelPath ?? fallbackName,
            sourceHash: override && override !== sourceName ? hashSkillDir(srcDir) : hash,
            ...(item.source.sourceBranch ? { sourceBranch: item.source.sourceBranch } : {}),
            ...(item.source.sourceRevision ? { sourceRevision: item.source.sourceRevision } : {}),
          },
          sync: { agents: [] },
          contentHash: hash,
          contentHashAt: now,
          sizeBytes,
          addedAt: now,
          updatedAt: now,
        };
        this.library.writeExternalMeta(meta);
        this.library.appendEvent(
          meta.skillId,
          'imported',
          `导入：${cleaned}（来源 ${item.source.type}）`,
        );
        this.logger?.info('sources:skill-imported', { skillId: meta.skillId, dirName: cleaned });
        return { name: display, skillId: meta.skillId, status: 'imported' };
      } catch (err) {
        // 元数据/事件写入失败 → 回滚本次入库，不留半成品
        fs.rmSync(dest, { recursive: true, force: true });
        return failed(display, 'META_WRITE_FAILED', `元数据写入失败，已回滚：${(err as Error).message}`);
      }
    } catch (err) {
      return failed(display, 'IMPORT_FAILED', `导入失败：${(err as Error).message}`);
    }
  }

  /**
   * 「同名同内容已入库」时把来源补记为市场条目。
   * 只改 source（type / origin / sourceRelPath），保留首次入库时间、Group、同步意图与内容哈希；
   * 来源不属于内容变化，不动 updatedAt。索引由 doImportSkills 结束时的 rescan 重建。
   */
  private adoptMarketSource(item: ImportItem, existingMeta: SkillMetadataFile | null): void {
    if (existingMeta == null || item.source.type !== 'market') return;
    const origin = item.source.origin ?? '';
    if (origin.length === 0) return;
    if (existingMeta.source.type === 'market' && existingMeta.source.origin === origin) return;
    const source: SkillSourceInfo = {
      type: 'market',
      origin,
      importedAt: existingMeta.source.importedAt,
    };
    const sourceRelPath = item.source.sourceRelPath ?? existingMeta.source.sourceRelPath;
    if (sourceRelPath != null) source.sourceRelPath = sourceRelPath;
    source.sourceHash = hashSkillDir(item.path);
    this.library.writeExternalMeta({ ...existingMeta, source });
    this.logger?.info('sources:market-source-adopted', {
      skillId: existingMeta.skillId,
      dirName: existingMeta.dirName,
      origin,
    });
  }

  private libraryNameOf(srcDir: string, cleaned: string): string {
    const md = readSkillMd(srcDir);
    if (md?.meta.name != null) {
      const s = sanitizeName(md.meta.name);
      if (s.length > 0) return s;
    }
    return cleaned;
  }

  /** 同卷 rename 原子移入；跨卷（EXDEV）回退为库内暂存名复制 + rename。 */
  private moveIntoLibrary(staged: string, dest: string, preserveMtime = false): void {
    try {
      fs.renameSync(staged, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      const inLibTmp = path.join(this.library.skillsDir, `.staging-${crypto.randomUUID().slice(0, 8)}`);
      copySkillTree(staged, inLibTmp, preserveMtime);
      fs.rmSync(staged, { recursive: true, force: true });
      try {
        fs.renameSync(inLibTmp, dest);
      } catch (err2) {
        fs.rmSync(inLibTmp, { recursive: true, force: true });
        throw err2;
      }
    }
  }

  // ────────────────────────── 内部工具 ──────────────────────────

  private mkSession(prefix: string): string {
    const dir = path.join(this.tempDir, `${prefix}-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

// ── 纯函数工具 ──

function writeSkillName(dir: string, name: string): void {
  const skillFile = findSkillMdFile(dir);
  if (!skillFile) throw new Error('技能目录缺少 SKILL.md');
  const file = path.join(dir, skillFile);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  const end = lines[0]?.trim() === '---'
    ? lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    : -1;
  const parsed = end > 0 ? yaml.load(lines.slice(1, end).join('\n')) : null;
  const metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...(parsed as Record<string, unknown>) }
    : {};
  metadata.name = name;
  const body = end > 0 ? lines.slice(end + 1).join('\n') : content;
  fs.writeFileSync(file, `---\n${yaml.dump(metadata, { lineWidth: -1 }).trimEnd()}\n---\n${body}`, 'utf8');
}

function failed(name: string, code: string, reason: string): ImportItemResult {
  return { name, skillId: null, status: 'failed', reason, code };
}

/**
 * 导入时携带的标签（本机扫描来自嵌套目录的 group 名）：去空、去重、限长。
 * 非法项静默丢弃——标签只是元数据，不该让整次入库失败。
 */
function normalizeImportGroups(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name.length === 0 || name.length > MAX_GROUP_LENGTH) continue;
    out.add(name);
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function abortedResult(item: ImportItem): ImportItemResult {
  return {
    name: path.basename(path.resolve(item.path)),
    skillId: null,
    status: 'failed',
    reason: '导入已取消（abort）',
    code: 'ABORTED',
  };
}

/** 递归复制技能树：剥离忽略项（.git/__pycache__/node_modules/Thumbs.db/.DS_Store/*.pyc）与符号链接。 */
function copySkillTree(src: string, dst: string, preserveMtime = false): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (isIgnoredDirName(entry.name) || isIgnoredFileName(entry.name)) continue;
    if (entry.isSymbolicLink()) continue; // 不跟随链接（防止源外内容被带入库）
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copySkillTree(from, to, preserveMtime);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      if (preserveMtime) {
        const stat = fs.statSync(from);
        fs.utimesSync(to, stat.atime, stat.mtime);
      }
    }
  }
}

/** 在既有技能目录内逐项复制/删除，保留根目录本身（Windows watcher 会占用该目录句柄）。 */
function mirrorSkillTree(src: string, dst: string): void {
  const sourceEntries = fs.readdirSync(src, { withFileTypes: true });
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
  for (const entry of fs.readdirSync(dst, { withFileTypes: true })) {
    if (!sourceNames.has(entry.name)) fs.rmSync(path.join(dst, entry.name), { recursive: true, force: true });
  }
  for (const entry of sourceEntries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    let existing: fs.Stats | null = null;
    try { existing = fs.lstatSync(to); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (entry.isDirectory() && existing?.isDirectory()) {
      mirrorSkillTree(from, to);
      continue;
    }
    if (entry.isFile() && existing?.isFile()) {
      fs.copyFileSync(from, to);
      const stat = fs.statSync(from);
      fs.utimesSync(to, stat.atime, stat.mtime);
      continue;
    }
    if (existing) fs.rmSync(to, { recursive: true, force: true });
    if (entry.isDirectory()) {
      fs.mkdirSync(to);
      mirrorSkillTree(from, to);
    } else {
      fs.cpSync(from, to, { recursive: true, dereference: false, preserveTimestamps: true });
    }
  }
}
