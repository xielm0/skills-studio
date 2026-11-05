/**
 * T06：持久会话存储（prd.md §5.9「会话与文件跨应用重启保留」、tec.md §6.2「持久会话」）。
 *
 * 布局（全部在 DATA_DIR 内，不进 Git）：
 *   DATA_DIR/sessions/<sessionId>.json          会话真相（状态/消息/文件引用/运行摘要）
 *   DATA_DIR/sessions/<sessionId>.events.jsonl  事件流审计（脱敏）
 *   DATA_DIR/sessions/diffs/<sessionId>/...    文件变更的前后快照（脱敏）
 *   DATA_DIR/sessions/pi/<...>.jsonl            Pi 原生会话（模型上下文，用于 resume）
 *
 * 「重启后仍可读」是硬要求：因此这里只写本机文件，不依赖进程内缓存；
 * 运行中被进程杀掉留下的 running/cancelling 状态在下次读取时归一为 failed(PI_RUN_INTERRUPTED)。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ThinkingLevel } from './types';
import { AgentRunError } from './errors';
import { redactText, redactUnknown } from './redact';
import type {
  AgentEvent,
  AgentSessionRecord,
  AgentSessionSummary,
  RunStatus,
  SessionFileRef,
  SessionFileChangeSnapshot,
  SessionMessage,
  SessionRun,
} from './types';

export const SESSION_SCHEMA_VERSION = 1;
const TERMINAL: readonly RunStatus[] = ['done', 'failed', 'cancelled'];

export interface CreateSessionInput {
  authorizedDir: string;
  title?: string;
  systemPrompt?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  /** T07：工作流归属（create/improve/evaluate；通用对话为 null） */
  workflow?: 'create' | 'improve' | 'evaluate' | null;
  /** T15：预填但未发送的提示词 */
  draftPrompt?: string | null;
  /** 建会话时的推理强度（沿用上次为该模型选的档；null = 当前模型不支持推理） */
  thinkingLevel?: ThinkingLevel | null;
}

