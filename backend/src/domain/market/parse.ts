/**
 * skills.sh 页面/接口解析（T05；参考实现 src-tauri/src/core/skillssh_api.rs 的
 * 「先 __NEXT_DATA__、再页面内嵌 JSON」策略，按当前站点结构改为解析 Next.js flight 载荷）。
 *
 * 实测（2026-10-25）：
 *  - 榜单页 /、/trending、/hot 把技能数组放在 flight 载荷的 `initialSkills` 里，
 *    字段为 source / skillId / name / installs（+ weeklyInstalls / isOfficial / change）；
 *    普通 HTML 中该载荷被包在 `self.__next_f.push([1,"…"])` 的 JSON 字符串里（引号被转义）。
 *  - 搜索走站点自己的 `/api/search?q=&limit=`，返回 `{query, skills:[{id,source,skillId,name,installs}]}`。
 *  - 两个列表都不提供 description；市场列表不请求简介，结构化 description / Summary 解析保留为兼容能力。
 *
 * 结构不符合预期时一律抛 MARKET_PARSE_FAILED，绝不返回空数组冒充「没有技能」。
 */
import { parseFrontmatter } from '../frontmatter';
import { MarketError } from './types';
import type { MarketFileEntry, MarketItem } from './types';

/** 市场站点根（页面与搜索接口同源，便于 HTTP keep-alive 复用连接）。 */
export const MARKET_SITE_ORIGIN = 'https://www.skills.sh';

/** scripts/ 下按可执行脚本提示的扩展名（与 T02 发现逻辑一致）。 */
const EXECUTABLE_EXTS = new Set(['.py', '.sh', '.ps1', '.bat']);

/** 上游技能页地址；站点自发布（source 为域名）走 /site/<domain>/<skill>。 */
export function buildUpstreamUrl(source: string, skillId: string): string {
  const path = source.includes('/')
    ? `${source}/${skillId}`
    : `site/${source}/${skillId}`;
  return `${MARKET_SITE_ORIGIN}/${path}`;
}

/** 榜单页地址。 */
export function leaderboardUrl(board: string): string {
  switch (board) {
    case 'trending':
      return `${MARKET_SITE_ORIGIN}/trending`;
    case 'hot':
      return `${MARKET_SITE_ORIGIN}/hot`;
    default:
      return `${MARKET_SITE_ORIGIN}/`;
  }
}

/** 搜索接口地址（limit 由调用方 clamp）。 */
export function searchUrl(query: string, limit: number): string {
  return `${MARKET_SITE_ORIGIN}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
}

/** 安装下载地址（GitHub 仓库 zip；HEAD 跟随默认分支，与参考实现的 clone 默认分支一致）。 */
export function repoZipUrl(source: string): string {
  return `https://codeload.github.com/${source}/zip/HEAD`;
}

/** 仓库文件树接口（列文件与大小用，不拉全仓）。 */
export function repoTreeUrl(source: string): string {
  return `https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`;
}

