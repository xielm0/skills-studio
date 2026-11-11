/**
 * T14 备份页应用服务：把 T04 的 BackupService 结果翻译成界面契约（shared/ipc.ts 的 sync:*）。
 *
 * 边界（tec.md §5.10、§7.1）：
 *  - 不重写任何 Git 逻辑：Pull/Push/合并/恢复/冲突解决全部调用 BackupService；
 *  - 只补两件界面需要、T04 未覆盖的事：
 *      1) 「最近 Pull / 最近 Push」记录（DATA_DIR/sync-activity.json，不落库、不进备份）；
 *      2) 冲突两侧的修改时间与变更摘要、历史版本的说明与文件级变更。
 *  - 错误转成人读文案（保留结构化码），渲染层只展示 detail，不据此生成路径或命令。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BackupError, type BackupService, type RemoteProbe } from './backup-service';
import { GitError } from '../infra/git';
import type { ConflictChoice, ConflictSideSummary, PendingConflictInfo } from './merge/types';
import type { SkillLibraryService } from './library';
import type {
  SyncCommitResult,
  SyncConflictChoice,
  SyncConflictSideView,
  SyncConflictView,
  SyncHistoryResult,
  SyncLastCommitView,
  SyncOperationView,
  SyncPullResult,
  SyncPushResult,
  SyncResolveRequest,
  SyncResolveResult,
  SyncRestoreResult,
  SyncStatusResult,
  SyncVersionDetailResult,
} from '../shared/ipc';

const ACTIVITY_FILE = 'sync-activity.json';
/** 提交信息里的协议 trailer（不展示给用户）。 */
const TRAILER_RE = /^Skills-Sync-[A-Za-z-]+\s*:/i;

interface ActivityFile {
  schemaVersion: number;
  lastPull: SyncOperationView | null;
  lastPush: SyncOperationView | null;
}

export interface SyncServiceOptions {
  backup: BackupService;
  library: SkillLibraryService;
  dataDir: string;
}

