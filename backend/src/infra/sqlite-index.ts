/**
 * SQLite 索引（tec.md §2/§6.2：node:sqlite（Node 22.22 内置，Electron 39 同源，
 * 未来 CLI 免原生模块双 ABI 重建）；WAL；纯派生物——删除 DB 后全量扫描可重建，
 * 任何真相只存在 DB 里都算设计错误。真相 = 技能文件 + skills/*.skill.json）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SkillSummary } from '../domain/types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  skill_id     TEXT PRIMARY KEY,
  dir_name     TEXT NOT NULL UNIQUE,
  rel_path     TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  name_source  TEXT NOT NULL,
  groups_json  TEXT NOT NULL DEFAULT '[]',
  source_json  TEXT,
  sync_json    TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT,
  size_bytes   INTEGER,
  missing      INTEGER NOT NULL DEFAULT 0,
  missing_since TEXT,
  added_at     TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 写入索引的一条技能记录。 */
export interface SkillIndexRecord {
  skillId: string;
  dirName: string;
  /** 相对 skills 根的位置（'/' 分隔，1-2 段；平铺 = dirName） */
  relPath: string;
  name: string;
  description: string;
  nameSource: 'frontmatter' | 'dirname';
  groups: string[];
  sourceJson: string | null;
  syncJson: string;
  contentHash: string | null;
  /** T02：内容总字节数（派生自元数据，可空） */
  sizeBytes: number | null;
  missing: boolean;
  missingSince: string | null;
  addedAt: string;
  updatedAt: string;
}

/** 列表项 + 内容哈希（getSkillDetail 组装用）。 */
export interface SkillIndexDetail extends SkillSummary {
  contentHash: string | null;
  sizeBytes: number | null;
}

export class SkillIndexStore {
  private constructor(
    private readonly db: DatabaseSync,
    readonly dbFile: string,
  ) {}

  /**
   * 打开（或创建）索引 DB。meta.library_path 与当前库路径不一致时清空重建——
   * 索引是派生物，切换库后旧数据无意义。schema 缺列（如 T02 的 size_bytes）时
   * 同样整表重建：索引可由库目录全量重扫恢复，不做增量迁移。
   */
  static open(dbFile: string, libraryDir: string): SkillIndexStore {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA journal_mode=WAL');
    // T08：GUI 与 CLI 同时打开同一索引时，写入可能短暂互斥；等一会儿而不是立刻 SQLITE_BUSY
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(SCHEMA);

    const cols = db.prepare("PRAGMA table_info('skills')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'size_bytes') || !cols.some((c) => c.name === 'rel_path')) {
      db.exec('DROP TABLE skills');
      db.exec(SCHEMA);
    }

    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('library_path') as
      | { value: string }
      | undefined;
    const canonical = path.resolve(libraryDir);
    if (row?.value !== canonical) {
      db.exec('DELETE FROM skills');
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
        'library_path',
        canonical,
      );
    }
    return new SkillIndexStore(db, dbFile);
  }

  /** 事务内全量替换（每次重扫后调用；规模 ≤ 数百技能，代价可忽略）。 */
  replaceAll(records: SkillIndexRecord[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM skills');
      const stmt = this.db.prepare(
        `INSERT INTO skills (skill_id, dir_name, rel_path, name, description, name_source,
          groups_json, source_json, sync_json, content_hash, size_bytes, missing, missing_since,
          added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of records) {
        stmt.run(
          r.skillId,
          r.dirName,
          r.relPath,
          r.name,
          r.description,
          r.nameSource,
          JSON.stringify(r.groups),
          r.sourceJson,
          r.syncJson,
          r.contentHash,
          r.sizeBytes,
          r.missing ? 1 : 0,
          r.missingSince,
          r.addedAt,
          r.updatedAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 读取上一次索引状态（重扫前用于判断丢失→恢复等状态迁移）。 */
  listPrevious(): Map<string, { missing: boolean; missingSince: string | null }> {
    const rows = this.db
      .prepare('SELECT skill_id, missing, missing_since FROM skills')
      .all() as Array<{ skill_id: string; missing: number; missing_since: string | null }>;
    const out = new Map<string, { missing: boolean; missingSince: string | null }>();
    for (const r of rows) {
      out.set(r.skill_id, { missing: r.missing === 1, missingSince: r.missing_since });
    }
    return out;
  }

  list(): SkillSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM skills ORDER BY name COLLATE NOCASE, skill_id')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToSummary);
  }

  get(skillId: string): SkillSummary | null {
    const row = this.db
      .prepare('SELECT * FROM skills WHERE skill_id = ?')
      .get(skillId) as Record<string, unknown> | undefined;
    return row ? rowToSummary(row) : null;
  }

  /** 按目录名（末段）查技能；索引滞后/无记录时返回 null。 */
  getByDirName(dirName: string): SkillSummary | null {
    const row = this.db
      .prepare('SELECT * FROM skills WHERE dir_name = ?')
      .get(dirName) as Record<string, unknown> | undefined;
    return row ? rowToSummary(row) : null;
  }

  getFull(skillId: string): SkillIndexDetail | null {
    const row = this.db
      .prepare('SELECT * FROM skills WHERE skill_id = ?')
      .get(skillId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...rowToSummary(row),
      contentHash: row.content_hash != null ? String(row.content_hash) : null,
      sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : null,
    };
  }

  getSyncConfig(skillId: string): { agents: string[] } | null {
    const row = this.db
      .prepare('SELECT sync_json FROM skills WHERE skill_id = ?')
      .get(skillId) as { sync_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.sync_json) as { agents?: unknown };
      return { agents: Array.isArray(parsed.agents) ? (parsed.agents as string[]) : [] };
    } catch {
      return { agents: [] };
    }
  }

  close(): void {
    this.db.close();
  }
}

function rowToSummary(row: Record<string, unknown>): SkillSummary {
  let groups: string[] = [];
  let source: SkillSummary['source'] = null;
  let syncAgents: string[] = [];
  try {
    groups = JSON.parse(String(row.groups_json ?? '[]')) as string[];
  } catch {
    /* 防御：派生数据损坏时回退默认 */
  }
  if (row.source_json != null) {
    try {
      source = JSON.parse(String(row.source_json)) as SkillSummary['source'];
    } catch {
      source = null;
    }
  }
  try {
    syncAgents = (JSON.parse(String(row.sync_json ?? '{}')) as { agents?: string[] }).agents ?? [];
  } catch {
    syncAgents = [];
  }

  return {
    skillId: String(row.skill_id),
    dirName: String(row.dir_name),
    relPath: String(row.rel_path || row.dir_name),
    name: String(row.name),
    description: String(row.description ?? ''),
    nameSource: row.name_source === 'dirname' ? 'dirname' : 'frontmatter',
    missingName: row.name_source === 'dirname',
    groups,
    source,
    deployedAgents: syncAgents,
    missing: Number(row.missing) === 1,
    missingSince: row.missing_since != null ? String(row.missing_since) : null,
    addedAt: String(row.added_at),
    updatedAt: String(row.updated_at),
  };
}
