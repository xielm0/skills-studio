/**
 * 技能市场服务（T05：prd.md M12、tec.md §5.12/§7.3）。
 *
 * 职责：
 *  - 榜单/搜索：抓 skills.sh（榜单解析页面、搜索走站点 /api/search）→ 解析 → 落 DATA_DIR 缓存。
 *    列表优先读缓存；源不可用时缓存仍在则返回并标注「可能过期」，无缓存则抛结构化错误。
 *  - 详情：用 GitHub 文件树接口取文件清单/总大小/scripts 可执行脚本，按需读取 raw 文件供只读预览。
 *  - 安装：下载仓库 zip 到 TEMP_DIR → 安全解压 → 定位技能目录 → 复用 T02
 *    SkillSourceService.importSkills（source.type = market，origin 记市场地址，不落本机绝对路径）。
 *
 * 边界：只接 skills.sh，不建第二套数据模型；不执行技能内任何代码；下载与解包只落 TEMP_DIR。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSkillDir, readSkillMd } from '../frontmatter';
import type { SkillSourceService } from '../sources/source-service';
import type { ImportItem, ImportItemResult } from '../sources/types';
import { extractZipSafe } from '../../infra/zip-extract';
import { MarketCache, type MarketCacheEntry } from './cache';
import { createFetchHttpClient, DEFAULT_MARKET_TIMEOUT_MS, type MarketHttpClient } from './http';
import {
  MARKET_SITE_ORIGIN,
  buildUpstreamUrl,
  describeTreeSkill,
  leaderboardUrl,
  parseLeaderboardPayload,
  parseListingDescription,
  parseRepoTree,
  parseSearchPayload,
  parseSkillMarkdown,
  repoRawFileUrl,
  repoTreeUrl,
  repoZipUrl,
  searchUrl,
  type MarketListingDescription,
} from './parse';
import {
  MarketError,
  asMarketError,
  type MarketDetail,
  type MarketInstallBatchResult,
  type MarketInstallResult,
  type MarketItem,
  type MarketItemRef,
  type MarketLeaderboard,
  type MarketListResult,
  type MarketSearchResult,
} from './types';

/** 缓存 TTL（毫秒）。榜单/搜索短、仓库树与详情长。 */
export interface MarketTtlConfig {
  leaderboard: number;
  search: number;
  repoTree: number;
  detail: number;
  skillMd: number;
}

export const DEFAULT_MARKET_TTL: MarketTtlConfig = {
  leaderboard: 10 * 60_000,
  search: 10 * 60_000,
  repoTree: 24 * 60 * 60_000,
  detail: 24 * 60 * 60_000,
  skillMd: 24 * 60 * 60_000,
};

export interface MarketServiceOptions {
  /** 本机数据目录（缓存落 <dataDir>/market-cache） */
  dataDir: string;
  /** 临时目录（下载/解包会话；与导入共用 TEMP_DIR） */
  tempDir: string;
  /** T02 统一入库服务（市场不另建写路径） */
  sources: SkillSourceService;
  /** 可注入 HTTP（测试用 fixture）；缺省为真实 fetch 实现 */
  http?: MarketHttpClient;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
  now?: () => Date;
  ttl?: Partial<MarketTtlConfig>;
  timeoutMs?: number;
}

const SEARCH_LIMIT_DEFAULT = 60;
const SEARCH_LIMIT_MAX = 200;
const SEARCH_QUERY_MAX = 120;
/** GitHub `owner/repo` 形态（站点自发布条目没有 `/`，当前不支持安装）。 */
const GITHUB_SOURCE_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SKILL_ID_RE = /^[A-Za-z0-9._-]+$/;

function normalizeLeaderboard(value: string | MarketLeaderboard): MarketLeaderboard {
  switch (value) {
    case 'all-time':
    case 'alltime':
    case 'all':
      return 'all-time';
    case 'trending':
      return 'trending';
    case 'hot':
      return 'hot';
    default:
      throw new MarketError(
        'MARKET_INVALID_QUERY',
        `未知榜单类型：${value}（可选 all-time / trending / hot）`,
        false,
      );
  }
}

function normalizeQuery(query: string): string {
  const q = query.trim();
  if (q.length === 0) {
    throw new MarketError('MARKET_INVALID_QUERY', '搜索关键词不能为空', false);
  }
  if (q.length > SEARCH_QUERY_MAX) {
    throw new MarketError('MARKET_INVALID_QUERY', `搜索关键词过长（>${SEARCH_QUERY_MAX} 字符）`, false);
  }
  return q;
}

