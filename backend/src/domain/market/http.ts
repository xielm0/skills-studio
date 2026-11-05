/**
 * 市场 HTTP 层（tec.md §7.3：HTTPS 抓取、显式超时、失败语义明确）。
 *
 * 只用 Node 22 全局 fetch；手动跟随重定向（最多 5 跳）以便限制跳转次数、
 * 记录最终 URL，并把网络/超时/超限统一映射成 MARKET_FETCH_FAILED。
 * 测试可注入实现（见 MarketHttpClient），实况请求只出现在 t05 的 live 用例。
 */
import { MarketError } from './types';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** 默认超时（与参考实现 skillssh_api.rs 的 15s 对齐）。 */
export const DEFAULT_MARKET_TIMEOUT_MS = 15_000;

export interface MarketHttpRequestOptions {
  /** 单次请求超时（含重定向各跳） */
  timeoutMs?: number;
  /** 响应体上限，超出即失败（避免上游改版返回巨大页面拖垮进程） */
  maxBytes?: number;
  headers?: Record<string, string>;
}

export interface MarketHttpResponseBase {
  /** 最终响应状态码 */
  status: number;
  /** 请求的原始 URL */
  url: string;
  /** 跟随重定向后的 URL */
  finalUrl: string;
  contentType: string | null;
}

export interface MarketTextResponse extends MarketHttpResponseBase {
  text: string;
}

export interface MarketBufferResponse extends MarketHttpResponseBase {
  buffer: Buffer;
}

/** 可注入的 HTTP 客户端（测试用 fixture 替换真实网络）。 */
export interface MarketHttpClient {
  getText(url: string, opts?: MarketHttpRequestOptions): Promise<MarketTextResponse>;
  getBuffer(url: string, opts?: MarketHttpRequestOptions): Promise<MarketBufferResponse>;
}

export interface FetchHttpClientOptions {
  userAgent?: string;
  timeoutMs?: number;
  /** 文本响应上限（skills.sh 首页约 0.9MB） */
  maxTextBytes?: number;
  /** 二进制响应上限（GitHub 仓库 zip） */
  maxBufferBytes?: number;
}

function describeNetworkError(err: unknown, url: string, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  const code = e?.cause?.code;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return `请求超时（${timeoutMs}ms）：${url}`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `网络不可达（DNS 解析失败）：${url}`;
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `网络连接失败（${code}）：${url}`;
  }
  return `请求失败：${url}（${e?.message ?? String(err)}）`;
}

/** 基于全局 fetch 的实现：超时 + UA + 重定向上限 + 响应体上限。 */
export function createFetchHttpClient(opts: FetchHttpClientOptions = {}): MarketHttpClient {
  const userAgent = opts.userAgent ?? 'skills-studio/0.1';
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_MARKET_TIMEOUT_MS;
  const maxTextBytes = opts.maxTextBytes ?? 8 * 1024 * 1024;
  const maxBufferBytes = opts.maxBufferBytes ?? 128 * 1024 * 1024;

  async function request(
    url: string,
    o: MarketHttpRequestOptions,
    as: 'text',
  ): Promise<MarketTextResponse>;
  async function request(
    url: string,
    o: MarketHttpRequestOptions,
    as: 'buffer',
  ): Promise<MarketBufferResponse>;
  async function request(
    url: string,
    o: MarketHttpRequestOptions,
    as: 'text' | 'buffer',
  ): Promise<MarketTextResponse | MarketBufferResponse> {
    const timeoutMs = o.timeoutMs ?? defaultTimeoutMs;
    const maxBytes = o.maxBytes ?? (as === 'text' ? maxTextBytes : maxBufferBytes);
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res: Response;
      try {
        res = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'user-agent': userAgent,
            accept: as === 'text' ? 'text/html,application/json;q=0.9,*/*;q=0.8' : '*/*',
            ...o.headers,
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new MarketError('MARKET_FETCH_FAILED', describeNetworkError(err, current, timeoutMs), true);
      }

      if (REDIRECT_STATUS.has(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new MarketError(
            'MARKET_FETCH_FAILED',
            `上游返回 ${res.status} 但没有 Location 头：${current}`,
            true,
            res.status,
          );
        }
        if (hop === MAX_REDIRECTS) {
          throw new MarketError(
            'MARKET_FETCH_FAILED',
            `重定向超过 ${MAX_REDIRECTS} 次：${url}`,
            false,
            res.status,
          );
        }
        current = new URL(location, current).toString();
        continue;
      }

      const declared = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new MarketError(
          'MARKET_FETCH_FAILED',
          `响应体超过上限（${declared} > ${maxBytes} 字节）：${current}`,
          false,
          res.status,
        );
      }

      const contentType = res.headers.get('content-type');
      if (as === 'buffer') {
        let buffer: Buffer;
        try {
          buffer = Buffer.from(await res.arrayBuffer());
        } catch (err) {
          throw new MarketError('MARKET_FETCH_FAILED', describeNetworkError(err, current, timeoutMs), true);
        }
        if (buffer.length > maxBytes) {
          throw new MarketError(
            'MARKET_FETCH_FAILED',
            `响应体超过上限（${buffer.length} > ${maxBytes} 字节）：${current}`,
            false,
            res.status,
          );
        }
        return { status: res.status, url, finalUrl: current, contentType, buffer };
      }

      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        throw new MarketError('MARKET_FETCH_FAILED', describeNetworkError(err, current, timeoutMs), true);
      }
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new MarketError(
          'MARKET_FETCH_FAILED',
          `响应体超过上限（${Buffer.byteLength(text, 'utf8')} > ${maxBytes} 字节）：${current}`,
          false,
          res.status,
        );
      }
      return { status: res.status, url, finalUrl: current, contentType, text };
    }

    throw new MarketError('MARKET_FETCH_FAILED', `重定向超过 ${MAX_REDIRECTS} 次：${url}`, false);
  }

  return {
    getText: (url, o = {}) => request(url, o, 'text'),
    getBuffer: (url, o = {}) => request(url, o, 'buffer'),
  };
}