/** 仓库内单个文件（raw），用于读取 SKILL.md 元数据和详情页文件内容。 */
export function repoRawFileUrl(source: string, filePath: string): string {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${source}/HEAD/${encoded}`;
}

// ────────────────────────── 榜单 / 搜索 ──────────────────────────

interface RawSkillEntry {
  source?: unknown;
  skillId?: unknown;
  skill_id?: unknown;
  id?: unknown;
  name?: unknown;
  installs?: unknown;
  isOfficial?: unknown;
  description?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * 把上游条目归一化为 MarketItem；结构缺失（source/skillId）返回 null。
 * 上游 `id` 是 `<source>/<skillId>`，仅在 skillId 缺失时用于兜底（剥离 source 前缀）。
 */
function toMarketItem(raw: unknown): MarketItem | null {
  if (!isRecord(raw)) return null;
  const entry = raw as RawSkillEntry;
  const source = asNonEmptyString(entry.source);
  if (!source) return null;

  let skillId =
    asNonEmptyString(entry.skillId) ?? asNonEmptyString(entry.skill_id) ?? null;
  if (!skillId) {
    const fullId = asNonEmptyString(entry.id);
    if (fullId && fullId.startsWith(`${source}/`)) {
      skillId = fullId.slice(source.length + 1);
    } else if (fullId && !fullId.includes('/')) {
      skillId = fullId;
    }
  }
  if (!skillId || skillId.includes('/')) return null;

  const name = asNonEmptyString(entry.name) ?? skillId;
  const item: MarketItem = {
    id: `${source}/${skillId}`,
    source,
    skillId,
    name,
    installs: asNumber(entry.installs),
    upstreamUrl: buildUpstreamUrl(source, skillId),
  };
  if (entry.isOfficial === true) item.isOfficial = true;
  const description = asNonEmptyString(entry.description);
  if (description) item.description = description;
  return item;
}

function dedupe(items: MarketItem[]): MarketItem[] {
  const seen = new Set<string>();
  const out: MarketItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** 列表归一化：输入非空但 0 条可用 → 视为结构变化（抛错），不冒充空榜单。 */
function normalizeEntries(entries: unknown[], context: string): MarketItem[] {
  const items = dedupe(
    entries.map(toMarketItem).filter((x): x is MarketItem => x !== null),
  );
  if (entries.length > 0 && items.length === 0) {
    throw new MarketError(
      'MARKET_PARSE_FAILED',
      `${context}：解析出 0 条可用技能（上游字段结构可能已变化）`,
      true,
    );
  }
  return items;
}

/**
 * 从任意文本中按 `"initialSkills":` 标记提取 JSON 数组。
 * 用括号配对扫描（识别字符串与转义），比正则更抗嵌套。
 */
function extractJsonArrayAfter(text: string, marker: string): unknown[] | null {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('[', at + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 从 HTML 的 `self.__next_f.push([1,"…"])` 片段收集 flight 载荷文本。
 * JSON.parse 负责反转义，避免手写正则处理 `\"`。
 */
function collectFlightText(html: string): string {
  const marker = 'self.__next_f.push(';
  const parts: string[] = [];
  let cursor = 0;
  while (true) {
    const at = html.indexOf(marker, cursor);
    if (at < 0) break;
    // marker 末尾就是 '('：从这里开始计深度，才能与 ')' 配对
    const open = at + marker.length - 1;
    let i = open;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let close = -1;
    for (; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) break;
    // 去掉外层括号，只把 `[1,"…"]` 交给 JSON.parse
    const literal = html.slice(open + 1, close);
    try {
      const parsed: unknown = JSON.parse(literal);
      if (Array.isArray(parsed) && typeof parsed[1] === 'string') {
        parts.push(parsed[1]);
      } else if (Array.isArray(parsed) && isRecord(parsed[1])) {
        parts.push(JSON.stringify(parsed[1]));
      }
    } catch {
      /* 单个 chunk 不是合法 JSON：跳过，交给后续标记判定 */
    }
    cursor = close + 1;
  }
  return parts.join('\n');
}

/** 兼容旧版 Next.js：`<script id="__NEXT_DATA__">` 内的 pageProps 数组。 */
function parseNextData(html: string): unknown[] | null {
  const marker = '<script id="__NEXT_DATA__"';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const open = html.indexOf('>', at);
  const close = html.indexOf('</script>', open + 1);
  if (open < 0 || close < 0) return null;
  try {
    const data: unknown = JSON.parse(html.slice(open + 1, close));
    if (!isRecord(data)) return null;
    const props = data.props;
    if (!isRecord(props)) return null;
    const pageProps = props.pageProps;
    if (!isRecord(pageProps)) return null;
    for (const key of ['initialSkills', 'skills', 'items']) {
      const value = pageProps[key];
      if (Array.isArray(value)) return value;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 解析榜单页（普通 HTML 或 RSC flight 文本均可）。
 * 找不到 `initialSkills` 或数组为空 → MARKET_PARSE_FAILED（明确报错 + 可重试）。
 */
export function parseLeaderboardPayload(payload: string, context = 'skills.sh 榜单'): MarketItem[] {
  const nextData = parseNextData(payload);
  if (nextData) {
    const items = normalizeEntries(nextData, context);
    if (items.length > 0) return items;
    // 旧版载荷为空时继续尝试 flight 载荷（新版站点两种结构并存期）
  }

  const flight = collectFlightText(payload);
  for (const text of flight.length > 0 ? [flight, payload] : [payload]) {
    const arr = extractJsonArrayAfter(text, '"initialSkills"');
    if (arr == null) continue;
    const items = normalizeEntries(arr, context);
    if (items.length === 0) {
      throw new MarketError('MARKET_PARSE_FAILED', `${context}：榜单为空`, true);
    }
    return items;
  }

  throw new MarketError(
    'MARKET_PARSE_FAILED',
    `${context}：未找到 initialSkills 数据（页面结构可能已变化，请重试或稍后再试）`,
    true,
  );
}

/**
 * 解析搜索接口 JSON。
 * 响应必须含 `skills` 数组（或根数组）；空数组是合法「无匹配」，结构缺失才是解析失败。
 */
export function parseSearchPayload(payload: string, context = 'skills.sh 搜索'): MarketItem[] {
  let root: unknown;
  try {
    root = JSON.parse(payload);
  } catch {
    throw new MarketError('MARKET_PARSE_FAILED', `${context}：响应不是合法 JSON`, true);
  }

  let entries: unknown[];
  if (Array.isArray(root)) {
    entries = root;
  } else if (isRecord(root) && Array.isArray(root.skills)) {
    entries = root.skills;
  } else {
    throw new MarketError(
      'MARKET_PARSE_FAILED',
      `${context}：响应缺少 skills 数组（接口结构可能已变化）`,
      true,
    );
  }
  return normalizeEntries(entries, context);
}

export interface MarketListingDescription {
  text: string;
  source: 'description' | 'summary' | 'unavailable';
}

/** 解码 Summary 首段中常见的 HTML 实体，最终只把纯文本交给界面。 */
function decodeSummaryText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    const normalized = code.toLowerCase();
    if (normalized in named) return named[normalized];
    const value = normalized.startsWith('#x') ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
  }).replace(/\s+/g, ' ').trim();
}

/** 详情页优先取结构化 description；缺失时才用页面 Summary 的首段简介。 */
export function parseListingDescription(html: string): MarketListingDescription {
  for (const script of html.matchAll(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value: unknown = JSON.parse(script[1]);
      if (isRecord(value)) {
        const description = asNonEmptyString(value.description);
        if (description) return { text: description, source: 'description' };
      }
    } catch {
      // 其他结构化脚本损坏时仍尝试页面 Summary。
    }
  }
  const summary = html.match(/>Summary<\/div>[\s\S]{0,12000}?<p\b[^>]*>([\s\S]*?)<\/p>/i);
  const text = summary ? decodeSummaryText(summary[1]) : '';
  return text ? { text, source: 'summary' } : { text: '', source: 'unavailable' };
}

// ────────────────────────── 仓库文件树 / 技能目录 ──────────────────────────

export interface RepoTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size: number;
}