function clampLimit(limit: number | undefined): number {
  const n = Math.trunc(limit ?? SEARCH_LIMIT_DEFAULT);
  if (!Number.isFinite(n) || n <= 0) return SEARCH_LIMIT_DEFAULT;
  return Math.min(n, SEARCH_LIMIT_MAX);
}

/** 校验条目的来源与技能标识（市场输入也过边界检查，避免拼 URL 时被注入）。 */
function normalizeRef(ref: MarketItemRef): Required<Pick<MarketItemRef, 'source' | 'skillId'>> &
  Omit<MarketItemRef, 'source' | 'skillId'> {
  const source = (ref?.source ?? '').trim();
  const skillId = (ref?.skillId ?? '').trim();
  if (source.length === 0 || skillId.length === 0) {
    throw new MarketError('MARKET_INVALID_QUERY', '市场条目缺少 source 或 skillId', false);
  }
  if (source.includes('..') || /^[a-z]+:\/\//i.test(source)) {
    throw new MarketError('MARKET_INVALID_QUERY', `市场条目来源非法：${source}`, false);
  }
  if (!SKILL_ID_RE.test(skillId) || skillId === '.' || skillId === '..') {
    throw new MarketError('MARKET_INVALID_QUERY', `市场条目技能标识非法：${skillId}`, false);
  }
  return { ...ref, source, skillId };
}

function requireGithubSource(source: string, action: string): void {
  if (!GITHUB_SOURCE_RE.test(source)) {
    throw new MarketError(
      'MARKET_SOURCE_UNSUPPORTED',
      `条目来源 ${source} 不是 GitHub 仓库（站点自发布条目当前没有下载通道），暂不支持${action}`,
      false,
    );
  }
}

function skillDirCandidates(root: string, skillId: string): string[] {
  return [
    path.join(root, skillId),
    path.join(root, 'skills', skillId),
    path.join(root, '.agents', 'skills', skillId),
  ];
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** GitHub zip 解包后通常有单层 `<repo>-HEAD/` 包皮，向下剥掉。 */
function unwrapSingleRoot(extractDir: string): string {
  let current = extractDir;
  for (let i = 0; i < 2; i++) {
    if (isSkillDir(current)) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
    } catch {
      break;
    }
    if (entries.length !== 1 || !entries[0].isDirectory()) break;
    current = path.join(current, entries[0].name);
  }
  return current;
}

/**
 * 在解包目录里定位技能目录（与参考实现 find_skill_dir 同序）：
 * `<id>` → `skills/<id>` → `.agents/skills/<id>` → 目录名匹配 → frontmatter name 匹配。
 */
function findSkillDirOnDisk(root: string, skillId: string): string | null {
  for (const candidate of skillDirCandidates(root, skillId)) {
    if (isSkillDir(candidate)) return candidate;
  }

  const exact: string[] = [];
  const byName: string[] = [];
  const loose: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (isSkillDir(full)) {
        if (entry.name === skillId) exact.push(full);
        else if (entry.name.toLowerCase() === skillId.toLowerCase()) loose.push(full);
        else if (readSkillMd(full)?.meta.name === skillId) byName.push(full);
      }
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return exact[0] ?? byName[0] ?? loose[0] ?? null;
}

function itemIdOf(ref: { source: string; skillId: string }): string {
  return `${ref.source}/${ref.skillId}`;
}

export class MarketService {
  private readonly cache: MarketCache;
  private readonly http: MarketHttpClient;
  private readonly sources: SkillSourceService;
  private readonly tempDir: string;
  private readonly ttl: MarketTtlConfig;
  private readonly timeoutMs: number;
  private readonly logger: MarketServiceOptions['logger'];
  private readonly now: () => Date;

