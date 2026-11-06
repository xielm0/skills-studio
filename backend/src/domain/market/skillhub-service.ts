/** SkillHub 市场适配器：使用公开列表、文件与 ZIP 接口，不复用 skills.sh 的 GitHub 路径。 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractZipSafe } from '../../infra/zip-extract';
import { isSkillDir } from '../frontmatter';
import type { SkillSourceService } from '../sources/source-service';
import { createFetchHttpClient, type MarketHttpClient } from './http';
import { MarketError, type MarketDetail, type MarketInstallBatchResult, type MarketItem, type MarketItemRef, type MarketListResult, type MarketSearchResult } from './types';

export const SKILLHUB_SOURCE = 'skillhub.cn';
const API = 'https://api.skillhub.cn';
const slugPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function skillHubUrl(slug: string, publisher?: string): string {
  return `https://skillhub.cn/skills/${encodeURIComponent(slug)}${publisher ? `?publisher=${encodeURIComponent(publisher)}` : ''}`;
}

export function skillHubRef(origin: string | undefined): { slug: string; publisher?: string } | null {
  try {
    const url = new URL(origin ?? '');
    const parts = url.pathname.split('/').filter(Boolean);
    const publisher = url.searchParams.get('publisher');
    return url.hostname === SKILLHUB_SOURCE && parts.length === 2 && parts[0] === 'skills' && slugPattern.test(parts[1])
      && (!publisher || slugPattern.test(publisher)) ? { slug: parts[1], ...(publisher ? { publisher } : {}) } : null;
  } catch { return null; }
}

type SkillHubListingItem = { slug: string; name: string; description?: string; description_zh?: string; downloads?: number;
  ownerName?: string; homepage?: string; source?: string; version?: string };

function publisherOf(item: SkillHubListingItem): string | null {
  try {
    const url = new URL(item.homepage ?? '');
    const parts = url.pathname.split('/').filter(Boolean);
    return url.hostname === 'api.skillhub.cn' && parts.length === 2 && parts[1] === item.slug && slugPattern.test(parts[0]) ? parts[0] : null;
  } catch { return null; }
}

async function preferredSkill(slug: string, http: MarketHttpClient): Promise<SkillHubListingItem & { publisher: string; version: string }> {
  if (!slugPattern.test(slug)) throw new MarketError('MARKET_INVALID_QUERY', 'SkillHub 技能标识无效', false);
  const url = `${API}/api/skills?slug=${encodeURIComponent(slug)}&pageSize=100`;
  const response = await http.getText(url, { maxBytes: 512 * 1024 });
  if (response.status !== 200) throw new MarketError('MARKET_FETCH_FAILED', `SkillHub 标识查询返回 HTTP ${response.status}`, true, response.status);
  let payload: { code?: number; data?: { total?: number; skills?: SkillHubListingItem[] } };
  try { payload = JSON.parse(response.text); } catch { throw new MarketError('MARKET_PARSE_FAILED', 'SkillHub 标识查询格式无效', true); }
  if (payload.code !== 0 || !Number.isInteger(payload.data?.total) || !Array.isArray(payload.data?.skills)
    || payload.data!.total !== payload.data!.skills!.length) throw new MarketError('MARKET_PARSE_FAILED', 'SkillHub 标识查询结果不完整', true);
  const ranked = payload.data!.skills!.filter((item) => item.slug === slug && Number.isFinite(item.downloads))
    .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
  const best = ranked[0];
  const publisher = best && publisherOf(best);
  if (!best || !publisher || !best.version || !/^[a-zA-Z0-9._-]+$/.test(best.version)
    || (ranked[1] && ranked[1].downloads === best.downloads)) {
    throw new MarketError('MARKET_SOURCE_UNSUPPORTED', `SkillHub 标识 ${slug} 无法确定下载量最高的发布者`, false);
  }
  return { ...best, publisher, version: best.version };
}

/** 仅在隔离临时目录下载和解压；返回的目录由调用方用完后释放。 */
export async function latestSkillHubVersion(slug: string, http: MarketHttpClient): Promise<string> {
  return (await latestSkillHubRelease(slug, http)).version;
}

export async function latestSkillHubRelease(slug: string, http: MarketHttpClient): Promise<{ publisher: string; version: string }> {
  const best = await preferredSkill(slug, http);
  return { publisher: best.publisher, version: best.version };
}