export interface RepoTree {
  entries: RepoTreeEntry[];
  /** GitHub 对超大仓库会截断文件树 */
  truncated: boolean;
}

/** 解析 GitHub git/trees 响应。 */
export function parseRepoTree(payload: string): RepoTree {
  let root: unknown;
  try {
    root = JSON.parse(payload);
  } catch {
    throw new MarketError('MARKET_PARSE_FAILED', 'GitHub 文件树响应不是合法 JSON', true);
  }
  if (!isRecord(root) || !Array.isArray(root.tree)) {
    throw new MarketError('MARKET_PARSE_FAILED', 'GitHub 文件树响应缺少 tree 数组', true);
  }
  const entries: RepoTreeEntry[] = [];
  for (const raw of root.tree) {
    if (!isRecord(raw)) continue;
    const p = asNonEmptyString(raw.path);
    const type = raw.type;
    if (!p || (type !== 'blob' && type !== 'tree')) continue;
    entries.push({ path: p, type, size: asNumber(raw.size) });
  }
  if (entries.length === 0) {
    throw new MarketError('MARKET_PARSE_FAILED', 'GitHub 文件树为空', true);
  }
  return { entries, truncated: root.truncated === true };
}

/** `a/b/SKILL.md` → `a/b`（大小写不敏感匹配 SKILL.md/skill.md）。 */
function dirOfSkillMd(entry: RepoTreeEntry): string | null {
  if (!/(^|\/)(SKILL\.md|skill\.md)$/i.test(entry.path)) return null;
  const idx = entry.path.lastIndexOf('/');
  return idx < 0 ? '' : entry.path.slice(0, idx);
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? p : p.slice(idx + 1);
}