  constructor(opts: MarketServiceOptions) {
    this.cache = new MarketCache(path.join(opts.dataDir, 'market-cache'), opts.now);
    this.http =
      opts.http ??
      createFetchHttpClient({
        timeoutMs: opts.timeoutMs ?? DEFAULT_MARKET_TIMEOUT_MS,
      });
    this.sources = opts.sources;
    this.tempDir = path.resolve(opts.tempDir);
    this.ttl = { ...DEFAULT_MARKET_TTL, ...opts.ttl };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_MARKET_TIMEOUT_MS;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => new Date());
    fs.mkdirSync(this.tempDir, { recursive: true });
  }

  // ────────────────────────── 榜单 / 搜索 ──────────────────────────

  /** 热门榜：新鲜缓存优先；源不可用回退过期缓存（标注可能过期）；两者都没有则抛错。 */
  async getLeaderboard(
    board: string | MarketLeaderboard = 'all-time',
    opts: { refresh?: boolean } = {},
  ): Promise<MarketListResult> {
    const type = normalizeLeaderboard(board);
    const url = leaderboardUrl(type);
    const cacheKey = `leaderboard-${type}`;

    const cached = this.cache.read<MarketItem[]>(cacheKey, this.ttl.leaderboard);
    if (cached?.fresh && opts.refresh !== true) {
      return {
        items: cached.value,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        stale: false,
        sourceUrl: url,
      };
    }

    try {
      const res = await this.http.getText(url, { timeoutMs: this.timeoutMs, maxBytes: 8 * 1024 * 1024 });
      if (res.status !== 200) {
        throw new MarketError(
          'MARKET_FETCH_FAILED',
          `skills.sh 榜单返回 HTTP ${res.status}`,
          true,
          res.status,
        );
      }
      const items = parseLeaderboardPayload(res.text, `skills.sh ${type} 榜单`);
      this.cache.write(cacheKey, items);
      this.logger?.info('market:leaderboard', { board: type, count: items.length, url: res.finalUrl });
      return {
        items,
        fetchedAt: this.now().toISOString(),
        fromCache: false,
        stale: false,
        sourceUrl: res.finalUrl,
      };
    } catch (err) {
      return this.fallbackList(cached, err, url, `skills.sh ${type} 榜单`);
    }
  }

  /** 关键词搜索：新鲜缓存优先；源不可用时同样回退过期缓存。 */
  async searchSkills(
    query: string,
    opts: { limit?: number; refresh?: boolean } = {},
  ): Promise<MarketSearchResult> {
    const q = normalizeQuery(query);
    const limit = clampLimit(opts.limit);
    const url = searchUrl(q, limit);
    const cacheKey = `search-${q.toLowerCase()}-${limit}`;

    const cached = this.cache.read<MarketItem[]>(cacheKey, this.ttl.search);
    if (cached?.fresh && opts.refresh !== true) {
      return {
        query: q,
        items: cached.value,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        stale: false,
        sourceUrl: url,
      };
    }

    try {
      const res = await this.http.getText(url, { timeoutMs: this.timeoutMs, maxBytes: 4 * 1024 * 1024 });
      if (res.status !== 200) {
        throw new MarketError(
          'MARKET_FETCH_FAILED',
          `skills.sh 搜索返回 HTTP ${res.status}`,
          true,
          res.status,
        );
      }
      const items = parseSearchPayload(res.text, 'skills.sh 搜索');
      this.cache.write(cacheKey, items);
      this.logger?.info('market:search', { query: q, count: items.length, url: res.finalUrl });
      return {
        query: q,
        items,
        fetchedAt: this.now().toISOString(),
        fromCache: false,
        stale: false,
        sourceUrl: res.finalUrl,
      };
    } catch (err) {
      const fallback = this.fallbackList(cached, err, url, 'skills.sh 搜索');
      return { ...fallback, query: q };
    }
  }

  /** 按需读取市场详情页的描述；结构化 description 优先，Summary 仅作展示兜底。 */
  async getListingDescription(ref: MarketItemRef): Promise<MarketListingDescription & { stale: boolean }> {
    const normalized = normalizeRef(ref);
    const cacheKey = `listing-description-${normalized.source}-${normalized.skillId}`;
    const cached = this.cache.read<MarketListingDescription>(cacheKey, this.ttl.detail);
    if (cached?.fresh) return { ...cached.value, stale: false };

    const url = buildUpstreamUrl(normalized.source, normalized.skillId);
    try {
      const response = await this.http.getText(url, { timeoutMs: this.timeoutMs, maxBytes: 2 * 1024 * 1024 });
      if (response.status !== 200) {
        throw new MarketError('MARKET_FETCH_FAILED', `技能详情页返回 HTTP ${response.status}`, true, response.status);
      }
      const description = parseListingDescription(response.text);
      this.cache.write(cacheKey, description);
      return { ...description, stale: false };
    } catch (err) {
      if (cached) return { ...cached.value, stale: true };
      throw asMarketError(err);
    }
  }

  private fallbackList(
    cached: MarketCacheEntry<MarketItem[]> | null,
    err: unknown,
    sourceUrl: string,
    label: string,
  ): MarketListResult {
    const error = asMarketError(err);
    if (cached) {
      const warning = `${label}源不可用（${error.detail}），展示的是 ${cached.fetchedAt} 的缓存内容，可能过期`;
      this.logger?.error('market:cache-fallback', { label, code: error.code, cachedAt: cached.fetchedAt });
      return {
        items: cached.value,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        stale: true,
        warning,
        sourceUrl,
      };
    }
    throw error;
  }

  // ────────────────────────── 详情（文件清单 / 大小 / 脚本） ──────────────────────────

  /**
   * 市场条目详情：文件清单、总大小、scripts 下可执行脚本、描述。
   * 缓存命中直接返回；源不可用但有缓存时返回过期详情并标注。
   */
  async getDetail(
    ref: MarketItemRef,
    opts: { refresh?: boolean } = {},
  ): Promise<MarketDetail> {
    const normalized = normalizeRef(ref);
    requireGithubSource(normalized.source, '查看详情');

    const cacheKey = `detail-${normalized.source}-${normalized.skillId}`;
    const cached = this.cache.read<MarketDetail>(cacheKey, this.ttl.detail);
    if (cached?.fresh && opts.refresh !== true) {
      return { ...cached.value, fromCache: true, stale: false, warning: undefined };
    }

    try {
      const tree = await this.loadRepoTree(normalized.source);
      const described = describeTreeSkill(tree.entries, normalized.skillId);
      if (described == null) {
        throw new MarketError(
          'MARKET_ITEM_NOT_FOUND',
          `上游仓库 ${normalized.source} 中未找到技能 ${normalized.skillId}`,
          false,
        );
      }

      const md = await this.loadSkillMarkdown(normalized.source, normalized.skillId, described.dirPath);
      const description = md.description || cached?.value.description || '';
      const descriptionUnavailable = md.description.length === 0;
      const item: MarketItem = {
        id: itemIdOf(normalized),
        source: normalized.source,
        skillId: normalized.skillId,
        name: md.name || normalized.name || normalized.skillId,
        installs: normalized.installs ?? 0,
        upstreamUrl: buildUpstreamUrl(normalized.source, normalized.skillId),
        ...(description ? { description } : {}),
      };
      if (normalized.isOfficial === true) item.isOfficial = true;

      const stored: MarketDetail = {
        item,
        description,
        skillName: md.name,
        files: described.files,
        fileCount: described.files.length,
        totalBytes: described.totalBytes,
        executableScripts: described.executableScripts,
        repoPath: described.dirPath,
        fetchedAt: this.now().toISOString(),
        // 子缓存（仓库树 / SKILL.md）接过盘时，本次详情也是缓存拼出来的
        fromCache: tree.stale || md.stale,
        stale: tree.stale || md.stale,
        ...(tree.stale || md.stale
          ? { warning: '上游部分数据不可用，展示的是缓存内容，可能过期' }
          : {}),
      };
      if (descriptionUnavailable) stored.descriptionUnavailable = true;
      // 描述缺失的详情不写缓存：下次仍会重试 SKILL.md，避免把不完整详情钉 24 小时
      if (!descriptionUnavailable) {
        const cacheValue: MarketDetail = { ...stored, fromCache: false, stale: false };
        delete cacheValue.warning;
        this.cache.write(cacheKey, cacheValue);
      }
      this.logger?.info('market:detail', {
        id: stored.item.id,
        files: stored.fileCount,
        bytes: stored.totalBytes,
        scripts: stored.executableScripts.length,
      });
      return stored;
    } catch (err) {
      const error = asMarketError(err);
      if (cached && error.code !== 'MARKET_ITEM_NOT_FOUND') {
        return {
          ...cached.value,
          fromCache: true,
          stale: true,
          warning: `详情源不可用（${error.detail}），展示的是 ${cached.fetchedAt} 的缓存内容，可能过期`,
        };
      }
      throw error;
    }
  }

  /** 只读市场文件；先按文件树核对相对路径，再按需读取文本内容。 */
  async getFileContent(ref: MarketItemRef, relativePath: string): Promise<{ content: string | null; reason?: string; stale: boolean }> {
    const normalized = normalizeRef(ref);
    requireGithubSource(normalized.source, '查看文件');
    const detail = await this.getDetail(normalized);
    const file = detail.files.find((entry) => entry.path === relativePath);
    if (!file || !relativePath || relativePath.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')) {
      throw new MarketError('MARKET_ITEM_NOT_FOUND', `技能文件不存在：${relativePath}`, false);
    }
    if (file.size > 2 * 1024 * 1024) {
      return { content: null, reason: '文件超过 2 MB，无法在应用内预览', stale: detail.stale };
    }
    const cacheKey = `file-content-${normalized.source}-${normalized.skillId}-${relativePath}`;
    const cached = this.cache.read<string>(cacheKey, this.ttl.detail);
    if (cached?.fresh) return { content: cached.value, stale: detail.stale };

    const repoFilePath = detail.repoPath ? `${detail.repoPath}/${relativePath}` : relativePath;
    try {
      const response = await this.http.getBuffer(repoRawFileUrl(normalized.source, repoFilePath), {
        timeoutMs: this.timeoutMs,
        maxBytes: 2 * 1024 * 1024,
      });
      if (response.status !== 200) {
        throw new MarketError('MARKET_FETCH_FAILED', `读取文件返回 HTTP ${response.status}`, true, response.status);
      }
      if (response.buffer.includes(0)) {
        return { content: null, reason: '二进制文件无法在应用内预览', stale: detail.stale };
      }
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(response.buffer);
      } catch {
        return { content: null, reason: '文件不是 UTF-8 文本，无法在应用内预览', stale: detail.stale };
      }
      this.cache.write(cacheKey, content);
      return { content, stale: detail.stale };
    } catch (error) {
      if (cached) return { content: cached.value, stale: true };
      throw asMarketError(error);
    }
  }

  private async loadRepoTree(
    source: string,
  ): Promise<{ entries: ReturnType<typeof parseRepoTree>['entries']; stale: boolean }> {
    const cacheKey = `repo-${source}`;
    const cached = this.cache.read<ReturnType<typeof parseRepoTree>>(cacheKey, this.ttl.repoTree);
    if (cached?.fresh) {
      return { entries: cached.value.entries, stale: false };
    }
    try {
      const res = await this.http.getText(repoTreeUrl(source), {
        timeoutMs: this.timeoutMs,
        maxBytes: 32 * 1024 * 1024,
        headers: { accept: 'application/vnd.github+json' },
      });
      if (res.status === 404) {
        throw new MarketError('MARKET_ITEM_NOT_FOUND', `GitHub 仓库不存在或不可访问：${source}`, false, 404);
      }
      if (res.status === 403 || res.status === 429) {
        throw new MarketError(
          'MARKET_FETCH_FAILED',
          `GitHub 接口受限（HTTP ${res.status}，可能触发未鉴权限流），请稍后重试`,
          true,
          res.status,
        );
      }
      if (res.status !== 200) {
        throw new MarketError('MARKET_FETCH_FAILED', `GitHub 文件树返回 HTTP ${res.status}`, true, res.status);
      }
      const parsed = parseRepoTree(res.text);
      if (parsed.truncated) {
        throw new MarketError(
          'MARKET_FETCH_FAILED',
          `上游仓库 ${source} 文件树过大，GitHub 返回 truncated，无法列出完整文件清单`,
          false,
        );
      }
      this.cache.write(cacheKey, parsed);
      return { entries: parsed.entries, stale: false };
    } catch (err) {
      const error = asMarketError(err);
      if (cached && error.code !== 'MARKET_ITEM_NOT_FOUND') {
        return { entries: cached.value.entries, stale: true };
      }
      throw error;
    }
  }

  private async loadSkillMarkdown(
    source: string,
    skillId: string,
    dirPath: string,
  ): Promise<{ name: string; description: string; stale: boolean }> {
    const cacheKey = `skillmd-${source}-${dirPath}`;
    const cached = this.cache.read<{ name: string; description: string }>(cacheKey, this.ttl.skillMd);
    if (cached?.fresh) {
      return { ...cached.value, stale: false };
    }
    const filePath = dirPath.length === 0 ? 'SKILL.md' : `${dirPath}/SKILL.md`;
    try {
      const res = await this.http.getText(repoRawFileUrl(source, filePath), {
        timeoutMs: this.timeoutMs,
        maxBytes: 2 * 1024 * 1024,
      });
      if (res.status !== 200) {
        throw new MarketError('MARKET_FETCH_FAILED', `读取 SKILL.md 返回 HTTP ${res.status}`, true, res.status);
      }
      const parsed = parseSkillMarkdown(res.text);
      this.cache.write(cacheKey, parsed);
      this.cache.write(`file-content-${source}-${skillId}-SKILL.md`, res.text);
      return { ...parsed, stale: false };
    } catch (err) {
      if (cached) return { ...cached.value, stale: true };
      // 描述是增强信息：读取失败不阻断详情（文件清单仍可用），但如实标记
      this.logger?.error('market:skillmd-failed', { source, dirPath, error: asMarketError(err).detail });
      return { name: '', description: '', stale: false };
    }
  }

  // ────────────────────────── 安装（复用 T02 入库） ──────────────────────────

  /**
   * 批量安装：逐项下载 → 解压 → 定位技能目录 → 一次 importSkills 入库。
   * 单项失败不影响其他项；结果与输入顺序一致；临时会话目录在结束时清理。
   */
  async installItems(
    refs: MarketItemRef[],
    opts: {
      signal?: { aborted: boolean };
      onProgress?: (result: MarketInstallResult) => void;
    } = {},
  ): Promise<MarketInstallBatchResult> {
    const results: Array<MarketInstallResult | null> = refs.map(() => null);
    /** 同名冲突项保留下来的已下载目录（见 retainConflictDir） */
    const retained: Array<{ itemId: string; dir: string }> = [];
    if (refs.length === 0) return { results: [], requested: 0 };

    const sessionDir = path.join(this.tempDir, `market-${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    try {
      const pending: Array<{ index: number; ref: MarketItemRef; item: ImportItem }> = [];
      // 同一仓库的多选只下载一次（批量安装常见：一个仓库贡献多个技能）
      const repoRoots = new Map<string, Promise<string>>();

      for (let i = 0; i < refs.length; i++) {
        const fallbackId = `${refs[i]?.source ?? ''}/${refs[i]?.skillId ?? ''}`;
        const fallbackName = refs[i]?.name ?? refs[i]?.skillId ?? fallbackId;
        if (opts.signal?.aborted === true) {
          results[i] = {
            itemId: fallbackId,
            name: fallbackName,
            status: 'failed',
            skillId: null,
            reason: '导入已取消（abort）',
            code: 'ABORTED',
            retryable: true,
          };
          continue;
        }
        try {
          const ref = normalizeRef(refs[i]);
          requireGithubSource(ref.source, '从市场安装');
          let rootPromise = repoRoots.get(ref.source);
          if (rootPromise == null) {
            const workDir = path.join(sessionDir, `repo-${repoRoots.size}`);
            rootPromise = this.downloadRepo(ref.source, workDir);
            repoRoots.set(ref.source, rootPromise);
          }
          const root = await rootPromise;
          const dir = findSkillDirOnDisk(root, ref.skillId);
          if (dir == null) {
            throw new MarketError(
              'MARKET_ITEM_NOT_FOUND',
              `下载的仓库 ${ref.source} 中未找到技能 ${ref.skillId}（上游可能已删除或改名）`,
              false,
            );
          }
          pending.push({
            index: i,
            ref,
            item: {
              path: dir,
              source: {
                type: 'market',
                origin: buildUpstreamUrl(ref.source, ref.skillId),
                sourceRelPath: path.relative(root, dir).split(path.sep).join('/') || '.',
              },
            },
          });
        } catch (err) {
          const error = asMarketError(err);
          results[i] = {
            itemId: fallbackId,
            name: fallbackName,
            status: 'failed',
            skillId: null,
            reason: error.detail,
            code: error.code,
            retryable: error.retryable,
          };
        }
      }

      if (pending.length > 0) {
        let cursor = 0;
        const batch = await this.sources.importSkills(
          pending.map((p) => p.item),
          {
            // 不传 sessionDir：importSkills 会在返回前删掉它，下面的「保留冲突内容」就来不及复制。
            // 会话目录由本方法的 finally 统一清理。
            signal: opts.signal,
            onProgress: (result: ImportItemResult) => {
              const target = pending[cursor++];
              if (!target) return;
              const mapped = this.mapImportResult(target.ref, result);
              results[target.index] = mapped;
              opts.onProgress?.(mapped);
            },
          },
        );
        batch.results.forEach((result, k) => {
          const target = pending[k];
          if (!target || results[target.index] != null) return;
          results[target.index] = this.mapImportResult(target.ref, result);
        });
        // 同名冲突：内容已经下载并解包，保留该项目录供「查看差异 / 覆盖」复用（不二次下载）
        for (const target of pending) {
          const result = results[target.index];
          if (result?.code !== 'NAME_CONFLICT') continue;
          const dir = this.retainConflictDir(target.item.path);
          if (dir != null) retained.push({ itemId: result.itemId, dir });
        }
      }

      return {
        requested: refs.length,
        results: results.map((r, i) => {
          if (r != null) return r;
          const ref = refs[i];
          return {
            itemId: `${ref?.source ?? ''}/${ref?.skillId ?? ''}`,
            name: ref?.name ?? ref?.skillId ?? '',
            status: 'failed',
            skillId: null,
            reason: '导入未执行（批次中止或条目未处理）',
            code: 'ABORTED',
            retryable: true,
          };
        }),
        ...(retained.length > 0 ? { retained } : {}),
      };
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }

  /**
   * 冲突项的已下载技能目录另存一份到 TEMP（会话目录整体删除后仍可用）。
   * 只复制这一项，不带仓库其余内容；清理由调用方（安装服务）负责。
   */
  private retainConflictDir(dir: string): string | null {
    const parent = path.join(this.tempDir, `market-conflict-${crypto.randomUUID().slice(0, 8)}`);
    try {
      fs.mkdirSync(parent, { recursive: true });
      const target = path.join(parent, path.basename(dir));
      fs.cpSync(dir, target, { recursive: true, dereference: false });
      return target;
    } catch (err) {
      this.logger?.error('market:retain-conflict-failed', { dir, error: (err as Error).message });
      return null;
    }
  }

  private mapImportResult(ref: MarketItemRef, result: ImportItemResult): MarketInstallResult {
    return {
      itemId: itemIdOf(ref),
      name: result.name,
      status: result.status,
      skillId: result.skillId,
      ...(result.reason == null ? {} : { reason: result.reason }),
      ...(result.code == null ? {} : { code: result.code }),
      // 重名冲突/非技能目录不可通过重试解决；网络与内部失败可重试
      retryable: result.status === 'failed' && !['NAME_CONFLICT', 'INVALID_NAME', 'NOT_A_SKILL'].includes(result.code ?? ''),
    };
  }

  /** 下载 GitHub 仓库 zip → 安全解压 → 返回解包根（只落 TEMP 会话目录）。 */
  private async downloadRepo(source: string, workDir: string): Promise<string> {
    fs.mkdirSync(workDir, { recursive: true });
    const zipPath = path.join(workDir, 'repo.zip');
    const url = repoZipUrl(source);

    let res;
    try {
      res = await this.http.getBuffer(url, { timeoutMs: Math.max(this.timeoutMs, 60_000), maxBytes: 256 * 1024 * 1024 });
    } catch (err) {
      const error = asMarketError(err);
      throw new MarketError('MARKET_DOWNLOAD_FAILED', `下载 ${url} 失败：${error.detail}`, true);
    }
    if (res.status === 404) {
      throw new MarketError('MARKET_ITEM_NOT_FOUND', `上游仓库不存在或不可访问：${source}`, false, 404);
    }
    if (res.status !== 200) {
      throw new MarketError(
        'MARKET_DOWNLOAD_FAILED',
        `下载 ${url} 返回 HTTP ${res.status}`,
        true,
        res.status,
      );
    }
    fs.writeFileSync(zipPath, res.buffer);

    const extractDir = path.join(workDir, 'extract');
    try {
      extractZipSafe(zipPath, extractDir);
    } catch (err) {
      throw new MarketError('MARKET_DOWNLOAD_FAILED', `下载内容解压失败：${(err as Error).message}`, true);
    }

    return unwrapSingleRoot(extractDir);
  }
}

/** 市场站点地址（供 UI 展示「来源：skills.sh」）。 */
export const MARKET_ORIGIN = MARKET_SITE_ORIGIN;
