/**
 * 安装 Skills 服务（T12：ui.md「安装 Skills」、prd.md M7/M12、tec.md §5.2/§5.12）。
 *
 * 五个来源共用同一条流程：发现（只读，不落库）→ 渲染层多选 → 服务端按 key 解析
 * 真实来源 → 复用 T02 importSkills / T05 installItems 入库。导入不自动部署。
 *
 * 安全边界（tec.md §7.1）：
 *  - 本地目录 / 压缩包路径必须来自 app:pickDirectory / app:pickFile（服务端白名单），
 *    渲染层传任意路径一律 BAD_REQUEST；
 *  - 导入只接受「最近一次发现列表」里的 key，key → 真实路径/市场条目的映射只存在主进程，
 *    渲染层无法拼出路径让主进程读盘。
 *
 * 缓存生命周期：每个通道只保留最近一次发现结果（git/zip 的 TEMP 解包目录随之保留，
 * 供重复导入使用），新一次发现或上下文销毁时清理。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentError } from './agents';
import type { AgentConfigService } from './agents';
import type { SkillLibraryService } from './library';
import type { MarketService } from './market/market-service';
import { SkillHubService, SKILLHUB_SOURCE, skillHubUrl } from './market/skillhub-service';
import type { MarketItem, MarketItemRef } from './market/types';
import { buildUpstreamUrl } from './market/parse';
import type { SkillSourceService } from './sources/source-service';
import type { DiscoveredSkill, ImportItem } from './sources/types';
import { groupOfSkillRelPath, isPathSafe, sanitizeName, validateNewDirName } from './path-guard';
import { isSkillDir, readSkillMd } from './frontmatter';
import { buildFileTree } from './file-tree';
import { readTextFileInDir } from './catalog';
import type { FileTreeNode } from './types';
import type { PlacementStore } from './placement-store';
import { groupDiscovered, scanLocalSkills, type DiscoveredToolSkill } from './tool-scanner';
import { hashAndSizeSkillDir, hashSkillDir, sameSkillIgnoringEol, skillContentMtime } from './content-hash';
import { compareSkillDirs } from './skill-dir-diff';
import { libraryDestDirOf, readSkillMeta, skillsDirJoin } from '../infra/fs-meta';
import type {
  InstallChannel,
  InstallConflictChannel,
  InstallDiscoveryResult,
  InstallImportItemResult,
  InstallImportRequest,
  InstallImportResult,
  InstallItemView,
  InstallMarketItem,
  InstallMarketDescriptionResult,
  InstallMarketDiffRequest,
  InstallMarketListResult,
  InstallMarketPreviewRequest,
  InstallMarketPreviewResult,
  InstallMarketReadFileResult,
  InstallMarketResolveRequest,
  InstallScriptManifest,
  InstallScanDiffRequest,
  InstallScanDiffResult,
  InstallScanResolveRequest,
  InstallScanResolveResult,
  InstallSourcePreviewChannel,
  InstallSourcePreviewResult,
  InstallSourceReadFileResult,
  SkillStatus,
} from '../shared/ipc';

export interface InstallServiceOptions {
  library: SkillLibraryService;
  sources: SkillSourceService;
  market: MarketService;
  skillHub: SkillHubService;
  agents: AgentConfigService;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
  /** 同步落点记忆：扫描本机时按 Agent 整份重写 `<库>/agents-skills/<agentId>.skills` */
  placement?: PlacementStore;
}

interface CachedEntry {
  key: string;
  name: string;
  /** 非市场来源：入库输入（路径 + 来源记录），只存主进程 */
  importItem?: ImportItem;
  /** 市场来源：条目引用（source/skillId 已由市场服务校验） */
  marketRef?: MarketItemRef;
}

interface ChannelCache {
  /** 自增代次：每次发现换代，旧 key 自然失效 */
  generation: number;
  entries: Map<string, CachedEntry>;
  /** git/zip 的解包会话目录（TEMP_DIR 内；新发现或销毁时清理） */
  sessionDir?: string;
}

const CHANNELS: readonly InstallChannel[] = ['market', 'git', 'local', 'archive', 'scan'];
type MarketProvider = 'skills.sh' | 'skillhub';
const MAX_IMPORT_ITEMS = 300;

function emptyCache(): ChannelCache {
  return { generation: 0, entries: new Map() };
}

function manifestOf(scripts: string[]): InstallScriptManifest {
  return { hasExecutableScripts: scripts.length > 0, executableScripts: [...scripts] };
}

/** 本地目录发现的自带标签：`group/a` → ['group']；一层直放没有标签。 */
function localDirGroupsOf(relPath: string): string[] | undefined {
  const group = groupOfSkillRelPath(relPath);
  return group != null ? [group] : undefined;
}

export class InstallService {
  private readonly library: SkillLibraryService;
  private readonly sources: SkillSourceService;
  private readonly market: MarketService;
  private readonly skillHub: SkillHubService;
  private readonly agents: AgentConfigService;
  private readonly logger: InstallServiceOptions['logger'];
  private readonly placement: PlacementStore | undefined;