/** IPC 层可直接映射的业务错误：code 为 IPC 错误码，message 是人读文案。 */
export class SyncError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'INTERNAL_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export class SyncService {
  private readonly backup: BackupService;
  private readonly library: SkillLibraryService;
  private readonly dataDir: string;
  /** commit → 提交时间（提交不可变，可安全缓存） */
  private readonly commitTimes = new Map<string, string | null>();

  constructor(opts: SyncServiceOptions) {
    this.backup = opts.backup;
    this.library = opts.library;
    this.dataDir = opts.dataDir;
  }

  // ───────────────────────── 状态 ─────────────────────────

  async status(): Promise<SyncStatusResult> {
    const st = await this.backup.getStatus();
    const activity = this.readActivity();
    const conflicts = await this.conflictViews(this.backup.listConflicts());
    return {
      connected: Boolean(st.remoteUrl),
      gitAvailable: st.gitAvailable,
      remoteUrl: st.remoteUrl,
      branch: st.branch,
      libraryDir: this.backup.libraryDir,
      lastCommit: this.lastCommitView(st.lastCommit),
      lastPull: activity.lastPull,
      lastPush: activity.lastPush,
      pendingConflicts: conflicts,
      notice: this.noticeFor(st.gitAvailable, Boolean(st.remoteUrl), conflicts),
    };
  }

  /** 本地备份：git add -A + commit（不触碰远端；结果就地展示，无后续操作入口）。 */
  async commit(message?: string): Promise<SyncCommitResult> {
    let raw;
    try {
      raw = await this.backup.commit(message ? { message } : {});
    } catch (err) {
      throw this.asSyncError(err);
    }
    return raw.status === 'committed'
      ? { status: 'committed', commitId: raw.commitId, message: `已备份到本地（版本 ${raw.commitId.slice(0, 8)}）` }
      : { status: 'up-to-date', commitId: raw.commitId, message: '没有需要备份的变更。' };
  }

  /** 连接/更改远端：先只读探测（非法地址、认证、网络），通过后再写本机配置。 */
  async connect(url: string): Promise<SyncStatusResult> {
    let probe: RemoteProbe;
    try {
      probe = await this.backup.probeRemote(url);
    } catch (err) {
      throw this.asSyncError(err);
    }
    if (!probe.reachable) {
      throw new SyncError('BAD_REQUEST', probeFailureText(probe));
    }
    await this.backup.configureRemote(url);
    const status = this.status();
    return {
      ...status,
      notice: probe.branchExists
        ? `远端已有备份版本（${probe.head ? probe.head.slice(0, 8) : '已就绪'}），可点击 Pull 拉取到本机。`
        : '已连接空远端。首次 Push 会把本机技能库上传为第一个版本。',
    };
  }

  // ───────────────────────── Pull ─────────────────────────

  async pull(): Promise<SyncPullResult> {
    const before = (await this.backup.getStatus()).headCommit;
    let raw;
    try {
      raw = await this.backup.pull();
    } catch (err) {
      // 远端分支尚不存在时 fetch 会失败（git 不区分「空仓库」与「分支缺失」）：
      // 这属于正常空远端，按「无变化」返回，而不是报错。
      if (
        err instanceof BackupError &&
        err.code === 'GIT_FETCH_FAILED' &&
        /couldn't find remote ref|not found|could not find remote ref/i.test(err.detail)
      ) {
        const message = '远端还没有任何版本，本次没有可拉取的内容。';
        const result: SyncPullResult = {
          status: 'up-to-date',
          message,
          commits: 0,
          adopted: [],
          removed: 0,
          conflicts: await this.conflictViews(this.backup.listConflicts()),
        };
        this.record('lastPull', result.status, message);
        return result;
      }
      throw this.asSyncError(err);
    }
    const commits = raw.commitId ? await this.backup.countCommitsBetween(before, raw.commitId) : 0;
    const pending = await this.conflictViews(this.backup.listConflicts());
    const result = this.buildPullResult(raw, pending, commits);
    this.record('lastPull', result.status, result.message);
    return result;
  }

  /** 应用冲突选择后继续 Pull（同一入口：把远端剩余的变更取完）。 */
  async continuePull(): Promise<SyncPullResult> {
    return this.pull();
  }

  async resolve(request: SyncResolveRequest): Promise<SyncResolveResult> {
    if (!Array.isArray(request?.decisions) || request.decisions.length === 0) {
      throw new SyncError('BAD_REQUEST', '请先为待处理冲突选择处理方式');
    }
    const items: SyncResolveResult['items'] = [];
    for (const decision of request.decisions) {
      const choice = CHOICE_MAP[decision.choice];
      if (!choice) {
        items.push({ conflictId: decision.conflictId, choice: decision.choice, status: 'failed', reason: '未知的处理方式' });
        continue;
      }
      try {
        const resolved = await this.backup.resolveConflict(decision.conflictId, choice);
        items.push({
          conflictId: decision.conflictId,
          choice: decision.choice,
          status: 'resolved',
          newSkillId: resolved.newSkillId,
          newSkillName: resolved.newDirName,
        });
      } catch (err) {
        items.push({
          conflictId: decision.conflictId,
          choice: decision.choice,
          status: 'failed',
          reason: this.asSyncError(err).message,
        });
      }
    }
    const summary = {
      resolved: items.filter((item) => item.status === 'resolved').length,
      failed: items.filter((item) => item.status === 'failed').length,
    };
    return {
      items,
      summary,
      remainingConflicts: await this.conflictViews(this.backup.listConflicts()),
    };
  }

  // ───────────────────────── Push ─────────────────────────

  async push(): Promise<SyncPushResult> {
    let raw;
    try {
      // 版本说明取「技能库 + 技能数」：备份页没有输入说明的入口（ui.md），
      // 但版本历史需要能扫读的说明。
      const skillCount = this.library.listSkills().length;
      raw = await this.backup.push({ message: `备份技能库（${skillCount} 个技能）` });
    } catch (err) {
      throw this.asSyncError(err);
    }
    const excludedSkills = raw.excluded.map((item) => item.dirName);
    const excludedNote =
      excludedSkills.length > 0 ? `（${excludedSkills.length} 个超过 100MB 的技能未纳入备份）` : '';
    let result: SyncPushResult;
    if (raw.status === 'pushed') {
      result = {
        status: 'pushed',
        message: `已 Push 到远端（版本 ${raw.commitId.slice(0, 8)}）${excludedNote}`,
        commitId: raw.commitId,
        excludedSkills,
      };
    } else if (raw.status === 'up-to-date') {
      result = {
        status: 'up-to-date',
        message: `没有需要上传的变更${excludedNote}`,
        commitId: raw.commitId,
        excludedSkills,
      };
    } else {
      result = {
        status: 'rejected',
        message: 'Push 被拒绝：远端有更新的提交，请先 Pull 再 Push（本机变更已提交并保留）',
        reason: raw.reason ?? '远端有更新的提交',
        remoteAhead: raw.hint === 'PULL_REQUIRED',
        commitId: raw.commitId,
        excludedSkills,
      };
    }
    this.record('lastPush', result.status, result.message);
    return result;
  }

  // ───────────────────────── 历史与版本 ─────────────────────────

  async history(): Promise<SyncHistoryResult> {
    const items = (await this.backup.listHistoryBatched({ limit: 100 })).map((commit) => {
      const { note, summary } = splitMessage(commit.message);
      return {
        sha: commit.commitId,
        time: commit.committedAt,
        changedSkills: commit.changedSkills,
        changedSkillCount: commit.changedSkillCount,
        note,
        summary,
        author: commit.author,
      };
    });
    return { items };
  }

  async versionDetail(sha: string): Promise<SyncVersionDetailResult> {
    const summary = await this.backup.getCommitSummary(sha);
    if (!summary) throw new SyncError('BAD_REQUEST', `未找到版本 ${sha.slice(0, 8)}，可能已被清理`);
    const names = new Map(this.library.listSkills().map((skill) => [skill.dirName, skill.name]));
    const changedSkills = await Promise.all(summary.changedSkills.map(async (dirName) => {
      let diff = { added: [] as string[], modified: [] as string[], removed: [] as string[], reportChanged: false };
      try {
        const fileDiff = await this.backup.getCommitSkillDiff(summary.commitId, dirName);
        diff = {
          added: fileDiff.files.added,
          modified: fileDiff.files.modified,
          removed: fileDiff.files.removed,
          reportChanged: fileDiff.reportChanged,
        };
      } catch {
        /* 单个技能的差异读取失败不阻断版本详情 */
      }
      return {
        dirName,
        name: names.get(dirName) ?? null,
        added: diff.added,
        modified: diff.modified,
        removed: diff.removed,
        reportChanged: diff.reportChanged,
      };
    }));
    const { note, summary: body } = splitMessage(summary.message);
    return {
      sha: summary.commitId,
      shortSha: summary.commitId.slice(0, 8),
      time: summary.committedAt,
      author: summary.author,
      note,
      summary: body,
      changedSkills,
      changedFileCount: changedSkills.reduce(
        (total, skill) => total + skill.added.length + skill.modified.length + skill.removed.length,
        0,
      ),
    };
  }

  // ───────────────────────── 恢复 ─────────────────────────

  async restore(sha: string): Promise<SyncRestoreResult> {
    const st = await this.backup.getStatus();
    if (!st.initialized || !st.headCommit) {
      throw new SyncError('BAD_REQUEST', '还没有可恢复的备份版本，请先连接远端并 Pull 或 Push');
    }
    let raw;
    try {
      raw = await this.backup.restore({ commitId: sha });
    } catch (err) {
      throw this.asSyncError(err);
    }
    return {
      status: 'restored',
      sha: raw.from,
      scope: 'library',
      changedSkills: raw.changedSkills,
      snapshotRef: raw.snapshotRef,
      message:
        raw.changedSkills.length > 0
          ? `已恢复到版本 ${raw.from.slice(0, 8)}，更新了 ${raw.changedSkills.length} 个技能`
          : `已恢复到版本 ${raw.from.slice(0, 8)}，库内容与该版本一致`,
    };
  }

  // ═════════════════════════ 内部 ═════════════════════════

  private buildPullResult(
    raw: Awaited<ReturnType<BackupService['pull']>>,
    pending: SyncConflictView[],
    commits: number,
  ): SyncPullResult {
    const base = {
      commits,
      adopted: raw.adopted,
      removed: raw.removed.length,
      conflicts: pending,
    };
    if (raw.status === 'no-remote') {
      return { ...base, status: 'up-to-date', commits: 0, message: '远端还没有任何版本，本次没有可拉取的内容。' };
    }
    if (raw.status === 'up-to-date') {
      return { ...base, status: 'up-to-date', message: '已是最新版本，没有需要拉取的变更。' };
    }
    if (raw.status === 'local-ahead') {
      return {
        ...base,
        status: 'up-to-date',
        commits: 0,
        message: '本机领先远端，本次没有可拉取的内容；可 Push 上传本机变更。',
      };
    }
    if (raw.status === 'initialized') {
      return {
        ...base,
        status: 'pulled',
        message: `已从远端取得 ${raw.adopted.length} 个技能，建立本地备份历史。`,
      };
    }
    if (raw.status === 'fast-forward') {
      const removedNote = base.removed > 0 ? `，随远端删除 ${base.removed} 个` : '';
      return {
        ...base,
        status: 'pulled',
        message: `已拉取 ${commits > 0 ? commits : 1} 个新版本（新增 ${raw.adopted.length} 个技能${removedNote}）。`,
      };
    }
    const removedNote = base.removed > 0 ? `，删除 ${base.removed} 个` : '';
    return {
      ...base,
      status: 'pulled',
      message: `已合并远端变更（新增 ${raw.adopted.length} 个技能${removedNote}）。`,
    };
  }

  private async conflictViews(pins: PendingConflictInfo[]): Promise<SyncConflictView[]> {
    return Promise.all(pins.map(async (pin) => ({
      conflictId: pin.skillId,
      skillId: pin.skillId,
      skillName: pin.local.name ?? pin.remote.name ?? pin.dirName ?? pin.skillId,
      dirName: pin.dirName,
      kind: pin.kind,
      components: pin.components,
      local: await this.sideView(pin.local, pin.pinnedAt),
      remote: await this.sideView(pin.remote, pin.pinnedAt),
      remoteAdvanced: Boolean(pin.remoteAdvancedAt),
    })));
  }

  private async sideView(side: ConflictSideSummary, fallbackTime: string): Promise<SyncConflictSideView> {
    return {
      time: (await this.commitTime(side.commit)) ?? fallbackTime,
      summary: sideText(side),
      files: side.changedFiles,
    };
  }

  private async commitTime(commit: string): Promise<string | null> {
    // 提交不可变：同一提交的时间只查一次（刷新状态时避免重复 spawn git）
    if (this.commitTimes.has(commit)) return this.commitTimes.get(commit) ?? null;
    const time = await this.backup.getCommitTime(commit);
    this.commitTimes.set(commit, time);
    return time;
  }

  private noticeFor(gitAvailable: boolean, connected: boolean, conflicts: SyncConflictView[]): string | null {
    if (!gitAvailable) return '未检测到系统 git，备份与同步不可用；安装 git 后重新打开应用。';
    if (!connected) return '备份的是本机中心库目录。';
    if (conflicts.length > 0) {
      return `有 ${conflicts.length} 条未处理完的冲突记录，请先用 git 命令在本机库目录处理。`;
    }
    return null;
  }

  /** BackupStatus.lastCommit → 界面视图（说明取提交主题首行）。 */
  private lastCommitView(
    info: { commitId: string; shortId: string; committedAt: string; message: string } | null,
  ): SyncLastCommitView | null {
    if (!info) return null;
    return {
      commitId: info.commitId,
      shortSha: info.shortId,
      time: info.committedAt,
      message: splitMessage(info.message).note,
    };
  }

  private readActivity(): ActivityFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.dataDir, ACTIVITY_FILE), 'utf8')) as ActivityFile;
      return {
        schemaVersion: 1,
        lastPull: normalizeOperation(parsed.lastPull),
        lastPush: normalizeOperation(parsed.lastPush),
      };
    } catch {
      return { schemaVersion: 1, lastPull: null, lastPush: null };
    }
  }

  private record(key: 'lastPull' | 'lastPush', status: string, message: string): void {
    const activity = this.readActivity();
    activity[key] = { at: new Date().toISOString(), status, message };
    const file = path.join(this.dataDir, ACTIVITY_FILE);
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(activity, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      // 记录失败不影响同步结果本身（只影响「最近 Pull/Push」展示）
    }
  }

  private asSyncError(err: unknown): SyncError {
    if (err instanceof SyncError) return err;
    if (err instanceof BackupError) return new SyncError(backupErrorCode(err.code), readableBackupError(err));
    if (err instanceof GitError) {
      return new SyncError(backupErrorCode(err.code), readableBackupError(new BackupError(err.code, err.detail, err.diagnostic)));
    }
    return new SyncError('INTERNAL_ERROR', (err as Error)?.message ?? String(err));
  }
}

