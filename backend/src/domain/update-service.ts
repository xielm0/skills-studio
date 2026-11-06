/** 来源更新：检查只读；用户查看差异后才允许覆盖中心库。 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WriteLock } from '../infra/write-lock';
import { readSkillMeta } from '../infra/fs-meta';
import { gitCloneShallowAsync, gitRevision } from '../infra/git-clone';
import { createFetchHttpClient, type MarketHttpClient } from './market/http';
import { downloadSkillHubSnapshot, latestSkillHubRelease, skillHubRef, skillHubUrl } from './market/skillhub-service';
import type { AgentConfigService } from './agents';
import { hashAndSizeSkillDir, hashSkillDir, isIgnoredDirName, isIgnoredFileName } from './content-hash';
import { isSkillDir } from './frontmatter';
import type { SkillLibraryService } from './library';
import { compareSkillDirs } from './skill-dir-diff';
import type { SkillMetadataFile, SkillSourceInfo } from './types';
import type { LibrarySyncDiffResult } from '../shared/ipc';

type UpdateState = { sourceKey: string; status: 'available' | 'up-to-date' | 'source-missing' | 'error'; error?: string };
type SourceSnapshot = { skillDir: string; relPath: string; sourceHash: string; sourceRevision?: string; sourceOrigin?: string; dispose(): void };
type Preview = SourceSnapshot & { sourceKey: string; targetHash: string };
type RepoSnapshot = { root: string; revision?: string; dispose(): void };

export class UpdateError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(detail);
    this.name = 'UpdateError';
  }
}

/** 来源标识随记录变化而失效，避免把旧检查结果显示在重新指向的 Skill 上。 */
function sourceKey(source: SkillSourceInfo): string {
  return JSON.stringify([source.type, source.origin ?? '', source.sourceRelPath ?? '', source.sourceHash ?? '', source.sourceBranch ?? '', source.sourceRevision ?? '']);
}

/** 拒绝绝对路径和穿越；'.' 表示来源根本身就是 Skill。 */
function sourceRelativePath(value: string | undefined): string {
  const rel = value ?? '';
  if (rel === '.') return rel;
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) {
    throw new UpdateError('SOURCE_PATH_INVALID', '来源中的 Skill 路径无效');
  }
  return rel.replace(/\\/g, '/');
}

