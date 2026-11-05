/**
 * T06：日志/事件/会话落盘脱敏（prd.md §6.2、tec.md §6.2、用例 C-27）。
 *
 * 两层防线：
 *  1) 已登记的秘密（凭据管理器读到的 API Key）按字面量替换；
 *  2) 常见密钥形态（Bearer 头、sk- 前缀、api_key/authorization 字段）按模式替换。
 *
 * 所有写盘路径（会话 JSON、事件 JSONL、运行日志）都必须过 `redactUnknown` / `redactText`。
 */

import * as fs from 'node:fs';

const MAX_SECRET_LEN = 4096;

const secrets = new Set<string>();

/** 登记需要脱敏的秘密（长度过短的值会造成误伤，直接忽略）。 */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < 6 || trimmed.length > MAX_SECRET_LEN) return;
  secrets.add(trimmed);
}

/** 清空已登记秘密（测试隔离用）。 */
export function clearSecrets(): void {
  secrets.clear();
}

/** 当前已登记秘密数量（诊断用，不返回内容）。 */
export function registeredSecretCount(): number {
  return secrets.size;
}

/** 长秘密优先替换，避免子串先被替换后残留。 */
function sortedSecrets(): string[] {
  return [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * 文本脱敏：
 *  - 已登记秘密 → `[REDACTED]`
 *  - `Bearer xxx` → `Bearer [REDACTED]`
 *  - `sk-xxxx` → `[REDACTED]`
 *  - `api_key/token/authorization: xxx` → 值替换
 */
export function redactText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const secret of sortedSecrets()) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(/\b(Bearer|Basic|Token)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [REDACTED]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
  out = out.replace(
    /("?\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|secret)\b"?\s*[:=]\s*)("?)([^"\s,}]{6,})\2/gi,
    '$1$2[REDACTED]$2',
  );
  return out;
}

/** 深拷贝并脱敏（对象/数组/字符串；其他类型原样返回）。 */
export function redactUnknown<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // 键名本身也可能是敏感值（例如模型误把 key 当键名），统一过一遍
      out[redactText(key)] = redactUnknown(item);
    }
    return out as unknown as T;
  }
  return value;
}

/** 日志接口（与 src/logger.ts 的 Logger 结构兼容）。 */
export interface RedactableLogger {
  info(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
}

/**
 * 就地清洗一个已有文本文件中的密钥（用于 Pi 原生会话 JSONL：
 * 它由内核直接追加写，应用无法在写入前拦截，故运行结束后统一清一遍）。
 * 返回是否发生了替换。
 */
export function scrubFileSecrets(file: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const next = redactText(raw);
  if (next === raw) return false;
  const tmp = `${file}.redact.tmp`;
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

/** 包装任意 logger，写入前统一脱敏。 */
export function withRedaction(logger: RedactableLogger): RedactableLogger {
  return {
    info: (event, data) => logger.info(redactText(event), data === undefined ? undefined : redactUnknown(data)),
    error: (event, data) => logger.error(redactText(event), data === undefined ? undefined : redactUnknown(data)),
  };
}