const CHOICE_MAP: Record<SyncConflictChoice, ConflictChoice | null> = {
  local: 'keep-local',
  remote: 'take-remote',
  both: 'keep-both',
};

/** 备份服务错误码 → 是否参数类（其余统一内部错误，但 detail 仍给人读原因）。 */
function backupErrorCode(code: string): 'BAD_REQUEST' | 'INTERNAL_ERROR' {
  switch (code) {
    case 'GIT_INVALID_URL':
    case 'SYNC_CONFLICTS_PENDING':
    case 'SYNC_CONFLICT_NOT_FOUND':
    case 'GIT_COMMIT_NOT_FOUND':
    case 'GIT_REMOTE_NOT_CONFIGURED':
    case 'SYNC_NOTHING_TO_COMMIT':
    case 'SYNC_NOTHING_TO_RESTORE':
      return 'BAD_REQUEST';
    default:
      return 'INTERNAL_ERROR';
  }
}

function readableBackupError(err: BackupError): string {
  switch (err.code) {
    case 'GIT_NOT_INSTALLED':
      return '未检测到系统 git，备份与同步不可用；请先安装 git 后重试。';
    case 'GIT_AUTH_ERROR':
      return `认证失败：远端拒绝了访问，请检查系统凭据（token 由凭据管理器提供，不写在地址里）。${suffix(err.detail)}`;
    case 'GIT_NETWORK_ERROR':
      return `无法连接远端（网络错误）：${err.detail}`;
    case 'GIT_PUSH_REJECTED':
      return 'Push 被拒绝：远端有更新的提交，请先 Pull 再 Push。';
    case 'GIT_PROTOCOL_MISMATCH':
      return err.detail;
    case 'GIT_INVALID_URL':
      return err.detail;
    default:
      return err.detail || err.message;
  }
}

