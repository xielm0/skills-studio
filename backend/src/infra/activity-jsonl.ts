/**
 * 近期动态事件存储（tec.md §6.2：创建/导入/内容变更/部署状态变化事件按稳定 Skill ID
 * 写入 DATA_DIR 的持久记录，与可重建的 SQLite 索引分开存放；索引重建不得制造新事件）。
 *
 * 形式：JSONL 追加文件（DATA_DIR/activity.jsonl）。事件是真相类数据（保留真实发生时间），
 * 不能因删 DB 而丢，也不适合塞进派生索引，故独立于 index.db。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActivityEvent } from '../domain/types';

export class ActivityStore {
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /** 追加一条事件；eventId 缺省时生成。真实 occurredAt 由调用方传入。 */
  append(event: Omit<ActivityEvent, 'eventId'> & { eventId?: string }): ActivityEvent {
    const full: ActivityEvent = {
      eventId: event.eventId ?? `ev_${crypto.randomUUID().replace(/-/g, '')}`,
      skillId: event.skillId,
      type: event.type,
      occurredAt: event.occurredAt,
      detail: event.detail,
    };
    fs.appendFileSync(this.file, JSON.stringify(full) + '\n', 'utf8');
    return full;
  }

  /** 全量读取（损坏行跳过）。 */
  loadAll(): ActivityEvent[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: ActivityEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ActivityEvent;
        if (typeof e.eventId === 'string' && typeof e.skillId === 'string' && typeof e.type === 'string') {
          out.push(e);
        }
      } catch {
        /* 跳过损坏行 */
      }
    }
    return out;
  }

  /** 每技能只保留最新一条，按发生时间倒序（主页「近期动态」数据源）。 */
  loadRecentPerSkill(): ActivityEvent[] {
    const latest = new Map<string, ActivityEvent>();
    for (const e of this.loadAll()) {
      const cur = latest.get(e.skillId);
      if (!cur || e.occurredAt > cur.occurredAt || (e.occurredAt === cur.occurredAt && e.eventId > cur.eventId)) {
        latest.set(e.skillId, e);
      }
    }
    return [...latest.values()].sort((a, b) =>
      a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0,
    );
  }

  count(): number {
    return this.loadAll().length;
  }
}