  private readonly caches: Record<InstallChannel, ChannelCache> = {
    market: emptyCache(),
    git: emptyCache(),
    local: emptyCache(),
    archive: emptyCache(),
    scan: emptyCache(),
  };
  private skillHubCache = emptyCache();

  /** 用户通过系统选择器选过的目录 / 文件（只增不减，进程生命周期内有效） */
  private readonly allowedDirs = new Set<string>();
  private readonly allowedFiles = new Set<string>();

  /**
   * 市场同名冲突保留下来的已下载内容：安装失败那一刻由市场服务另存到 TEMP，
   * 这里只记 key → { 技能目录, 库内同名目录名 }。换榜单 / 处理完 / 销毁时删除。
   */
  private readonly marketConflicts = new Map<string, { dir: string; dirName: string }>();

  constructor(opts: InstallServiceOptions) {
    this.library = opts.library;
    this.sources = opts.sources;
    this.market = opts.market;
    this.skillHub = opts.skillHub;
    this.agents = opts.agents;
    this.logger = opts.logger;
    this.placement = opts.placement;
  }

  // ────────────────────────── 路径白名单 ──────────────────────────

  /** 记录用户选择的目录（app:pickDirectory 成功后调用）。 */
  allowDirectory(dir: string): void {
    if (typeof dir !== 'string' || dir.trim().length === 0) return;
    this.allowedDirs.add(path.resolve(dir));
  }

  /** 记录用户选择的文件（app:pickFile 成功后调用）。 */
  allowFile(file: string): void {
    if (typeof file !== 'string' || file.trim().length === 0) return;
    this.allowedFiles.add(path.resolve(file));
  }

  private requireAllowedDir(dirPath: string): string {
    const resolved = path.resolve(dirPath);
    if (!this.allowedDirs.has(resolved)) {
      throw new AgentError('BAD_REQUEST', '目录必须通过「选择目录」由系统选择器选定');
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new AgentError('BAD_REQUEST', `目录不存在或不可访问：${resolved}`);
    }
    if (!stat.isDirectory()) throw new AgentError('BAD_REQUEST', `不是目录：${resolved}`);
    return resolved;
  }

  private requireAllowedFile(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (!this.allowedFiles.has(resolved)) {
      throw new AgentError('BAD_REQUEST', '文件必须通过「选择文件」由系统选择器选定');
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new AgentError('BAD_REQUEST', `文件不存在或不可访问：${resolved}`);
    }
    if (!stat.isFile()) throw new AgentError('BAD_REQUEST', `不是文件：${resolved}`);
    return resolved;
  }

  // ────────────────────────── 市场 ──────────────────────────

  async marketLeaderboard(force = false, provider: MarketProvider = 'skills.sh'): Promise<InstallMarketListResult> {
    const result = provider === 'skillhub' ? await this.skillHub.getLeaderboard() : await this.market.getLeaderboard('all-time', { refresh: force });
    return this.cacheMarketList(provider, result, result.items, undefined);
  }

  async marketSearch(query: string, force = false, provider: MarketProvider = 'skills.sh'): Promise<InstallMarketListResult> {
    const result = provider === 'skillhub' ? await this.skillHub.searchSkills(query) : await this.market.searchSkills(query, { refresh: force });
    return this.cacheMarketList(provider, result, result.items, result.query);
  }

  /** 简介查询兼容接口；当前市场列表不调用。 */
  marketDescription(source: string, skillId: string): Promise<InstallMarketDescriptionResult> {
    if (source === SKILLHUB_SOURCE) return this.skillHub.getDetail({ source, skillId }).then((detail) => ({ text: detail.description, source: 'description', stale: false }));
    return this.market.getListingDescription({ source, skillId });
  }

  /** 市场条目文件信息：文件清单 / 总大小 / 可执行脚本。 */
  async marketPreview(req: InstallMarketPreviewRequest): Promise<InstallMarketPreviewResult> {
    const resolved = this.resolveMarketRef(req);
    const detail = await (resolved.ref.source === SKILLHUB_SOURCE ? this.skillHub : this.market).getDetail(resolved.ref);
    const result: InstallMarketPreviewResult = {
      key: resolved.key,
      itemId: detail.item.id,
      name: detail.skillName || detail.item.name,
      description: detail.description,
      files: detail.files,
      fileCount: detail.fileCount,
      totalBytes: detail.totalBytes,
      scriptManifest: manifestOf(detail.executableScripts),
      stale: detail.stale,
      warning: detail.warning,
      descriptionUnavailable: detail.descriptionUnavailable,
    };
    this.logger?.info('install:market-preview', {
      itemId: result.itemId,
      files: result.fileCount,
      scripts: result.scriptManifest.executableScripts.length,
    });
    return result;
  }

  /** 市场详情页只读文件内容，来源和路径由市场服务按文件树校验。 */
  marketReadFile(source: string, skillId: string, relativePath: string): Promise<InstallMarketReadFileResult> {
    return (source === SKILLHUB_SOURCE ? this.skillHub : this.market).getFileContent({ source, skillId }, relativePath);
  }