export async function downloadSkillHubSnapshot(slug: string, tempDir: string, http: MarketHttpClient, version?: string, publisher?: string): Promise<{ dir: string; dispose(): void }> {
  if (!slugPattern.test(slug)) throw new MarketError('MARKET_INVALID_QUERY', 'SkillHub 技能标识无效', false);
  if (version && !/^[a-zA-Z0-9._-]+$/.test(version)) throw new MarketError('MARKET_INVALID_QUERY', 'SkillHub 版本号无效', false);
  if (publisher && !slugPattern.test(publisher)) throw new MarketError('MARKET_INVALID_QUERY', 'SkillHub 发布者无效', false);
  const session = path.join(tempDir, `skillhub-${crypto.randomUUID()}`);
  try {
    const identifier = publisher ? `@${publisher}/${slug}` : slug;
    const response = await http.getBuffer(`${API}/api/v1/download?slug=${encodeURIComponent(identifier)}${version ? `&version=${encodeURIComponent(version)}` : ''}`, { timeoutMs: 60_000, maxBytes: 128 * 1024 * 1024 });
    if (response.status !== 200) throw new MarketError(response.status === 404 ? 'MARKET_ITEM_NOT_FOUND' : 'MARKET_DOWNLOAD_FAILED', `SkillHub 下载返回 HTTP ${response.status}`, response.status !== 404, response.status);
    fs.mkdirSync(session, { recursive: true });
    const archive = path.join(session, 'skill.zip');
    const extracted = path.join(session, 'extract');
    fs.writeFileSync(archive, response.buffer);
    extractZipSafe(archive, extracted);
    let dir = extracted;
    for (let depth = 0; depth < 3 && !isSkillDir(dir); depth++) {
      const children = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
      if (children.length !== 1) break;
      dir = path.join(dir, children[0].name);
    }
    if (!isSkillDir(dir)) throw new MarketError('MARKET_ITEM_NOT_FOUND', 'SkillHub 下载包中未找到唯一的 SKILL.md', false);
    return { dir, dispose: () => fs.rmSync(session, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(session, { recursive: true, force: true });
    throw error;
  }
}

type Listing = { code: number; data?: { skills?: SkillHubListingItem[] } };

export class SkillHubService {
  private readonly http: MarketHttpClient;
  constructor(private readonly opts: { tempDir: string; sources: SkillSourceService; http?: MarketHttpClient }) {
    this.http = opts.http ?? createFetchHttpClient();
  }

  private async list(url: string): Promise<MarketListResult> {
    const response = await this.http.getText(url, { maxBytes: 4 * 1024 * 1024 });
    if (response.status !== 200) throw new MarketError('MARKET_FETCH_FAILED', `SkillHub 列表返回 HTTP ${response.status}`, true, response.status);
    let payload: Listing;
    try { payload = JSON.parse(response.text) as Listing; } catch { throw new MarketError('MARKET_PARSE_FAILED', 'SkillHub 列表格式无效', true); }
    if (payload.code !== 0 || !Array.isArray(payload.data?.skills)) throw new MarketError('MARKET_PARSE_FAILED', 'SkillHub 列表缺少技能数据', true);
    const bySlug = new Map<string, SkillHubListingItem>();
    for (const item of payload.data.skills) {
      if (!slugPattern.test(item.slug) || !publisherOf(item)) continue;
      const previous = bySlug.get(item.slug);
      if (!previous || (item.downloads ?? 0) > (previous.downloads ?? 0)) bySlug.set(item.slug, item);
    }
    const items: MarketItem[] = [...bySlug.values()].map((item) => ({
      id: `${SKILLHUB_SOURCE}/${item.slug}`, source: SKILLHUB_SOURCE, skillId: item.slug,
      publisher: publisherOf(item)!,
      name: item.name || item.slug, description: item.description_zh || item.description || '',
      installs: item.downloads ?? 0, upstreamUrl: skillHubUrl(item.slug, publisherOf(item)!),
    }));
    return { items, fetchedAt: new Date().toISOString(), fromCache: false, stale: false, sourceUrl: url };
  }

  getLeaderboard(): Promise<MarketListResult> {
    return this.list(`${API}/api/skills?sortBy=downloads&order=desc&pageSize=100`);
  }

  async searchSkills(query: string): Promise<MarketSearchResult> {
    const q = query.trim();
    if (!q || q.length > 120) throw new MarketError('MARKET_INVALID_QUERY', 'SkillHub 搜索关键词无效', false);
    return { ...await this.list(`${API}/api/skills?keyword=${encodeURIComponent(q)}&sortBy=downloads&order=desc&pageSize=100`), query: q };
  }

  async getDetail(ref: MarketItemRef): Promise<MarketDetail> {
    const slug = ref.skillId;
    if (ref.source !== SKILLHUB_SOURCE || !slugPattern.test(slug)) throw new MarketError('MARKET_INVALID_QUERY', 'SkillHub 条目无效', false);
    const best = await preferredSkill(slug, this.http);
    if (ref.publisher && ref.publisher !== best.publisher) throw new MarketError('MARKET_SOURCE_UNSUPPORTED', 'SkillHub 榜单已更新，请重新加载后再试', false);
    const [detail, listing] = await Promise.all([
      this.http.getText(`${API}/api/v1/skills/${encodeURIComponent(slug)}`, { maxBytes: 2 * 1024 * 1024 }),
      this.http.getText(`${API}/api/v1/skills/${encodeURIComponent(slug)}/files`, { maxBytes: 4 * 1024 * 1024 }),
    ]);
    if (detail.status !== 200 || listing.status !== 200) throw new MarketError('MARKET_FETCH_FAILED', `SkillHub 详情返回 HTTP ${detail.status}/${listing.status}`, true);
    let info: { skill?: { displayName?: string; summary_zh?: string; summary?: string; source?: string }; owner?: { handle?: string } };
    let files: { files?: Array<{ path: string; size: number }> };
    try { info = JSON.parse(detail.text); files = JSON.parse(listing.text); } catch { throw new MarketError('MARKET_PARSE_FAILED', 'SkillHub 详情格式无效', true); }
    if (!Array.isArray(files.files)) throw new MarketError('MARKET_PARSE_FAILED', 'SkillHub 文件列表格式无效', true);
    if (info.owner?.handle !== best.ownerName || info.skill?.source !== best.source) throw new MarketError('MARKET_SOURCE_UNSUPPORTED', 'SkillHub 详情未指向下载量最高的发布者', false);
    const entries = files.files.filter((file) => typeof file.path === 'string' && Number.isFinite(file.size) && !file.path.split('/').some((part) => !part || part === '.' || part === '..'));
    const name = info.skill?.displayName || ref.name || slug;
    const description = info.skill?.summary_zh || info.skill?.summary || '';
    return { item: { id: `${SKILLHUB_SOURCE}/${slug}`, source: SKILLHUB_SOURCE, skillId: slug, publisher: best.publisher, name, installs: ref.installs ?? 0, upstreamUrl: skillHubUrl(slug, best.publisher), description },
      description, skillName: name, files: entries, fileCount: entries.length, totalBytes: entries.reduce((sum, file) => sum + file.size, 0),
      executableScripts: entries.filter((file) => /^scripts\/.*\.(?:py|sh|ps1|bat)$/i.test(file.path)).map((file) => file.path),
      repoPath: '', fetchedAt: new Date().toISOString(), fromCache: false, stale: false };
  }

  async getFileContent(ref: MarketItemRef, relativePath: string): Promise<{ content: string | null; reason?: string; stale: boolean }> {
    const detail = await this.getDetail(ref);
    const file = detail.files.find((item) => item.path === relativePath);
    if (!file) throw new MarketError('MARKET_ITEM_NOT_FOUND', 'SkillHub 文件不存在', false);
    if (file.size > 2 * 1024 * 1024) return { content: null, reason: '文件超过 2 MB，无法预览', stale: false };
    const response = await this.http.getBuffer(`${API}/api/v1/skills/${encodeURIComponent(ref.skillId)}/file?path=${encodeURIComponent(relativePath)}`, { maxBytes: 2 * 1024 * 1024 });
    if (response.status !== 200) throw new MarketError('MARKET_FETCH_FAILED', `SkillHub 文件返回 HTTP ${response.status}`, true);
    if (response.buffer.includes(0)) return { content: null, reason: '二进制文件无法预览', stale: false };
    try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(response.buffer), stale: false }; }
    catch { return { content: null, reason: '文件不是 UTF-8 文本', stale: false }; }
  }

  async installItems(refs: MarketItemRef[]): Promise<MarketInstallBatchResult> {
    const results: MarketInstallBatchResult['results'] = [];
    const retained: NonNullable<MarketInstallBatchResult['retained']> = [];
    for (const ref of refs) {
      let snapshot: Awaited<ReturnType<typeof downloadSkillHubSnapshot>> | undefined;
      try {
        const best = await preferredSkill(ref.skillId, this.http);
        if (ref.publisher && ref.publisher !== best.publisher) throw new MarketError('MARKET_SOURCE_UNSUPPORTED', 'SkillHub 榜单已更新，请重新加载后再试', false);
        const version = best.version;
        ref.version = version;
        snapshot = await downloadSkillHubSnapshot(ref.skillId, this.opts.tempDir, this.http, version, best.publisher);
        const imported = await this.opts.sources.importSkills([{ path: snapshot.dir, source: { type: 'market', origin: skillHubUrl(ref.skillId, best.publisher), sourceRelPath: '.', sourceRevision: version } }]);
        ref.publisher = best.publisher;
        const item = imported.results[0];
        if (item?.code === 'NAME_CONFLICT') {
          const conflictRoot = path.join(this.opts.tempDir, `skillhub-conflict-${crypto.randomUUID()}`);
          const conflictDir = path.join(conflictRoot, 'skill');
          fs.cpSync(snapshot.dir, conflictDir, { recursive: true });
          retained.push({ itemId: `${SKILLHUB_SOURCE}/${ref.skillId}`, dir: conflictDir });
        }
        results.push({ itemId: `${SKILLHUB_SOURCE}/${ref.skillId}`, name: item?.name || ref.name || ref.skillId,
          status: item?.status ?? 'failed', skillId: item?.skillId ?? null, reason: item?.reason, code: item?.code });
      } catch (error) {
        results.push({ itemId: `${SKILLHUB_SOURCE}/${ref.skillId}`, name: ref.name || ref.skillId, status: 'failed', skillId: null,
          reason: error instanceof Error ? error.message : String(error), code: error instanceof MarketError ? error.code : 'MARKET_DOWNLOAD_FAILED' });
      } finally { snapshot?.dispose(); }
    }
    return { results, requested: refs.length, retained };
  }
}
