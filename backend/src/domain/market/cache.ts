/**
 * 市场本地缓存（tec.md §5.12 / §6.2：市场缓存属于本机数据，落 DATA_DIR，不进库、不进 Git）。
 *
 * 结构：`DATA_DIR/market-cache/<sanitized-key>-<sha1(key)[0..10]>.json`
 *   { schemaVersion: 1, key, fetchedAt, value }
 * 每个条目独立文件 + 原子写（tmp → rename），损坏/版本不符按「无缓存」处理，
 * 让列表逻辑回退到网络而不是被一条坏缓存拖死。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CACHE_SCHEMA_VERSION = 1;

export interface MarketCacheEntry<T> {
  value: T;
  /** 写入时间（ISO 8601） */
  fetchedAt: string;
  /** 是否仍在 TTL 内 */
  fresh: boolean;
}

interface CacheFile<T> {
  schemaVersion: number;
  key: string;
  fetchedAt: string;
  value: T;
}

export class MarketCache {
  readonly dir: string;

  constructor(dir: string, private readonly now: () => Date = () => new Date()) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 缓存文件名：可读前缀 + 稳定哈希（避免超长/非法字符与大小写冲突）。 */
  fileFor(key: string): string {
    const prefix = key.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48);
    const digest = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
    return path.join(this.dir, `${prefix}-${digest}.json`);
  }

  /** 读取任意年龄的缓存（用于源不可用时的「可能过期」回退）。 */
  readAny<T>(key: string): MarketCacheEntry<T> | null {
    const file = this.fileFor(key);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const entry = parsed as Partial<CacheFile<T>>;
      if (entry.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
      if (typeof entry.fetchedAt !== 'string' || Number.isNaN(Date.parse(entry.fetchedAt))) return null;
      if (entry.value === undefined) return null;
      return { value: entry.value as T, fetchedAt: entry.fetchedAt, fresh: false };
    } catch {
      return null;
    }
  }

  /** 读取 TTL 内的缓存；过期条目返回 fresh=false（调用方决定是否直接回退）。 */
  read<T>(key: string, ttlMs: number): MarketCacheEntry<T> | null {
    const hit = this.readAny<T>(key);
    if (!hit) return null;
    const age = this.now().getTime() - Date.parse(hit.fetchedAt);
    return { ...hit, fresh: Number.isFinite(age) && age >= 0 && age <= ttlMs };
  }

  /** 原子写入；返回文件路径（测试断言用）。 */
  write<T>(key: string, value: T): string {
    const file = this.fileFor(key);
    const payload: CacheFile<T> = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      key,
      fetchedAt: this.now().toISOString(),
      value,
    };
    const tmp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
    return file;
  }

  /** 删除单个条目（测试/强制刷新用）。 */
  remove(key: string): void {
    fs.rmSync(this.fileFor(key), { force: true });
  }
}