  private resolveMarketRef(req: InstallMarketPreviewRequest): { key: string; ref: MarketItemRef } {
    const key = typeof req?.key === 'string' ? req.key.trim() : '';
    if (key.length > 0) {
      const entry = this.marketCacheForKey(key)?.entries.get(key);
      if (!entry?.marketRef) {
        throw new AgentError('BAD_REQUEST', '市场列表已更新，请重新加载榜单或搜索后再试');
      }
      return { key, ref: entry.marketRef };
    }
    const source = typeof req?.source === 'string' ? req.source.trim() : '';
    const skillId = typeof req?.skillId === 'string' ? req.skillId.trim() : '';
    if (source.length === 0 || skillId.length === 0) {
      throw new AgentError('BAD_REQUEST', '需要市场条目的 key，或 source + skillId');
    }
    return { key: '', ref: { source, skillId, name: req.name } };
  }

  private cacheMarketList(
    provider: MarketProvider,
    result: {
      items: MarketItem[];
      stale: boolean;
      fromCache: boolean;
      fetchedAt: string;
      warning?: string;
      sourceUrl: string;
    },
    items: MarketItem[],
    query: string | undefined,
  ): InstallMarketListResult {
    // 每个市场独立换代；另一市场的迟到响应不能使当前页面的 key 失效。
    for (const key of this.marketConflicts.keys()) {
      if (key.startsWith(`market:${provider}:`)) this.releaseMarketConflict(key);
    }
    const cache = this.replaceMarketCache(provider);
    const views: InstallMarketItem[] = [];
    items.forEach((item, index) => {
      const key = `market:${provider}:${cache.generation}:${index}`;
      const entry: CachedEntry = {
        key,
        name: item.name,
        marketRef: {
          source: item.source,
          skillId: item.skillId,
          publisher: item.publisher,
          name: item.name,
          installs: item.installs,
          isOfficial: item.isOfficial,
          description: item.description,
        },
      };
      cache.entries.set(key, entry);
      views.push({
        key,
        id: item.id,
        name: item.name,
        description: item.description ?? '',
        source: item.source,
        url: item.upstreamUrl,
        installs: item.installs,
        isOfficial: item.isOfficial,
      });
    });

    const view: InstallMarketListResult = {
      items: views,
      stale: result.stale,
      fromCache: result.fromCache,
      fetchedAt: result.fetchedAt,
      warning: result.warning,
      sourceUrl: result.sourceUrl,
      query,
    };
    this.logger?.info('install:market-list', {
      query: query ?? '<leaderboard>',
      count: views.length,
      stale: result.stale,
      fromCache: result.fromCache,
    });
    return view;
  }

  private marketCacheForKey(key: string): ChannelCache | null {
    if (key.startsWith('market:skills.sh:')) return this.caches.market;
    if (key.startsWith('market:skillhub:')) return this.skillHubCache;
    return null;
  }

  private replaceMarketCache(provider: MarketProvider): ChannelCache {
    if (provider === 'skills.sh') return this.replaceCache('market');
    this.skillHubCache = { generation: this.skillHubCache.generation + 1, entries: new Map() };
    return this.skillHubCache;
  }

  // ────────────────────────── Git / 本地目录 / 压缩包 ──────────────────────────

  gitParse(url: string): InstallDiscoveryResult {
    const trimmed = url.trim();
    if (trimmed.length === 0) throw new AgentError('BAD_REQUEST', 'Git 地址不能为空');
    const cache = this.replaceCache('git');
    const discovered = this.sources.discoverFromGit(trimmed);
    cache.sessionDir = discovered.sessionDir;
    const items = this.cacheDiscovered(cache, discovered.items, 'git');
    this.logger?.info('install:git-parse', { url: trimmed, count: items.length });
    return { items };
  }

  localScan(dirPath: string): InstallDiscoveryResult {
    const dir = this.requireAllowedDir(dirPath);
    const cache = this.replaceCache('local');
    const discovered = this.sources.discoverFromLocalDir(dir);
    const items = this.cacheDiscovered(cache, discovered.items, 'local');
    this.logger?.info('install:local-scan', { dir, count: items.length });
    return { items };
  }

  zipRead(zipPath: string): InstallDiscoveryResult {
    const zip = this.requireAllowedFile(zipPath);
    const cache = this.replaceCache('archive');
    const discovered = this.sources.discoverFromZip(zip);
    cache.sessionDir = discovered.sessionDir;
    const items = this.cacheDiscovered(cache, discovered.items, 'archive');
    this.logger?.info('install:zip-read', { zip, count: items.length });
    return { items };
  }

