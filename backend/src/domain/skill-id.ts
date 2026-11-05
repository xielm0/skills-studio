/**
 * 稳定 Skill ID（tec.md §5.1：入库时生成、全局唯一、可排序；持久于元数据文件，
 * 索引重建复用元数据中的 ID，不重新生成）。
 *
 * 格式：sk_ + 9 位 base36 时间戳（毫秒）+ 8 位 base36 随机
 *  - 9 位 base36 可表示至 36^9 ≈ 1.0e14 ms（约公元 5138 年），字典序即创建时间序；
 *  - 8 位随机（crypto）≈ 2.8e12 组合，同一毫秒内碰撞概率可忽略；
 *  - 仅小写字母数字与下划线，对文件系统/URL/SQLite 均安全。
 */
import * as crypto from 'node:crypto';

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const TS_LEN = 9;
const RAND_LEN = 8;

function toBase36(value: number, pad: number): string {
  let out = '';
  let v = value;
  while (v > 0) {
    out = BASE36[v % 36] + out;
    v = Math.floor(v / 36);
  }
  return out.padStart(pad, '0');
}

function randomBase36(len: number): string {
  // 6 bit/字符取低 36 值域，偏置可忽略（36 < 64，拒绝采样不必要）
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += BASE36[bytes[i] % 36];
  return out;
}

export function generateSkillId(now: number = Date.now()): string {
  return `sk_${toBase36(now, TS_LEN)}${randomBase36(RAND_LEN)}`;
}

/** 校验是否为本格式生成的 ID（用于读回元数据时的防御）。 */
export function isSkillId(value: string): boolean {
  return /^sk_[0-9a-z]{17}$/.test(value);
}