function suffix(detail: string): string {
  return detail ? `（${detail}）` : '';
}

function probeFailureText(probe: RemoteProbe): string {
  const reason = probe.message ? `（${probe.message}）` : '';
  switch (probe.code) {
    case 'GIT_AUTH_ERROR':
      return `认证失败：远端拒绝了访问，请检查系统凭据${reason}`;
    case 'GIT_NETWORK_ERROR':
      return `无法连接远端：请检查地址与网络${reason}`;
    case 'GIT_INVALID_URL':
      return probe.message ?? 'Git 远端地址不合法';
    default:
      return `远端不可用：请确认地址指向一个 Git 仓库${reason}`;
  }
}

/** 冲突一侧的人读摘要：文件数 + 前三个文件名（评测报告用中文说明）。 */
function sideText(side: ConflictSideSummary): string {
  if (!side.present) return '该侧已删除此技能';
  const files = side.changedFiles.map(friendlyFile);
  if (files.length === 0) return '技能内容无变化（仅元数据/同步设置不同）';
  const shown = files.slice(0, 3).join('、');
  const tail = files.length > 3 ? ' 等' : '';
  return `${files.length} 个文件变更：${shown}${tail}`;
}

function friendlyFile(file: string): string {
  if (file.startsWith('skills/')) {
    const rest = file.slice('skills/'.length);
    const slash = rest.indexOf('/');
    return slash >= 0 ? rest.slice(slash + 1) : rest;
  }
  if (file.startsWith('reports/')) return '评测报告';
  return file;
}

function splitMessage(message: string): { note: string; summary: string } {
  const lines = message.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  const note = firstIndex >= 0 ? lines[firstIndex].trim() : '(无说明)';
  const body = (firstIndex >= 0 ? lines.slice(firstIndex + 1) : [])
    .filter((line) => !TRAILER_RE.test(line.trim()))
    .join('\n')
    .trim();
  return { note, summary: body };
}

function normalizeOperation(value: SyncOperationView | null | undefined): SyncOperationView | null {
  if (!value || typeof value.at !== 'string' || typeof value.message !== 'string') return null;
  return { at: value.at, status: String(value.status ?? ''), message: value.message };
}
