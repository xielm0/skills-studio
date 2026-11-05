/**
 * T05 技能市场类型契约（prd.md M12 / tec.md §5.12、§7.3）。
 *
 * 市场只接 skills.sh：上游没有带鉴权的公开数据 API（/api/v1/skills 需 OIDC token），
 * 因此榜单走页面解析、搜索走站点自己的 /api/search。解析结果落 DATA_DIR 缓存，
 * 列表优先读缓存；源不可用时若缓存存在则返回并标注「可能过期」，否则抛结构化错误，
 * 绝不以「0 个 Skill」空列表兜底。
 */
import type { ImportItemStatus } from '../sources/types';

/** 热门榜类型（与 skills.sh 的三条榜单路径对应）：全部时间 / 上升 / 当下最热。 */
export type MarketLeaderboard = 'all-time' | 'trending' | 'hot';

/** 结构化市场错误码（tec.md §7.3：解析失败必须明确报错 + 重试，不降级空列表）。 */
export type MarketErrorCode =
  /** 网络不可达、超时、HTTP 非 2xx、限流 */
  | 'MARKET_FETCH_FAILED'
  /** 页面/JSON 结构不符合预期（上游改版） */
  | 'MARKET_PARSE_FAILED'
  /** 上游没有这个技能（仓库或技能目录不存在） */
  | 'MARKET_ITEM_NOT_FOUND'
  /** 安装下载/解压失败 */
  | 'MARKET_DOWNLOAD_FAILED'
  /** 关键词为空或非法、榜单类型非法 */
  | 'MARKET_INVALID_QUERY'
  /** 条目由站点自行发布（well-known），当前版本没有下载通道 */
  | 'MARKET_SOURCE_UNSUPPORTED';

/** 市场结构化错误：code + detail + retryable（UI 据此给重试入口）。 */
export class MarketError extends Error {
  readonly code: MarketErrorCode;
  readonly detail: string;
  /** 是否值得用户点「重试」（网络/限流/上游改版 = true；条目不存在 = false） */
  readonly retryable: boolean;
  /** 上游 HTTP 状态码（有则记录，便于排查） */
  readonly httpStatus?: number;

  constructor(code: MarketErrorCode, detail: string, retryable: boolean, httpStatus?: number) {
    super(`${code}: ${detail}`);
    this.name = 'MarketError';
    this.code = code;
    this.detail = detail;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }

  toJSON(): { code: MarketErrorCode; detail: string; retryable: boolean; httpStatus?: number } {
    return {
      code: this.code,
      detail: this.detail,
      retryable: this.retryable,
      ...(this.httpStatus == null ? {} : { httpStatus: this.httpStatus }),
    };
  }
}

/** 任意错误归一化为 MarketError（非 MarketError 记为不可重试的内部错误）。 */
export function asMarketError(err: unknown): MarketError {
  if (err instanceof MarketError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new MarketError('MARKET_FETCH_FAILED', message, true);
}

/** 市场列表中的一项（榜单/搜索共用）。 */
export interface MarketItem {
  /** 稳定标识：`<source>/<skillId>`（重复项按此去重） */
  id: string;
  /** 上游来源：GitHub 为 `owner/repo`；站点自发布为域名（无 `/`） */
  source: string;
  /** 上游技能标识（仓库内目录名 / SKILL.md 的 name） */
  skillId: string;
  name: string;
  installs: number;
  isOfficial?: boolean;
  /**
   * 上游榜单/搜索响应里没有描述字段；列表行通过 getListingDescription 按需补齐。
   */
  description?: string;
  /** 上游页面地址（skills.sh） */
  upstreamUrl: string;
}

/** 调用方传入的最小条目（UI 多选后回传 id 即可）。 */
export interface MarketItemRef {
  source: string;
  skillId: string;
  name?: string;
  installs?: number;
  isOfficial?: boolean;
  description?: string;
}

/** 列表结果：显式区分「新鲜缓存 / 过期缓存 / 实时」，不让调用方猜。 */
export interface MarketListResult {
  items: MarketItem[];
  /** 数据获取时间（缓存命中时为缓存写入时间） */
  fetchedAt: string;
  /** true = 来自本地缓存（未发起网络请求或网络失败后回退） */
  fromCache: boolean;
  /** true = 缓存已过期且源不可用，内容可能过期（UI 必须标注） */
  stale: boolean;
  /** 人读提示（stale 时含「可能过期」） */
  warning?: string;
  /** 本次数据对应的上游地址（实况排查用） */
  sourceUrl: string;
}

/** 搜索结果额外带关键词。 */
export interface MarketSearchResult extends MarketListResult {
  query: string;
}

/** 详情中的一个文件（相对技能目录，'/' 分隔）。 */
export interface MarketFileEntry {
  path: string;
  size: number;
}

/** 市场条目详情：文件清单 + 总大小 + scripts 下可执行脚本。 */
export interface MarketDetail {
  item: MarketItem;
  /** frontmatter description（上游列表不提供，这里从 SKILL.md 读取） */
  description: string;
  /** SKILL.md frontmatter 的 name（缺失时为空） */
  skillName: string;
  /** 文件清单（含 SKILL.md；按路径排序） */
  files: MarketFileEntry[];
  fileCount: number;
  /** 文件总字节数 */
  totalBytes: number;
  /** scripts/ 下可执行脚本相对路径（.py/.sh/.ps1/.bat） */
  executableScripts: string[];
  /** 技能在上游仓库中的目录路径（排查用） */
  repoPath: string;
  fetchedAt: string;
  fromCache: boolean;
  stale: boolean;
  warning?: string;
  /** SKILL.md 读取失败时为 true（详情仍可用，但描述缺失） */
  descriptionUnavailable?: boolean;
}

/** 逐项安装结果（PRD 5.7：已入库、跳过、失败）。 */
export interface MarketInstallResult {
  /** 对应输入条目的 id */
  itemId: string;
  name: string;
  status: ImportItemStatus;
  skillId: string | null;
  reason?: string;
  code?: string;
  /** 失败时是否可重试（网络/上游 = true；条目不存在/重名冲突 = false） */
  retryable?: boolean;
}

export interface MarketInstallBatchResult {
  /** 与输入顺序一致 */
  results: MarketInstallResult[];
  requested: number;
  /**
   * 同名冲突项保留下来的已下载技能目录（TEMP_DIR 内）。
   * 用户查看差异/选择覆盖时直接读这份拷贝，不再二次下载；调用方负责在用完后删除。
   */
  retained?: Array<{ itemId: string; dir: string }>;
}