  /**
   * 扫描本机（照竞品链路）：遍历适配器清单 → 安装检测 → flat 扫描（跟随链接）→
   * 排除指向中心库的链接 → 按内容哈希把同一技能的多个位置折叠成一条。
   * 未登记在适配器清单里的 Agent 目录不会被访问。
   *
   * 与竞品的差异：`includeSynced` 保留已接管位置并标 `synced`，四态才能看到「已同步」；
   * 位置折叠后**全部位置都已接管**才判 synced，部分接管仍按库内状态显示（还有实体目录待收）。
   */
  agentScan(): InstallDiscoveryResult {
    const cache = this.replaceCache('scan');
    const targets = this.scanTargets();
    const plan = scanLocalSkills({
      targets,
      centralSkillsDir: this.library.skillsDir,
      managedPaths: this.managedTargetPaths(),
      includeSynced: true,
    });

    const byPath = new Map(plan.discovered.map((rec) => [rec.path, rec]));
    const libSkills = this.library.listSkills();
    const views: InstallItemView[] = [];

    groupDiscovered(plan.discovered).forEach((group, index) => {
      const primary = [...group.locations].sort((a, b) =>
        (byPath.get(b.path)?.foundAt ?? 0) - (byPath.get(a.path)?.foundAt ?? 0))[0];
      const detail = byPath.get(primary.path);
      const labels = [...new Set(group.locations.map((l) => l.toolLabel))];
      const agentIds = [...new Set(group.locations.map((l) => l.tool))];
      const key = `scan:${cache.generation}:${index}`;
      cache.entries.set(key, {
        key,
        name: group.name,
        importItem: {
          path: primary.path,
          source: {
            type: `agent:${primary.tool}`,
            origin: this.agents.requireAgent(primary.tool).skillsDir,
            sourceRelPath: primary.relPath,
          },
          // 嵌套目录的父目录名即「自带标签」（如 baoyu-skills/a → 标签 baoyu-skills）
          groups: detail?.group != null ? [detail.group] : undefined,
        },
      });

      const cleaned = sanitizeName(group.name);
      const existing = libSkills.find((s) => s.dirName === cleaned) ?? null;
      const sameContent =
        existing != null &&
        this.sameLibraryContent(existing.dirName, primary.path, group.fingerprint);
      const allSynced = group.locations.every(
        (loc) => byPath.get(loc.path)?.isManagedLink === true,
      );
      const status: SkillStatus = allSynced
        ? 'synced'
        : existing == null
          ? 'not-in-library'
          : sameContent
            ? 'in-library'
            : 'conflict';

      views.push({
        ...this.toView(key, {
          path: primary.path,
          sourceRelPath: primary.relPath,
          dirName: primary.relPath,
          name: group.name,
          nameSource: detail?.nameSource ?? 'dirname',
          description: detail?.description ?? '',
          sizeBytes: detail?.sizeBytes ?? 0,
          hasExecutableScripts: detail?.hasExecutableScripts ?? false,
          executableScripts: detail?.executableScripts ?? [],
          isValid: true,
          source: { type: 'machine-scan', origin: primary.toolLabel },
        }),
        inLibrary: existing != null,
        inLibrarySameContent: sameContent,
        status,
        agentId: primary.tool,
        agentLabel: labels.join(' / '),
        agentIds,
      });
    });

    const agentOptions = targets
      .filter((target) => views.some((view) => view.agentIds?.includes(target.key)))
      .map((target) => ({ id: target.key, label: target.label }));

    this.logger?.info('install:agent-scan', {
      toolsScanned: plan.toolsScanned,
      skillsFound: plan.skillsFound,
      groups: views.length,
    });
    // 扫描即整份重写落点表（快照语义）：目录变了，下次扫描自动跟随
    this.writePlacement(plan.discovered);
    return { items: views, agentOptions };
  }

  /** 来源发现的 key 绑定主进程缓存，不接受渲染层传入磁盘路径。 */
  scanDiff(req: InstallScanDiffRequest): InstallScanDiffResult {
    const { entry, dest } = this.sourceConflictEntry(req.channel ?? 'scan', req.key);
    const sourceHash = hashSkillDir(entry.importItem!.path);
    const targetHash = hashSkillDir(dest);
    if ((req.sourceHash && req.sourceHash !== sourceHash) || (req.targetHash && req.targetHash !== targetHash)) {
      return { stale: true, sourceMtime: null, targetMtime: null, files: [], source: null, target: null, sourceHash, targetHash };
    }
    return { ...compareSkillDirs(entry.importItem!.path, dest, req.relPath), sourceHash, targetHash };
  }

  async resolveScanConflict(req: InstallScanResolveRequest): Promise<InstallScanResolveResult> {
    const { entry, dest, skillId } = this.sourceConflictEntry(req.channel ?? 'scan', req.key);
    if (hashSkillDir(entry.importItem!.path) !== req.sourceHash || hashSkillDir(dest) !== req.targetHash) {
      throw new AgentError('BAD_REQUEST', '内容已变化，请重新查看差异');
    }
    if (req.choice === 'skip') return { status: 'skipped', skillId };
    if (req.choice !== 'overwrite') throw new AgentError('BAD_REQUEST', '未知的处理方式');
    const result = await this.sources.replaceFromScan(entry.importItem!.path, path.basename(dest), req.sourceHash, req.targetHash);
    return { status: 'overwritten', skillId: result.skillId };
  }

  // ────────────────────────── 市场冲突（差异 / 覆盖） ──────────────────────────

