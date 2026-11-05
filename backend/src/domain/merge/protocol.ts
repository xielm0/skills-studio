/**
 * 提交协议标记（tec.md §5.10 三段防御之一，照搬竞品 `merge/protocol.rs` 的取舍）：
 *  - 每次应用提交都带 `Skills-Sync-Protocol: 1` trailer；
 *  - 树里始终保留 `.skills-sync/protocol.json`（sticky：已有更高版本不降级，
 *    恢复旧快照后下一次提交自愈式补回）；
 *  - 拉取前比对双方协议版本，不一致即中止并说明，不猜、不混跑。
 *
 * 纯函数部分（字节生成、消息拼装/解析）可单独测试；文件读写由调用方负责。
 */

export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_PROTOCOL_DIR = '.skills-sync';
export const SYNC_PROTOCOL_FILE = '.skills-sync/protocol.json';
export const PROTOCOL_TRAILER = 'Skills-Sync-Protocol';
export const CONFLICTS_TRAILER = 'Skills-Sync-Conflicts';
export const RESOLVED_TRAILER = 'Skills-Sync-Resolved';

/** trailer 单行最多列出的冲突 ID 数（溢出记 `+N`，用于提示分批处理）。 */
export const CONFLICTS_TRAILER_CAP = 20;

export interface ProtocolFile {
  protocolVersion: number;
}

/** 协议文件的规范字节（两端必须产生逐字节相同的 blob）。 */
export function protocolFileBytes(version: number = SYNC_PROTOCOL_VERSION): string {
  return JSON.stringify({ protocolVersion: version } satisfies ProtocolFile, null, 2) + '\n';
}

/** 解析协议文件；非法/缺字段返回 null（调用方按「不兼容」处理）。 */
export function parseProtocolFile(raw: string): ProtocolFile | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ProtocolFile>;
    if (typeof parsed.protocolVersion !== 'number' || !Number.isInteger(parsed.protocolVersion)) return null;
    if (parsed.protocolVersion <= 0) return null;
    return { protocolVersion: parsed.protocolVersion };
  } catch {
    return null;
  }
}

/**
 * 生成应用提交信息：正文 + 空行 + trailer 行（按传入顺序，值已 trim）。
 * 每次备份 / 合并 / 冲突解决 / 恢复前快照都必须经过这里。
 */
export function appCommitMessage(subject: string, trailers: Record<string, string | null | undefined> = {}): string {
  const lines: string[] = [subject.trimEnd()];
  const trailerLines: string[] = [];
  for (const [key, value] of Object.entries(trailers)) {
    const v = value?.trim();
    if (!v) continue;
    trailerLines.push(`${key}: ${v}`);
  }
  if (trailerLines.length > 0) lines.push('', ...trailerLines);
  return lines.join('\n');
}

/** 提交信息是否带协议 trailer（识别「不懂配对规则的旧客户端」写下的提交）。 */
export function hasProtocolTrailer(message: string): boolean {
  return message
    .split(/\r?\n/)
    .some((line) => line.trimStart().toLowerCase().startsWith(`${PROTOCOL_TRAILER.toLowerCase()}:`));
}

/** 读取 `Key: id1, id2` 形式的 trailer，跳过溢出标记 `+N`。 */
export function parseTrailerIds(message: string, key: string): string[] {
  const prefix = `${key.toLowerCase()}:`;
  const out: string[] = [];
  for (const rawLine of message.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line.toLowerCase().startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    for (const part of rest.split(',')) {
      const id = part.trim();
      if (!id || id.startsWith('+')) continue;
      out.push(id);
    }
  }
  return out;
}

/** 格式化冲突 trailer（排序保证跨机一致；超上限记 `+N`）。 */
export function formatConflictsTrailer(skillIds: string[]): string | null {
  if (skillIds.length === 0) return null;
  const sorted = [...skillIds].sort();
  const shown = sorted.slice(0, CONFLICTS_TRAILER_CAP);
  const overflow = sorted.length - shown.length;
  return `${shown.join(', ')}${overflow > 0 ? `, +${overflow}` : ''}`;
}