/**
 * 在仓库文件树中定位技能目录（优先级与参考实现 find_skill_dir 一致）：
 * `<id>` → `skills/<id>` → `.agents/skills/<id>` → 任意目录名/大小写匹配。
 */
export function findSkillDirInTree(entries: RepoTreeEntry[], skillId: string): string | null {
  const skillDirs = new Set<string>();
  for (const entry of entries) {
    const dir = dirOfSkillMd(entry);
    if (dir != null) skillDirs.add(dir);
  }
  const preferred = [skillId, `skills/${skillId}`, `.agents/skills/${skillId}`];
  for (const candidate of preferred) {
    if (skillDirs.has(candidate)) return candidate;
  }
  const exact = [...skillDirs].filter((d) => basename(d) === skillId).sort();
  if (exact.length > 0) return exact[0];
  const loose = [...skillDirs]
    .filter((d) => basename(d).toLowerCase() === skillId.toLowerCase())
    .sort();
  return loose.length > 0 ? loose[0] : null;
}

export interface TreeSkillDescription {
  dirPath: string;
  files: MarketFileEntry[];
  totalBytes: number;
  executableScripts: string[];
}

/** 统计某技能目录下的文件清单、总字节数与 scripts/ 可执行脚本。 */
export function describeTreeSkill(
  entries: RepoTreeEntry[],
  skillId: string,
): TreeSkillDescription | null {
  const dirPath = findSkillDirInTree(entries, skillId);
  if (dirPath == null) return null;
  const prefix = dirPath.length === 0 ? '' : `${dirPath}/`;
  // 技能目录就是仓库根时，排除子目录里的其他技能，避免把别人的文件算进清单
  const nestedSkillDirs =
    dirPath.length === 0
      ? entries
          .map(dirOfSkillMd)
          .filter((d): d is string => d != null && d.length > 0)
      : [];

  const files: MarketFileEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.type !== 'blob') continue;
    if (prefix.length > 0 && !entry.path.startsWith(prefix)) continue;
    if (nestedSkillDirs.some((d) => entry.path.startsWith(`${d}/`))) continue;
    const rel = prefix.length === 0 ? entry.path : entry.path.slice(prefix.length);
    if (rel.length === 0 || rel.includes('/../')) continue;
    files.push({ path: rel, size: entry.size });
    totalBytes += entry.size;
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const executableScripts = files
    .filter((f) => {
      const segments = f.path.split('/');
      const ext = f.path.slice(f.path.lastIndexOf('.')).toLowerCase();
      return segments.includes('scripts') && EXECUTABLE_EXTS.has(ext);
    })
    .map((f) => f.path)
    .sort();

  return { dirPath, files, totalBytes, executableScripts };
}

/** 从 SKILL.md 内容取 frontmatter 的 name / description。 */
export function parseSkillMarkdown(markdown: string): { name: string; description: string } {
  const meta = parseFrontmatter(markdown);
  return { name: meta.name ?? '', description: meta.description ?? '' };
}