  /**
   * 市场条目的同名冲突在安装那一刻已经下载并解包，市场服务把它另存在 TEMP（见 retained）。
   * 点「查看差异」直接读这份拷贝与库内同名目录比对，不再访问网络；关闭或处理完再删除。
   */
  marketDiff(req: InstallMarketDiffRequest): InstallScanDiffResult {
    const { dir, dest } = this.marketConflictEntry(req.key);
    const sourceHash = hashSkillDir(dir);
    const targetHash = hashSkillDir(dest);
    if ((req.sourceHash && req.sourceHash !== sourceHash) || (req.targetHash && req.targetHash !== targetHash)) {
      return { stale: true, sourceMtime: null, targetMtime: null, files: [], source: null, target: null, sourceHash, targetHash };
    }
    return { ...compareSkillDirs(dir, dest, req.relPath), sourceHash, targetHash };
  }

  async marketResolveConflict(req: InstallMarketResolveRequest): Promise<InstallScanResolveResult> {
    const { key } = req;
    const { dir, dest, dirName } = this.marketConflictEntry(key);
    if (hashSkillDir(dir) !== req.sourceHash || hashSkillDir(dest) !== req.targetHash) {
      throw new AgentError('BAD_REQUEST', '内容已变化，请重新查看差异');
    }
    const skillId = this.library.listSkills().find((item) => item.dirName === dirName)?.skillId ?? null;
    if (req.choice === 'skip') return { status: 'skipped', skillId };
    if (req.choice !== 'overwrite') throw new AgentError('BAD_REQUEST', '未知的处理方式');
    const entry = this.marketCacheForKey(key)?.entries.get(key);
    const origin = entry?.marketRef ? entry.marketRef.source === SKILLHUB_SOURCE
      ? skillHubUrl(entry.marketRef.skillId, entry.marketRef.publisher) : buildUpstreamUrl(entry.marketRef.source, entry.marketRef.skillId) : '';
    const hubVersion = entry?.marketRef?.source === SKILLHUB_SOURCE ? entry.marketRef.version : undefined;
    const result = await this.sources.replaceFromScan(dir, dirName, req.sourceHash, req.targetHash, {
      eventLabel: '用技能市场版本覆盖',
      ...(origin.length > 0 ? { source: { origin, ...(hubVersion ? { sourceRelPath: '.', sourceRevision: hubVersion } : {}) } } : {}),
    });
    this.releaseMarketConflict(key);
    return { status: 'overwritten', skillId: result.skillId };
  }

  private marketConflictEntry(key: string): { dir: string; dest: string; dirName: string } {
    const kept = this.marketConflicts.get(key);
    if (!kept) throw new AgentError('BAD_REQUEST', '该条目的冲突内容已释放，请重新安装后再查看差异');
    const dest = libraryDestDirOf(this.library.skillsDir, kept.dirName);
    const skill = this.library.listSkills().find((item) => item.dirName === kept.dirName);
    if (!skill || !isSkillDir(kept.dir) || !fs.existsSync(dest)) {
      throw new AgentError('BAD_REQUEST', '当前不是可比较的冲突项，请重新安装');
    }
    return { dir: kept.dir, dest, dirName: kept.dirName };
  }

  /** 释放保留的市场冲突内容；省略 key 时全部释放（换榜单 / 销毁上下文）。 */
  private releaseMarketConflict(key?: string): void {
    const keys = key == null ? [...this.marketConflicts.keys()] : [key];
    for (const item of keys) {
      const kept = this.marketConflicts.get(item);
      if (!kept) continue;
      this.marketConflicts.delete(item);
      try {
        fs.rmSync(path.dirname(kept.dir), { recursive: true, force: true });
      } catch (err) {
        this.logger?.error('install:market-conflict-cleanup-failed', { dir: kept.dir, error: (err as Error).message });
      }
    }
  }

  private sourceConflictEntry(channel: InstallConflictChannel, key: string): { entry: CachedEntry & { importItem: ImportItem }; dest: string; skillId: string } {
    const entry = this.caches[channel].entries.get(key);
    if (!entry?.importItem) throw new AgentError('BAD_REQUEST', '扫描结果已更新，请重新扫描');
    const cleaned = sanitizeName(entry.name);
    const skill = this.library.listSkills().find((item) => item.dirName === cleaned);
    if (!skill || !isSkillDir(entry.importItem.path)) throw new AgentError('BAD_REQUEST', '当前不是可比较的冲突项，请重新扫描');
    const dest = libraryDestDirOf(this.library.skillsDir, cleaned);
    const sourceReal = fs.realpathSync(entry.importItem.path);
    const targetReal = fs.realpathSync(dest);
    if (isPathSafe(sourceReal, targetReal) || isPathSafe(targetReal, sourceReal) ||
        hashSkillDir(entry.importItem.path) === hashSkillDir(dest) ||
        sameSkillIgnoringEol(entry.importItem.path, dest)) {
      throw new AgentError('BAD_REQUEST', '当前内容已无冲突，请重新扫描');
    }
    return { entry: entry as CachedEntry & { importItem: ImportItem }, dest, skillId: skill.skillId };
  }