export class ConversationStore {
  /** <DATA_DIR>/sessions */
  readonly dir: string;
  /** <DATA_DIR>/sessions/pi（Pi 原生会话目录） */
  readonly piDir: string;
  /** <DATA_DIR>；用于把 Pi 会话文件存成相对路径 */
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.dir = path.join(this.dataDir, 'sessions');
    this.piDir = path.join(this.dir, 'pi');
    fs.mkdirSync(this.piDir, { recursive: true });
  }

  file(sessionId: string): string {
    return path.join(this.dir, `${assertSessionId(sessionId)}.json`);
  }

  eventsFile(sessionId: string): string {
    return path.join(this.dir, `${assertSessionId(sessionId)}.events.jsonl`);
  }

  private changeFile(sessionId: string, runId: string, relPath: string): string {
    if (!/^run_[a-f0-9]{12}$/.test(runId)) throw new AgentRunError('SESSION_NOT_FOUND', '运行 ID 非法');
    const name = crypto.createHash('sha256').update(relPath).digest('hex');
    return path.join(this.dir, 'diffs', assertSessionId(sessionId), runId, `${name}.json`);
  }

  writeChange(sessionId: string, runId: string, relPath: string, snapshot: SessionFileChangeSnapshot): void {
    const file = this.changeFile(sessionId, runId, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const safe = {
      before: { ...snapshot.before, content: snapshot.before.content == null ? null : redactText(snapshot.before.content) },
      after: { ...snapshot.after, content: snapshot.after.content == null ? null : redactText(snapshot.after.content) },
    };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(safe), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  }

  readChange(sessionId: string, runId: string, relPath: string): SessionFileChangeSnapshot {
    try {
      return JSON.parse(fs.readFileSync(this.changeFile(sessionId, runId, relPath), 'utf8')) as SessionFileChangeSnapshot;
    } catch {
      throw new AgentRunError('SESSION_NOT_FOUND', '文件差异记录不存在');
    }
  }

  removeChange(sessionId: string, runId: string, relPath: string): void {
    fs.rmSync(this.changeFile(sessionId, runId, relPath), { force: true });
  }

  create(input: CreateSessionInput): AgentSessionRecord {
    const now = new Date().toISOString();
    const record: AgentSessionRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: newSessionId(),
      title: (input.title ?? '新对话').trim() || '新对话',
      authorizedDir: path.resolve(input.authorizedDir),
      toolPolicy: 'read-write',
      workflow: input.workflow ?? null,
      createdAt: now,
      updatedAt: now,
      status: 'done',
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      systemPrompt: input.systemPrompt ?? null,
      draftPrompt: input.draftPrompt ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      piSessionFile: null,
      messages: [],
      files: [],
      runs: [],
      error: null,
      resumedAt: null,
    };
    this.save(record);
    return record;
  }

  /**
   * 读取会话。`normalizeInterrupted=true` 时把上次进程遗留的进行中状态归一为失败，
   * 保证重启后 UI 看到的是确定状态而不是永远转圈。
   */
  load(sessionId: string, options: { normalizeInterrupted?: boolean } = {}): AgentSessionRecord {
    const file = this.file(sessionId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      throw new AgentRunError('SESSION_NOT_FOUND', `会话不存在：${sessionId}`);
    }
    let parsed: AgentSessionRecord;
    try {
      parsed = JSON.parse(raw) as AgentSessionRecord;
    } catch {
      throw new AgentRunError('SESSION_NOT_FOUND', `会话文件损坏：${sessionId}`);
    }
    const record = normalizeRecord(parsed, sessionId);
    if (options.normalizeInterrupted !== false && !TERMINAL.includes(record.status)) {
      const now = new Date().toISOString();
      record.status = 'failed';
      record.error = {
        code: 'PI_RUN_INTERRUPTED',
        detail: '应用重启或进程中断，本次运行没有完成（已产生的消息与文件已保留）。',
      };
      for (const run of record.runs) {
        if (!TERMINAL.includes(run.status)) {
          run.status = 'failed';
          run.endedAt = now;
          run.error = { ...record.error };
        }
      }
      for (const message of record.messages) {
        if (message.status === 'streaming') message.status = 'aborted';
      }
      record.updatedAt = now;
      this.save(record);
    }
    return record;
  }

  save(record: AgentSessionRecord): void {
    record.updatedAt = new Date().toISOString();
    const payload = redactUnknown(record);
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(record.sessionId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  exists(sessionId: string): boolean {
    try {
      return fs.statSync(this.file(sessionId)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 删除一条会话的所有落盘产物：会话记录、事件日志与 Pi 会话文件。
   * 授权目录属于技能库或用户数据，不在这里删；调用方负责确认会话未在运行。
   */
  remove(sessionId: string): void {
    const id = assertSessionId(sessionId);
    const file = this.file(id);
    let piRel: string | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { piSessionFile?: unknown };
      piRel = typeof raw.piSessionFile === 'string' ? raw.piSessionFile : null;
    } catch {
      /* 记录损坏时也要能删掉，Pi 文件留给后续清理 */
    }
    fs.rmSync(file, { force: true });
    fs.rmSync(this.eventsFile(id), { force: true });
    fs.rmSync(path.join(this.dir, 'diffs', id), { recursive: true, force: true });
    if (piRel) {
      const abs = path.resolve(this.piPath(piRel));
      const root = path.resolve(this.piDir);
      // 只删会话目录内的文件：记录里的路径可能是脏数据或用户改过的
      if (abs === root || abs.startsWith(`${root}${path.sep}`)) fs.rmSync(abs, { force: true });
    }
  }

  list(options: { activeSessionIds?: ReadonlySet<string> } = {}): AgentSessionSummary[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: AgentSessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const sessionId = entry.name.slice(0, -'.json'.length);
      let record: AgentSessionRecord;
      try {
        // 本进程内正在运行的会话不能被当成「上次中断」而改写状态
        record = this.load(sessionId, {
          normalizeInterrupted: !options.activeSessionIds?.has(sessionId),
        });
      } catch {
        continue;
      }
      const last = [...record.messages].reverse().find((m) => m.text.trim().length > 0);
      out.push({
        sessionId: record.sessionId,
        title: record.title,
        authorizedDir: record.authorizedDir,
        status: record.status,
        providerId: record.providerId,
        modelId: record.modelId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messages.length,
        fileCount: record.files.length,
        lastMessagePreview: last ? truncate(last.text, 120) : null,
        error: record.error,
      });
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  /** 追加事件（脱敏后写 JSONL；事件是审计数据，不需要索引）。 */
  appendEvent(sessionId: string, event: AgentEvent): void {
    const line = JSON.stringify(redactUnknown(event));
    fs.appendFileSync(this.eventsFile(sessionId), `${redactText(line)}\n`, 'utf8');
  }

  readEvents(sessionId: string): AgentEvent[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.eventsFile(sessionId), 'utf8');
    } catch {
      return [];
    }
    const out: AgentEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AgentEvent);
      } catch {
        /* 跳过损坏行 */
      }
    }
    return out;
  }

  /** Pi 会话文件绝对路径 */
  piPath(relative: string): string {
    return path.join(this.dataDir, relative);
  }

  /** 把 Pi 会话文件转成相对 DATA_DIR 的路径（会话是可搬迁的本机数据） */
  toRelative(file: string | undefined | null): string | null {
    if (!file) return null;
    const rel = path.relative(this.dataDir, path.resolve(file));
    return rel.split(path.sep).join('/');
  }

  /** 新消息 */
  static newMessage(role: 'user' | 'assistant', text: string): SessionMessage {
    return {
      messageId: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
      role,
      text,
      at: new Date().toISOString(),
      status: role === 'user' ? 'complete' : 'streaming',
      toolCalls: [],
      usage: null,
    };
  }
  static newRun(run: Omit<SessionRun, 'runId'> & { runId?: string }): SessionRun {
    return { ...run, runId: run.runId ?? `run_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}` };
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function assertSessionId(sessionId: string): string {
  if (!/^cv_[A-Za-z0-9_]+$/.test(sessionId)) {
    throw new AgentRunError('SESSION_NOT_FOUND', `会话 ID 非法：${sessionId}`);
  }
  return sessionId;
}

function newSessionId(): string {
  return `cv_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/** 结构归一：容忍旧/半截文件，避免重启后整条会话读不出来。 */
function normalizeRecord(input: AgentSessionRecord, sessionId: string): AgentSessionRecord {
  const now = new Date().toISOString();
  const messages: SessionMessage[] = (Array.isArray(input.messages) ? input.messages : []).map((m) => ({
    messageId: typeof m.messageId === 'string' ? m.messageId : `msg_${crypto.randomUUID().slice(0, 8)}`,
    ...(typeof m.runId === 'string' ? { runId: m.runId } : {}),
    role: m.role === 'assistant' ? 'assistant' : 'user',
    text: typeof m.text === 'string' ? m.text : '',
    at: typeof m.at === 'string' ? m.at : now,
    status: m.status === 'streaming' || m.status === 'aborted' || m.status === 'failed' ? m.status : 'complete',
    toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls : [],
    usage: m.usage ?? null,
    ...(m.errorCode ? { errorCode: m.errorCode } : {}),
  }));
  const files: SessionFileRef[] = (Array.isArray(input.files) ? input.files : []).filter(
    (f): f is SessionFileRef => typeof f?.relPath === 'string' && typeof f?.path === 'string',
  );
  const runs: SessionRun[] = Array.isArray(input.runs) ? input.runs : [];
  const status: RunStatus =
    input.status === 'queued' ||
    input.status === 'running' ||
    input.status === 'cancelling' ||
    input.status === 'done' ||
    input.status === 'failed' ||
    input.status === 'cancelled'
      ? input.status
      : 'done';
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId,
    title: typeof input.title === 'string' && input.title.trim() ? input.title : '新对话',
    authorizedDir: typeof input.authorizedDir === 'string' ? input.authorizedDir : '',
    // 旧版评测会话可能持久化为 read-only；载入时统一恢复读写能力。
    toolPolicy: 'read-write',
    workflow:
      input.workflow === 'create' || input.workflow === 'improve' || input.workflow === 'evaluate'
        ? input.workflow
        : null,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : now,
    status,
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    // 只认三档：这条记录被重建时曾漏掉该字段，导致会话级强度每次读取都退回默认档
    thinkingLevel:
      input.thinkingLevel === 'low' || input.thinkingLevel === 'high' || input.thinkingLevel === 'max'
        ? input.thinkingLevel
        : null,
    systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : null,
    draftPrompt: typeof input.draftPrompt === 'string' ? input.draftPrompt : null,
    piSessionFile: typeof input.piSessionFile === 'string' ? input.piSessionFile : null,
    messages,
    files,
    runs,
    error: input.error ?? null,
    resumedAt: typeof input.resumedAt === 'string' ? input.resumedAt : null,
  };
}