/** 用与入库相同的忽略规则复制目录，且不跟随符号链接。 */
function copySkill(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (isIgnoredDirName(entry.name) || isIgnoredFileName(entry.name) || entry.isSymbolicLink()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copySkill(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/** 市场来源 value 是 skills.sh 条目地址；当前市场仅安装 GitHub 条目。 */
function marketRepository(source: SkillSourceInfo): { url: string; slug: string } {
  let parsed: URL;
  try { parsed = new URL(source.origin ?? ''); } catch { throw new UpdateError('SOURCE_INVALID', '市场来源地址无效'); }
  if (!['skills.sh', 'www.skills.sh'].includes(parsed.hostname.toLowerCase())) {
    throw new UpdateError('SOURCE_INVALID', '市场来源地址无效');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts.some((part) => !/^[\w.-]+$/.test(part))) {
    throw new UpdateError('SOURCE_INVALID', '市场来源不包含有效的仓库和 Skill 标识');
  }
  return { url: `https://github.com/${parts[0]}/${parts[1]}.git`, slug: parts[2] };
}

export class SkillUpdateService {
  private readonly states = new Map<string, UpdateState>();
  private readonly previews = new Map<string, Preview>();
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly opts: {
    library: SkillLibraryService;
    agents: AgentConfigService;
    tempDir: string;
    lock: WriteLock;
    marketHttp?: MarketHttpClient;
    logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
  }) {}

  /** 应用启动后延迟一轮，以后每天检查；不在测试上下文自动启动。 */
  start(): void {
    if (this.timer || this.disposed) return;
    const schedule = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.checkAll().catch((error: Error) => this.opts.logger?.error('updates:check-failed', { error: error.message }))
          .finally(() => { if (!this.disposed) schedule(24 * 60 * 60 * 1000); });
      }, delay);
      this.timer.unref();
    };
    schedule(60_000);
  }

  /** 清理预览快照与计时器；库切换后旧服务不得继续写旧库。 */
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const preview of this.previews.values()) preview.dispose();
    this.previews.clear();
  }

  /** 列表仅读取内存检查结果；没有检查过不显示“有更新”。 */
  getState(skillId: string, source: SkillSourceInfo | null): UpdateState | null {
    if (!source || !this.supports(source)) return null;
    const state = this.states.get(skillId);
    return state?.sourceKey === sourceKey(source) ? state : null;
  }

  /** 后台只查 SkillHub 列表元数据，不下载文件。 */
  checkAll(): Promise<void> {
    if (this.checking) return this.checking;
    const run = async () => {
      for (const skill of this.opts.library.listSkills()) {
        const meta = readSkillMeta(this.opts.library.skillsDir, skill.dirName);
        if (!meta || !this.supports(meta.source)) continue;
        try {
          const ref = skillHubRef(meta.source.origin)!;
          const release = await latestSkillHubRelease(ref.slug, this.opts.marketHttp ?? createFetchHttpClient());
          this.states.set(skill.skillId, { sourceKey: sourceKey(meta.source),
            status: (meta.source.sourceRevision && release.version !== meta.source.sourceRevision)
              || (ref.publisher && release.publisher !== ref.publisher) ? 'available' : 'up-to-date' });
        } catch (error) {
          // 更新状态只显示“有更新”；检查不可用时清除旧状态，不在列表显示错误标签。
          this.states.delete(skill.skillId);
          this.opts.logger?.error('updates:check-item-failed', { skillId: skill.skillId,
            error: error instanceof Error ? error.message : String(error) });
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    this.checking = run().finally(() => { this.checking = null; });
    return this.checking;
  }

  /** 打开“查看更新”时冻结来源快照，逐文件读取都针对同一版本。 */
  async getDiff(skillId: string, relPath?: string, expected?: { sourceHash: string; targetHash: string }): Promise<LibrarySyncDiffResult & { sourceHash: string; targetHash: string }> {
    const meta = this.requireMeta(skillId);
    if (this.getState(skillId, meta.source)?.status !== 'available') {
      throw new UpdateError('UPDATE_UNSUPPORTED', '当前没有确认可用的市场更新');
    }
    let preview = this.previews.get(skillId);
    if (preview && relPath == null && expected == null) {
      preview.dispose();
      this.previews.delete(skillId);
      preview = undefined;
    }
    if (!preview || preview.sourceKey !== sourceKey(meta.source)) {
      preview?.dispose();
      const source = await this.openSource(meta);
      const frozenDir = path.join(this.opts.tempDir, `update-preview-${crypto.randomUUID()}`);
      try {
        copySkill(source.skillDir, frozenDir);
      } catch (error) {
        fs.rmSync(frozenDir, { recursive: true, force: true });
        throw error;
      } finally {
        source.dispose();
      }
      const targetHash = hashSkillDir(path.join(this.opts.library.skillsDir, meta.dirName));
      preview = { skillDir: frozenDir, relPath: source.relPath, sourceHash: hashSkillDir(frozenDir), targetHash,
        ...(source.sourceRevision ? { sourceRevision: source.sourceRevision } : {}),
        ...(source.sourceOrigin ? { sourceOrigin: source.sourceOrigin } : {}),
        sourceKey: sourceKey(meta.source), dispose: () => fs.rmSync(frozenDir, { recursive: true, force: true }) };
      this.previews.set(skillId, preview);
    }
    const targetDir = path.join(this.opts.library.skillsDir, meta.dirName);
    const stale = Boolean(expected && (expected.sourceHash !== preview.sourceHash || expected.targetHash !== preview.targetHash))
      || hashSkillDir(targetDir) !== preview.targetHash;
    if (stale) return { stale: true, sourceMtime: null, targetMtime: null, files: [], source: null, target: null,
      sourceHash: preview.sourceHash, targetHash: preview.targetHash };
    return { ...compareSkillDirs(preview.skillDir, targetDir, relPath), sourceHash: preview.sourceHash, targetHash: preview.targetHash };
  }

  /** 跳过不改基线；覆盖只应用用户预览的快照且校验中心库未发生变化。 */
  async apply(skillId: string, choice: 'skip' | 'overwrite', sourceHash: string, targetHash: string): Promise<{ updated: boolean }> {
    if (choice === 'skip') return { updated: false };
    const currentSource = await this.openSource(this.requireMeta(skillId));
    try {
      if (currentSource.sourceHash !== sourceHash) {
        throw new UpdateError('UPDATE_STALE', '来源内容已变化，请重新查看更新');
      }
    } finally {
      currentSource.dispose();
    }
    return this.opts.lock.runExclusive('skill-update', async () => {
      const meta = this.requireMeta(skillId);
      const preview = this.previews.get(skillId);
      const target = path.join(this.opts.library.skillsDir, meta.dirName);
      if (!preview || preview.sourceKey !== sourceKey(meta.source) || preview.sourceHash !== sourceHash ||
          preview.targetHash !== targetHash || hashSkillDir(target) !== targetHash) {
        throw new UpdateError('UPDATE_STALE', '来源或中心库内容已变化，请重新查看更新');
      }
      const id = crypto.randomUUID();
      const staged = path.join(this.opts.library.skillsDir, `.update-new-${id}`);
      const old = path.join(this.opts.library.skillsDir, `.update-old-${id}`);
      try { copySkill(preview.skillDir, staged); }
      catch (error) { fs.rmSync(staged, { recursive: true, force: true }); throw error; }
      if (!isSkillDir(staged) || hashSkillDir(staged) !== sourceHash) {
        fs.rmSync(staged, { recursive: true, force: true });
        throw new UpdateError('UPDATE_INVALID', '来源快照校验失败，中心库未修改');
      }
      try { fs.renameSync(target, old); }
      catch (error) { fs.rmSync(staged, { recursive: true, force: true }); throw error; }
      try {
        fs.renameSync(staged, target);
        const hashed = hashAndSizeSkillDir(target);
        const now = new Date().toISOString();
        this.opts.library.writeExternalMeta({ ...meta,
          source: { ...meta.source, ...(preview.sourceOrigin ? { origin: preview.sourceOrigin } : {}), sourceRelPath: preview.relPath, sourceHash,
            ...(preview.sourceRevision ? { sourceRevision: preview.sourceRevision } : {}) },
          contentHash: hashed.hash, contentHashAt: now, sizeBytes: hashed.sizeBytes, updatedAt: now });
        await this.opts.library.rescan();
        this.opts.library.appendEvent(skillId, 'content-changed', `来源更新：${meta.dirName}`);
        fs.rmSync(old, { recursive: true, force: true });
      } catch (error) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(old, target);
        this.opts.library.writeExternalMeta(meta);
        await this.opts.library.rescan();
        throw error;
      } finally {
        fs.rmSync(staged, { recursive: true, force: true });
      }
      preview.dispose();
      this.previews.delete(skillId);
      const current = readSkillMeta(this.opts.library.skillsDir, meta.dirName);
      if (current) this.states.set(skillId, { sourceKey: sourceKey(current.source), status: 'up-to-date' });
      return { updated: true };
    });
  }

  /** 仅支持有轻量版本元数据的市场；skills.sh 暂不提供更新检查。 */
  private supports(source: SkillSourceInfo): boolean {
    return source.type === 'market' && skillHubRef(source.origin) !== null;
  }

  /** 从稳定 ID 读取当前元数据，拒绝非市场来源。 */
  private requireMeta(skillId: string): SkillMetadataFile {
    const skill = this.opts.library.getSkillDetail(skillId);
    const meta = skill && readSkillMeta(this.opts.library.skillsDir, skill.dirName);
    if (!meta || !this.supports(meta.source)) throw new UpdateError('UPDATE_UNSUPPORTED', '该 Skill 没有可更新的来源');
    if (skill?.missing) throw new UpdateError('SKILL_MISSING', '中心库中的 Skill 已丢失');
    return meta;
  }

  /** 来源类型映射到实际磁盘目录；旧 Agent 记录只在能匹配本机配置时解析。 */
  private async openSource(meta: SkillMetadataFile, repositories?: Map<string, Promise<RepoSnapshot>>): Promise<SourceSnapshot> {
    const source = meta.source;
    let root: string;
    let dispose: () => void = () => undefined;
    let marketSlug: string | null = null;
    let sourceRevision: string | undefined;
    let sourceOrigin: string | undefined;
    const hubRef = source.type === 'market' ? skillHubRef(source.origin) : null;
    if (hubRef) {
      const http = this.opts.marketHttp ?? createFetchHttpClient();
      const release = await latestSkillHubRelease(hubRef.slug, http);
      sourceRevision = release.version;
      sourceOrigin = skillHubUrl(hubRef.slug, release.publisher);
      const snapshot = await downloadSkillHubSnapshot(hubRef.slug, this.opts.tempDir, http, sourceRevision, release.publisher);
      root = snapshot.dir;
      dispose = snapshot.dispose;
    } else if (source.type === 'market' || source.type === 'git') {
      const market = source.type === 'market' ? marketRepository(source) : null;
      const url = market?.url ?? source.origin ?? '';
      marketSlug = market?.slug ?? null;
      const repoKey = `${url}\0${source.sourceBranch ?? ''}`;
      const existing = repositories?.get(repoKey);
      const repoPromise = existing ?? this.cloneRepository(url, source.sourceBranch);
      if (repositories && !existing) repositories.set(repoKey, repoPromise);
      const repo = await repoPromise;
      root = repo.root;
      sourceRevision = repo.revision;
      if (!repositories) dispose = repo.dispose;
    } else {
      const agentId = source.type.startsWith('agent:') ? source.type.slice('agent:'.length) : null;
      const legacyAgent = source.type === 'machine-scan' || source.type === 'agent-dir'
        ? this.opts.agents.list().find((agent) => agent.name === source.origin || agent.id === source.origin) : null;
      root = agentId ? source.origin ?? '' : legacyAgent?.skillsDir ?? source.origin ?? '';
      if (!root || !path.isAbsolute(root)) throw new UpdateError('SOURCE_MISSING', '原始来源目录未记录或本机无法定位');
    }
    try {
    const rel = sourceRelativePath(source.sourceRelPath);
    let skillDir = rel === '.' ? root : path.join(root, ...rel.split('/'));
    let linkedSkill = false;
    if (source.type !== 'market' && source.type !== 'git') {
      let current = root;
      const parts = ['.', ...(rel === '.' ? [] : rel.split('/'))];
      for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) {
          if (index !== parts.length - 1) throw new UpdateError('SOURCE_LINKED', '来源路径包含中间链接，不参与更新检查');
          linkedSkill = true;
        }
      }
    }
    if (marketSlug && !isSkillDir(skillDir)) {
      const matches: string[] = [];
      const walk = (dir: string, depth: number): void => {
        if (depth > 6) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === '.git' || entry.name === 'node_modules') continue;
          const next = path.join(dir, entry.name);
          if (entry.name.toLowerCase() === marketSlug!.toLowerCase() && isSkillDir(next)) matches.push(next);
          walk(next, depth + 1);
        }
      };
      walk(root, 0);
      if (matches.length === 1) skillDir = matches[0];
    }
      const real = fs.realpathSync(skillDir);
      const realRoot = fs.realpathSync(root);
      const central = fs.realpathSync(this.opts.library.libraryDir);
      if (real === central || real.startsWith(central + path.sep)) {
        throw new UpdateError('SOURCE_MANAGED', '来源已成为中心库或受管理链接，不参与更新');
      }
      if (!linkedSkill && real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new UpdateError('SOURCE_PATH_INVALID', '来源中的 Skill 路径指向来源目录之外');
      }
      if (!isSkillDir(skillDir)) throw new UpdateError('SOURCE_MISSING', '来源中已找不到该 Skill');
      const actualRel = path.relative(root, skillDir).split(path.sep).join('/') || '.';
      return { skillDir, relPath: actualRel, sourceHash: hashSkillDir(skillDir),
        ...(sourceRevision ? { sourceRevision } : {}), ...(sourceOrigin ? { sourceOrigin } : {}), dispose };
    } catch (error) {
      dispose();
      if (error instanceof UpdateError) throw error;
      throw new UpdateError('SOURCE_MISSING', '来源中已找不到该 Skill');
    }
  }

  /** 克隆到 TEMP_DIR，异常时清理不完整目录。 */
  private async cloneRepository(url: string, branch?: string): Promise<RepoSnapshot> {
    const session = path.join(this.opts.tempDir, `update-repo-${crypto.randomUUID()}`);
    const root = path.join(session, 'repo');
    try {
      await gitCloneShallowAsync(url, root, { branch });
      return { root, revision: gitRevision(root), dispose: () => fs.rmSync(session, { recursive: true, force: true }) };
    } catch (error) {
      fs.rmSync(session, { recursive: true, force: true });
      throw error;
    }
  }
}