  /**
   * 按 Agent 整份重写 `<库>/sync/<agentId>.skills`（扫描是快照，不是增量）。
   * 同一技能在同一 Agent 出现多处时按相对路径排序取第一个（「先扫描到的」，可复现）；
   * 目录不存在 / 断链的 Agent 保持旧表不动，避免把历史记录误清空。
   */
  private writePlacement(discovered: readonly DiscoveredToolSkill[]): void {
    const store = this.placement;
    if (store == null) return;
    for (const target of this.scanTargets()) {
      if (!fs.existsSync(target.dir)) continue;
      const rows = discovered
        .filter((rec) => rec.tool === target.key)
        .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
      const picked: Record<string, string> = {};
      for (const rec of rows) {
        const key = sanitizeName(rec.name);
        if (!key || key in picked) continue;
        picked[key] = rec.relPath.split(path.sep).join('/');
      }
      store.writeAll(target.key, picked);
    }
  }

  /** 库内同名技能的内容哈希：优先读元数据，缺失时现算（与扫描侧同一套忽略清单）。 */
  private libraryContentHashOf(dirName: string): string | null {
    const meta = readSkillMeta(this.library.skillsDir, dirName);
    if (meta?.contentHash) return meta.contentHash;
    try {
      return hashAndSizeSkillDir(skillsDirJoin(this.library.skillsDir, meta?.relPath ?? dirName)).hash;
    } catch {
      return null;
    }
  }

  /**
   * 库内同名技能与来源是否「同内容」：先比字节哈希；不相等时再问一次
   * 「除行尾符外还有别的差异吗」（Windows git 检出 CRLF vs 市场 / GitHub 的 LF）。
   * 列表四态与导入判定必须同一口径，否则会出现「显示有冲突、导入却跳过」。
   */
  private sameLibraryContent(dirName: string, sourcePath: string, sourceHash: string | null): boolean {
    if (sourceHash == null) return false;
    const dest = skillsDirJoin(this.library.skillsDir, readSkillMeta(this.library.skillsDir, dirName)?.relPath ?? dirName);
    if (!fs.existsSync(dest)) return false;
    if (this.libraryContentHashOf(dirName) === sourceHash) return true;
    try {
      return sameSkillIgnoringEol(sourcePath, dest);
    } catch {
      return false;
    }
  }

  /** 扫描目标＝本机配置里的 Agent（`agents.json` 是唯一真相，未列出的 Agent 目录不访问）。 */
  private scanTargets(): Array<{ key: string; label: string; dir: string }> {
    return this.agents.list().map((a) => ({ key: a.id, label: a.name, dir: a.skillsDir }));
  }

  /**
   * 已管理的目标路径（竞品 managed_paths）：库内技能已部署到某 Agent 时，
   * `<agentDir>/<dirName>` 属于「自己放出去的」，不重复计入发现。
   */
  private managedTargetPaths(): string[] {
    const out: string[] = [];
    for (const agent of this.agents.list()) {
      for (const skill of this.library.listSkills()) {
        if (!skill.deployedAgents.includes(agent.id)) continue;
        out.push(path.join(agent.skillsDir, skill.dirName));
      }
    }
    return out;
  }

  private cacheDiscovered(
    cache: ChannelCache,
    discovered: DiscoveredSkill[],
    channel: Exclude<InstallChannel, 'market' | 'scan'>,
  ): InstallItemView[] {
    const views: InstallItemView[] = [];
    const librarySkills = channel === 'local' || channel === 'archive' ? this.library.listSkills() : [];
    discovered.forEach((skill, index) => {
      const key = `${channel}:${cache.generation}:${index}`;
      cache.entries.set(key, {
        key,
        name: skill.name,
        importItem: {
          path: skill.path,
          source: {
            type: skill.source.type,
            origin: skill.source.origin,
            sourceRelPath: skill.sourceRelPath,
            ...(skill.source.sourceBranch ? { sourceBranch: skill.source.sourceBranch } : {}),
            ...(skill.source.sourceRevision ? { sourceRevision: skill.source.sourceRevision } : {}),
          },
          // 本地目录允许一层 group：父目录名即「自带标签」（git/zip 的层级来自仓库结构，不推断标签）
          groups: channel === 'local' ? localDirGroupsOf(skill.sourceRelPath) : undefined,
        },
      });
      const view = this.toView(key, skill);
      if ((channel === 'local' || channel === 'archive') && skill.isValid) {
        const dirName = sanitizeName(skill.name);
        const existing = librarySkills.find((item) => item.dirName === dirName);
        let sourceHash: string | null = null;
        try { sourceHash = hashSkillDir(skill.path); } catch { /* 导入时返回实际读取错误 */ }
        if (sourceHash != null) {
          const sameContent = existing != null && this.sameLibraryContent(dirName, skill.path, sourceHash);
          view.inLibrary = existing != null;
          view.inLibrarySameContent = sameContent;
          view.status = existing == null ? 'not-in-library' : sameContent ? 'in-library' : 'conflict';
        }
      }
      views.push(view);
    });
    return views;
  }

