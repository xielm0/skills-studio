/**
 * T06：结构化错误与 Pi 错误码映射（tec.md §8：错误必须带 code + detail，不静默失败）。
 */
import type { AgentErrorCode } from './types';

/** 领域错误：code 供 UI/CLI 分支，detail 为可读中文说明（不含密钥）。 */
export class AgentRunError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    readonly detail: string,
    readonly retryable = false,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'AgentRunError';
  }

  toJSON(): { code: AgentErrorCode; detail: string; retryable: boolean } {
    return { code: this.code, detail: this.detail, retryable: this.retryable };
  }
}

/** 把任意异常归一为 AgentRunError（未知异常按 PI_RUN_FAILED / 调用方指定的兜底码）。 */
export function asAgentError(err: unknown, fallback: AgentErrorCode = 'PI_RUN_FAILED'): AgentRunError {
  if (err instanceof AgentRunError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AgentRunError(fallback, message.slice(0, 500));
}

/**
 * 把 Pi（provider 层）返回的错误文本映射为结构化错误码。
 * 依据实测：请求失败时 `prompt()` 不抛异常，而是 assistant 消息 stopReason='error'，
 * errorMessage 形如 `401: {"error":{...}}` / `500: ...`；取消时为 `Request was aborted`。
 */
export function mapProviderErrorMessage(message: string): { code: AgentErrorCode; retryable: boolean } {
  const text = message.toLowerCase();
  if (/timed?\s*out|timeout|etimedout|esockettimedout|deadline exceeded/.test(text)) {
    return { code: 'PROVIDER_TIMEOUT', retryable: true };
  }
  if (/\b(401|403)\b|unauthor|invalid[_ ]api[_ ]key|incorrect api key|authentication|forbidden/.test(text)) {
    return { code: 'PROVIDER_AUTH_FAILED', retryable: false };
  }
  if (/\b429\b|rate limit|quota|insufficient_quota/.test(text)) {
    return { code: 'PROVIDER_ERROR', retryable: true };
  }
  if (/econnrefused|enotfound|econnreset|fetch failed|network|socket hang up/.test(text)) {
    return { code: 'PROVIDER_ERROR', retryable: true };
  }
  return { code: 'PROVIDER_ERROR', retryable: false };
}
