/**
 * zip 安全解压（tec.md §5.7：解包到临时目录 → 校验 → 原子入库 的第一步）。
 * 使用 adm-zip（纯 JS、零运行时依赖、MIT；同步 API 贴合导入流程），不装原生模块。
 * 安全边界：magic 校验（仅 .zip，tar.gz 等明确报「暂不支持」）+ Zip Slip 防护
 * （绝对路径、`..` 段、越出解包根的条目一律跳过）。
 */
import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceError } from '../domain/sources/types';
import { isPathSafe } from '../domain/path-guard';

/** zip 本地文件头魔数（PK\x03\x04；空档/跨卷变体 PK\x05\x06 / PK\x07\x08）。 */
function isZipMagic(b: Buffer): boolean {
  return (
    b.length >= 2 &&
    b[0] === 0x50 &&
    b[1] === 0x4b &&
    ((b.length >= 4 && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) || b.length === 2)
  );
}

function isGzipMagic(b: Buffer): boolean {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/**
 * 解压 zipPath 到 destDir（会新建）。非 zip 格式（含 tar.gz）抛 ARCHIVE_UNSUPPORTED。
 */
export function extractZipSafe(zipPath: string, destDir: string): void {
  let head: Buffer;
  try {
    const fd = fs.openSync(zipPath, 'r');
    try {
      const buf = Buffer.alloc(4);
      const read = fs.readSync(fd, buf, 0, 4, 0);
      head = buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    throw new SourceError('ARCHIVE_READ_FAILED', `无法读取压缩包：${(err as Error).message}`);
  }

  if (isGzipMagic(head)) {
    throw new SourceError(
      'ARCHIVE_UNSUPPORTED',
      '暂不支持该压缩格式：检测到 gzip/tar.gz，仅支持 .zip 压缩包',
    );
  }
  if (!isZipMagic(head)) {
    throw new SourceError('ARCHIVE_UNSUPPORTED', '暂不支持该压缩格式：仅支持 .zip 压缩包');
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch (err) {
    throw new SourceError('ARCHIVE_CORRUPT', `压缩包解析失败：${(err as Error).message}`);
  }

  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  const root = path.resolve(destDir);
  for (const entry of zip.getEntries()) {
    // 统一分隔符；拒绝绝对路径与盘符形态
    const name = entry.entryName.replace(/\\/g, '/');
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) continue;

    const segments = name.split('/').filter((s) => s.length > 0);
    if (segments.some((s) => s === '..')) continue; // Zip Slip：拒绝穿越段
    if (segments.length === 0) continue;

    const target = path.join(root, ...segments);
    if (!isPathSafe(root, target)) continue; // 兜底：解析后必须仍在解包根内

    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
    }
  }
}