  private toView(key: string, skill: DiscoveredSkill): InstallItemView {
    return {
      key,
      name: skill.name,
      description: skill.description,
      relPath: skill.sourceRelPath,
      sizeBytes: skill.sizeBytes,
      scriptManifest: manifestOf(skill.executableScripts),
      valid: skill.isValid,
      invalidReason: skill.invalidReason,
    };
  }

  /** 只按当前发现 key 找到有效技能目录，绝不接受渲染层传入路径。 */
  private discoveredRoot(channel: InstallSourcePreviewChannel, key: string): { root: string; name: string } {
    if (!['git', 'local', 'archive', 'scan'].includes(channel)) {
      throw new AgentError('BAD_REQUEST', '未知的发现来源');
    }
    const entry = this.caches[channel].entries.get(key);
    if (!entry?.importItem) throw new AgentError('BAD_REQUEST', '发现结果已更新，请重新扫描后再试');
    const root = entry.importItem.path;
    if (!isSkillDir(root)) throw new AgentError('BAD_REQUEST', '该目录不是有效 Skill，或来源已不可访问');
    return { root, name: entry.name };
  }

  /** 列出当前发现条目的文件树，不读取正文，也不执行任何文件。 */
  sourcePreview(channel: InstallSourcePreviewChannel, key: string): InstallSourcePreviewResult {
    const { root, name } = this.discoveredRoot(channel, key);
    const tree = buildFileTree(root);
    if (!tree) throw new AgentError('BAD_REQUEST', '技能目录已不可访问，请重新扫描');
    const files: InstallSourcePreviewResult['files'] = [];
    /** 展开磁盘文件树，只传文件路径与大小给渲染层。 */
    const appendFiles = (node: FileTreeNode): void => {
      if (node.type === 'file') {
        files.push({ path: node.relPath, size: node.size });
        return;
      }
      for (const child of node.children ?? []) appendFiles(child);
    };
    appendFiles(tree);
    return { key, name, files, fileCount: files.length, totalBytes: tree.size };
  }

  /** 按当前发现 key 和受控相对路径读取一个文件；共用中心库的越界与二进制防护。 */
  sourceReadFile(channel: InstallSourcePreviewChannel, key: string, relativePath: string): InstallSourceReadFileResult {
    const { root } = this.discoveredRoot(channel, key);
    const file = readTextFileInDir(root, relativePath);
    const reason = file.reason === 'BINARY' ? '二进制文件无法在应用内预览'
      : file.reason === 'TOO_LARGE' ? '文件过大，无法在应用内预览'
        : file.reason ? '该文件无法在应用内预览' : undefined;
    return { content: file.content, size: file.size, ...(reason ? { reason } : {}) };
  }

  // ────────────────────────── 统一导入 ──────────────────────────

