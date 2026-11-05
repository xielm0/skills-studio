/**
 * 技能目录内容哈希（tec.md §5.2：变更判定一律用内容哈希，不用修改时间）。
 * 覆盖文件相对路径 + 内容；忽略 .git、__pycache__、node_modules、Thumbs.db、.DS_Store、*.pyc
 * （Python 产物必须排除，否则技能跑一次就会被判「已变更」）。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const IGNORED_DIRS = new Set(['.git', '__pycache__', 'node_modules']);
const IGNORED_FILES = new Set(['Thumbs.db', '.DS_Store']);
const IGNORED_EXTS = ['.pyc'];

/** T02：忽略清单谓词（导入复制、发现统计与哈希共用同一套，保证口径一致）。 */
export function isIgnoredDirName(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

export function isIgnoredFileName(name: string): boolean {
  return IGNORED_FILES.has(name) || IGNORED_EXTS.includes(path.extname(name).toLowerCase());
}

/** 计算目录的内容哈希（sha256 hex）。目录不存在时抛错。 */
export function hashSkillDir(dir: string): string {
  return hashAndSizeSkillDir(dir).hash;
}

/** 可折叠文本：UTF-8 且不含 NUL（与参考产品 fold_crlf 同一口径）。 */
function isFoldableText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** CRLF → LF；二进制原样返回。只折叠成对的 \r\n，孤立 \r 保留（它可能是内容本身）。 */
export function foldCrlf(buf: Buffer): Buffer {
  if (!buf.includes('\r\n') || !isFoldableText(buf)) return buf;
  const folded = Buffer.allocUnsafe(buf.length);
  let written = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    folded[written++] = buf[i];
  }
  return folded.subarray(0, written);
}

/**
 * 行尾不敏感的目录内容哈希（文本文件的 CRLF 折叠为 LF，忽略清单与 hashSkillDir 一致）。
 *
 * **平局判定，不是替代**：技能身份仍是 hashSkillDir 的逐字节哈希（覆盖、回滚校验都用它）；
 * 只有当两个字节哈希**已经不相等**时，才用它回答更窄的问题——「这两棵树除行尾符外还有别的差异吗」。
 * 存在理由：同一个技能经 Windows git 检出（CRLF）与市场 / GitHub 下载（LF）到达本机，
 * 内容其实一致，不该被报成「同名但内容不同」。
 */
export function hashSkillDirEolInsensitive(dir: string): string {
  const hash = crypto.createHash('sha256');
  hashDir(dir, '.', hash, () => undefined, true);
  return hash.digest('hex');
}

/** 两棵技能树是否只差行尾符；调用方须先确认字节哈希不同，否则不必算。 */
export function sameSkillIgnoringEol(a: string, b: string): boolean {
  return hashSkillDirEolInsensitive(a) === hashSkillDirEolInsensitive(b);
}

/** Skill 中参与内容比较的普通文件的最新 mtime；忽略项与内容哈希一致。 */
export function skillContentMtime(root: string): number | null {
  try {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) return stat.mtimeMs;
    let latest = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (isIgnoredDirName(entry.name) || isIgnoredFileName(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) latest = Math.max(latest, fs.statSync(full).mtimeMs);
      }
    };
    walk(root);
    return latest || stat.mtimeMs;
  } catch {
    return null;
  }
}

/** T02：内容哈希 + 内容总字节数（同一遍遍历、同一忽略清单）。 */
export function hashAndSizeSkillDir(dir: string): { hash: string; sizeBytes: number } {
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  hashDir(dir, '.', hash, (n) => {
    sizeBytes += n;
  });
  return { hash: hash.digest('hex'), sizeBytes };
}

/**
 * T02：目录内每个文件的内容哈希表（relPath（'/' 分隔）→ sha256 hex），
 * 忽略清单与 hashSkillDir 一致，供逐文件差异比较使用。
 * fold=true 时按 LF 归一口径（只折叠 CRLF，文本文件），差异弹窗用它判断「这个文件算不算改过」。
 */
export function buildFileHashMap(dir: string, fold = false): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) return out;
  collectFileHashes(dir, '.', out, fold);
  return out;
}

function collectFileHashes(dir: string, rel: string, out: Map<string, string>, fold: boolean): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (isIgnoredDirName(entry.name) || isIgnoredFileName(entry.name)) continue;
    const relPath = rel === '.' ? entry.name : `${rel}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFileHashes(full, relPath, out, fold);
    } else if (entry.isFile()) {
      const buf = fs.readFileSync(full);
      out.set(relPath, crypto.createHash('sha256').update(fold ? foldCrlf(buf) : buf).digest('hex'));
    }
  }
}

function hashDir(dir: string, rel: string, hash: crypto.Hash, onBytes: (n: number) => void, fold = false): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  // 确定性顺序：同内容不同枚举顺序必须得到同一哈希
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (IGNORED_FILES.has(entry.name)) continue;
    if (IGNORED_EXTS.includes(path.extname(entry.name).toLowerCase())) continue;

    const relPath = rel === '.' ? entry.name : `${rel}/${entry.name}`;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      hashDir(full, relPath, hash, onBytes, fold);
    } else if (entry.isFile()) {
      const buf = fs.readFileSync(full);
      hash.update(relPath);
      hash.update('\0');
      hash.update(fold ? foldCrlf(buf) : buf);
      hash.update('\0');
      onBytes(buf.length);
    }
    // 符号链接不参与哈希（部署是链接形态，跟内容变更无关）
  }
}
