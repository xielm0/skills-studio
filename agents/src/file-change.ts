/** Bounded, read-only snapshots around an Agent write/edit tool call. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { diffLines } from 'diff';
import type { SessionFileChange, SessionFileChangeSide, SessionFileChangeSnapshot } from './types';

const MAX_DIFF_BYTES = 1024 * 1024;

export interface CapturedFile extends SessionFileChangeSide {
  hash: string | null;
}

export function captureFile(file: string): CapturedFile {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, content: null, reason: null, hash: null };
    }
    return { exists: true, content: null, reason: 'NOT_A_FILE', hash: null };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { exists: true, content: null, reason: 'NOT_A_FILE', hash: null };
  }
  if (stat.size > MAX_DIFF_BYTES) {
    return { exists: true, content: null, reason: 'TOO_LARGE', hash: `${stat.size}:${stat.mtimeMs}` };
  }
  try {
    const bytes = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.includes(0)) return { exists: true, content: null, reason: 'BINARY', hash };
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
    return { exists: true, content, reason: null, hash };
  } catch (error) {
    return { exists: true, content: null, reason: (error instanceof TypeError ? 'BINARY' : 'NOT_A_FILE'), hash: null };
  }
}

export function compareCapturedFile(relPath: string, before: CapturedFile, after: CapturedFile): {
  change: SessionFileChange;
  snapshot: SessionFileChangeSnapshot;
} | null {
  if (before.hash != null && before.hash === after.hash) return null;
  if (!before.exists && !after.exists) return null;
  if (before.exists && after.exists && before.hash === null && after.hash === null &&
    before.reason === 'NOT_A_FILE' && after.reason === 'NOT_A_FILE') return null;
  if (before.content != null && before.content === after.content) return null;
  const status = !before.exists ? 'added' : !after.exists ? 'removed' : 'modified';
  let added: number | null = null;
  let removed: number | null = null;
  if ((before.content != null || !before.exists) && (after.content != null || !after.exists)) {
    added = 0;
    removed = 0;
    for (const part of diffLines(before.content ?? '', after.content ?? '')) {
      if (part.added) added += part.count ?? 0;
      if (part.removed) removed += part.count ?? 0;
    }
  }
  const side = (file: CapturedFile): SessionFileChangeSide => ({
    exists: file.exists, content: file.content, reason: file.reason,
  });
  return {
    change: { relPath, status, added, removed },
    snapshot: { before: side(before), after: side(after) },
  };
}