  /**
   * 导入选中项：只接受当前通道最近一次发现列表里的 key。
   * 未知 key 逐项失败（提示重新扫描），不会退化为「按字符串当路径」。
   * 汇总口径：imported / skipped（同名同内容）/ failed；导入不部署。
   */
  async importSelected(req: InstallImportRequest): Promise<InstallImportResult> {
    const channel = req?.channel;
    if (typeof channel !== 'string' || !(CHANNELS as readonly string[]).includes(channel)) {
      throw new AgentError('BAD_REQUEST', `未知的安装来源：${String(channel)}`);
    }
    if (!Array.isArray(req?.items)) throw new AgentError('BAD_REQUEST', 'items 必须是数组');
    if (req.items.length > MAX_IMPORT_ITEMS) {
      throw new AgentError('BAD_REQUEST', `一次最多导入 ${MAX_IMPORT_ITEMS} 项`);
    }

    const cache = channel === 'market' ? null : this.caches[channel as InstallChannel];
    const known: CachedEntry[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();
    for (const raw of req.items) {
      const key = typeof raw?.key === 'string' ? raw.key.trim() : '';
      if (key.length === 0) throw new AgentError('BAD_REQUEST', '每一项都需要 key');
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = channel === 'market' ? this.marketCacheForKey(key)?.entries.get(key) : cache?.entries.get(key);
      if (entry) {
        if (channel === 'git' && typeof raw.name === 'string' && entry.importItem) {
          known.push({ ...entry, importItem: { ...entry.importItem, nameOverride: raw.name } });
        } else {
          known.push(entry);
        }
      }
      else unknown.push(key);
    }

    // 扫描本机的同名候选，始终先尝试文件 mtime 更新的版本；时间相同沿用选择顺序。
    if (channel === 'scan') known.sort((a, b) => {
      const nameA = sanitizeName(a.name);
      const nameB = sanitizeName(b.name);
      if (nameA !== nameB) return nameA < nameB ? -1 : 1;
      return (skillContentMtime(b.importItem!.path) ?? 0) - (skillContentMtime(a.importItem!.path) ?? 0);
    });

    const results: InstallImportItemResult[] = [];
    try {
      if (channel === 'market') {
        results.push(...(await this.importMarket(known)));
      } else {
        results.push(...(await this.importSources(channel as InstallChannel, known)));
      }
    } catch (err) {
      // 批次级失败（例如市场下载整体不可用）：仍让每个已选项有明确结果
      const reason = err instanceof Error ? err.message : String(err);
      for (const entry of known) {
        if (results.some((r) => r.key === entry.key)) continue;
        results.push({
          key: entry.key,
          name: entry.name,
          status: 'failed',
          reason,
          code: (err as { code?: string } | null)?.code,
        });
      }
      this.logger?.error('install:import-failed', { channel, reason });
    }

    for (const key of unknown) {
      results.push({
        key,
        name: key,
        status: 'failed',
        reason: channel === 'market' ? '市场列表已更新，请重新加载榜单或搜索后再试' : '扫描结果已更新，请重新扫描后再导入',
        code: 'STALE_SCAN',
      });
    }

    const summary = { imported: 0, skipped: 0, failed: 0 };
    for (const item of results) summary[item.status] += 1;
    this.logger?.info('install:import', { channel, ...summary });
    return { channel: channel as InstallChannel, items: results, summary };
  }

  private async importMarket(entries: CachedEntry[]): Promise<InstallImportItemResult[]> {
    if (entries.length === 0) return [];
    const refs: MarketItemRef[] = [];
    for (const entry of entries) {
      if (!entry.marketRef) {
        throw new AgentError('BAD_REQUEST', '市场条目缺少下载信息，请重新加载列表');
      }
      refs.push(entry.marketRef);
    }
    const batch = refs[0]?.source === SKILLHUB_SOURCE
      ? await this.skillHub.installItems(refs) : await this.market.installItems(refs);
    // 冲突项的已下载内容由市场服务保留下来：登记后「查看差异 / 覆盖」直接读它，不重新下载
    for (const kept of batch.retained ?? []) {
      const index = batch.results.findIndex((result) => result.itemId === kept.itemId);
      const entry = index >= 0 ? entries[index] : undefined;
      if (!entry) continue;
      const display = readSkillMd(kept.dir)?.meta.name ?? path.basename(kept.dir);
      const dirName = validateNewDirName(display);
      if (dirName == null) continue;
      this.releaseMarketConflict(entry.key);
      this.marketConflicts.set(entry.key, { dir: kept.dir, dirName });
    }
    return entries.map((entry, index) => {
      const result = batch.results[index];
      if (!result) {
        return {
          key: entry.key,
          name: entry.name,
          status: 'failed' as const,
          reason: '市场安装未返回结果',
        };
      }
      const status =
        result.status === 'imported'
          ? 'imported'
          : result.status === 'already-in-library'
            ? 'skipped'
            : 'failed';
      return {
        key: entry.key,
        name: result.name || entry.name,
        status,
        reason: result.reason,
        skillId: result.skillId,
        code: result.code,
      };
    });
  }

  private async importSources(
    channel: InstallChannel,
    entries: CachedEntry[],
  ): Promise<InstallImportItemResult[]> {
    if (entries.length === 0) return [];
    const items: ImportItem[] = [];
    for (const entry of entries) {
      if (!entry.importItem) throw new AgentError('BAD_REQUEST', '条目缺少来源信息，请重新扫描');
      items.push(entry.importItem);
    }
    // 不传 sessionDir：保留 git/zip 解包目录，重复导入（跳过/冲突判定）仍可工作；
    // 目录在新一次发现或上下文销毁时清理。
    const batch = await this.sources.importSkills(items);
    return entries.map((entry, index) => {
      const result = batch.results[index];
      if (!result) {
        return {
          key: entry.key,
          name: entry.name,
          status: 'failed' as const,
          reason: '导入未返回结果',
        };
      }
      const status =
        result.status === 'imported'
          ? 'imported'
          : result.status === 'already-in-library'
            ? 'skipped'
            : 'failed';
      return {
        key: entry.key,
        name: result.name || entry.name,
        status,
        reason: result.reason,
        skillId: result.skillId,
        code: result.code,
      };
    });
  }

  // ────────────────────────── 生命周期 ──────────────────────────

  /** 换新代次并清理上一代 git/zip 解包目录。 */
  private replaceCache(channel: InstallChannel): ChannelCache {
    const old = this.caches[channel];
    if (old.sessionDir) {
      try {
        fs.rmSync(old.sessionDir, { recursive: true, force: true });
      } catch (err) {
        this.logger?.error('install:session-cleanup-failed', {
          channel,
          error: (err as Error).message,
        });
      }
    }
    const next: ChannelCache = { generation: old.generation + 1, entries: new Map() };
    this.caches[channel] = next;
    return next;
  }

  dispose(): void {
    this.releaseMarketConflict();
    for (const channel of CHANNELS) {
      const cache = this.caches[channel];
      if (cache.sessionDir) {
        fs.rmSync(cache.sessionDir, { recursive: true, force: true });
        cache.sessionDir = undefined;
      }
      cache.entries.clear();
    }
    this.skillHubCache.entries.clear();
  }
}
