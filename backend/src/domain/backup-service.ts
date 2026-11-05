/**
 * M10 备份、恢复与多设备同步（tec.md §5.10、§6.1；prd.md M10）。
 *
 * 结构：
 *  - 库目录本身就是 Git 工作树；远端是用户自己的 bare/托管仓库（本任务只用隔离的本地 bare 仓库）。
 *  - 所有写操作走 T03 的跨进程文件锁（锁文件在 DATA_DIR，绝不在库内）。
 *  - 远端地址、待决冲突 pin、来源绝对路径映射都存 DATA_DIR，不进库、不含密钥。
 *  - 同步单位是技能：拉取时用对象级三方合并（domain/merge），绝不使用 git 行级合并，
 *    因此 SKILL.md 永远不会出现冲突标记。
 *
 * 提交树的内容规则：
 *  - 包含 skills/、sync/（元数据，2026-11-03 起在库根）、reports/、library.json、.skills-sync/protocol.json；
 *  - 不含 API Key / 模型配置 / 本机绝对路径（元数据里的绝对 origin 在提交前抽到
 *    DATA_DIR/source-origins.json，拉取/恢复后再合并回本机元数据）；
 *  - 超过 100MB 的技能留在库中但不进备份（.git/info/exclude + 从索引移除），可查询排除清单。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WriteLock } from '../infra/write-lock';
import {
  GitError,
  assertGitInstalled,
  classifyGitFailure,
  isGitInstalled,
  runGit,
  runGitOk,
  validateRemoteUrl,
} from '../infra/git';
import { createGitObjectReader } from '../infra/git-objects';
import {
  SKILL_META_SUFFIX,
  listMetaDirNames,
  readSkillMeta,
  skillMetaPath,
  skillsDirJoin,
  type ReadSkillMeta,
} from '../infra/fs-meta';
import { collectLocalSkillRels } from './scanner';
import { hashAndSizeSkillDir } from './content-hash';
import { isLocalAbsolutePath } from './path-guard';
import { generateSkillId, isSkillId } from './skill-id';
import { syncSkillDirectory, writeReportFile } from './merge/materialize';
import { parseReportFile, reportNameResolver, reportStamp, safeReportName } from './agent/workflows/report-store';
import {
  PROTOCOL_TRAILER,
  RESOLVED_TRAILER,
  SYNC_PROTOCOL_FILE,
  SYNC_PROTOCOL_VERSION,
  appCommitMessage,
  parseProtocolFile,
  protocolFileBytes,
} from './merge/protocol';
import { planMerge, metaComparableKey, type PlanMergeInput } from './merge/plan';
import { buildLibrarySnapshot, toPortableMeta, type GitObjectReader } from './merge/snapshot';
import { MergeValidationError, validateMergePlan } from './merge/validate';
import type {
  ConflictChoice,
  LibrarySnapshot,
  MergePlan,
  PendingConflictInfo,
  PlannedSkill,
  PortableSkillMeta,
} from './merge/types';
import type { SkillLibraryService } from './library';
import type { SkillMetadataFile, SkillSourceInfo } from './types';

const REMOTE_TIMEOUT_MS = 300_000;
const BIG_SKILL_THRESHOLD_BYTES = 100 * 1024 * 1024;
const CONFIG_FILE = 'backup-config.json';
const ORIGINS_FILE = 'source-origins.json';
const CONFLICTS_FILE = 'pending-conflicts.json';
const SNAPSHOT_REF_PREFIX = 'refs/skills-sync/snapshots';
const PENDING_REF_PREFIX = 'refs/skills-sync/pending';
/** git 的空树 OID（用于「本机与远端没有共同历史」时的空 base 摘要）。 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 结构化备份/同步错误（CLI 与 UI 共用 code + detail）。 */
export class BackupError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly diagnostic: string = '',
  ) {
    super(`${code}: ${detail}`);
    this.name = 'BackupError';
  }
}

interface BackupConfigFile {
  schemaVersion: number;
  remoteUrl: string | null;
  branch: string;
}

interface OriginsFile {
  schemaVersion: number;
  origins: Record<string, string>;
}

interface PendingConflictsFile {
  schemaVersion: number;
  conflicts: PendingConflictInfo[];
}

export interface BackupServiceOptions {
  library: SkillLibraryService;
  dataDir: string;
  lock: WriteLock;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
}

export interface BackupStatus {
  gitAvailable: boolean;
  initialized: boolean;
  remoteUrl: string | null;
  branch: string;
  headCommit: string | null;
  /** 最近一次本地提交的展示信息（时间 / 短哈希 / 说明）；从未备份为 null */
  lastCommit: LastCommitInfo | null;
  pendingConflictCount: number;
  snapshotCount: number;
}

/** 最近一次本地备份提交（界面展示「最近备份时间 + 版本号」）。 */
export interface LastCommitInfo {
  commitId: string;
  shortId: string;
  committedAt: string;
  message: string;
}

/** 本地备份（git add -A + commit，不触碰远端）的结果。 */
export interface LocalCommitResult {
  status: 'committed' | 'up-to-date';
  commitId: string;
}

export interface ExcludedSkill {
  dirName: string;
  /** 技能相对 skills 根的位置（排除规则与 pathspec 都按它写） */
  relPath: string;
  skillId: string | null;
  sizeBytes: number;
}

export interface CommitSummary {
  commitId: string;
  shortId: string;
  committedAt: string;
  author: string;
  message: string;
  /** 按 skills/ 目录 diff 得到的变更技能目录名 */
  changedSkills: string[];
  changedSkillCount: number;
}

export interface CommitFileDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

export interface CommitSkillDiff {
  commitId: string;
  dirName: string;
  skillId: string | null;
  files: CommitFileDiff;
  reportChanged: boolean;
}

export interface SnapshotInfo {
  ref: string;
  commitId: string;
  kind: string;
  shortId: string;
}

/** 连接前对远端的只读探测结果（不改本机任何状态、不写配置）。 */
export interface RemoteProbe {
  reachable: boolean;
  branchExists: boolean;
  head: string | null;
  /** 失败时的结构化码（GIT_AUTH_ERROR / GIT_NETWORK_ERROR / GIT_LS_REMOTE_FAILED …） */
  code?: string;
  /** 已脱敏的首行 stderr（可直接展示，不含凭据） */
  message?: string;
}

export interface PushResult {
  status: 'pushed' | 'up-to-date' | 'rejected';
  commitId: string;
  snapshotRef: string | null;
  excluded: ExcludedSkill[];
  code?: string;
  hint?: string;
  reason?: string;
}

export interface PullResult {
  status: 'up-to-date' | 'initialized' | 'local-ahead' | 'fast-forward' | 'merged' | 'no-remote';
  commitId: string | null;
  remoteCommit: string | null;
  adopted: string[];
  removed: string[];
  conflicts: PendingConflictInfo[];
  updatedPins: string[];
  reason?: string;
}

export interface RestoreResult {
  status: 'restored';
  scope: 'library' | 'skill';
  from: string;
  snapshotRef: string | null;
  skillId: string | null;
  dirName: string | null;
  changedSkills: string[];
}

export interface ResolveResult {
  status: 'resolved';
  choice: ConflictChoice;
  skillId: string;
  dirName: string | null;
  newSkillId: string | null;
  newDirName: string | null;
  commitId: string;
}

export interface PullOptions {
  /** 仅测试注入：在计划落盘前破坏计划，用于验证「结果树校验失败整体中止」 */
  mergePlanHook?: (
    plan: MergePlan,
    ctx: { baseCommit: string; localCommit: string; remoteCommit: string },
  ) => MergePlan;
}

export class BackupService {
  readonly libraryDir: string;
  private readonly library: SkillLibraryService;
  private readonly dataDir: string;
  private readonly lock: WriteLock;
  private readonly logger: BackupServiceOptions['logger'];

  constructor(opts: BackupServiceOptions) {
    this.library = opts.library;
    this.libraryDir = opts.library.libraryDir;
    this.dataDir = opts.dataDir;
    this.lock = opts.lock;
    this.logger = opts.logger;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  // ───────────────────────── 配置与状态 ─────────────────────────

  getStatus(): BackupStatus {
    const available = isGitInstalled();
    const initialized = available && this.hasRepo();
    let head: string | null = null;
    let snapshotCount = 0;
    let lastCommit: LastCommitInfo | null = null;
    if (initialized) {
      try {
        head = this.head();
        snapshotCount = this.listSnapshots().length;
        lastCommit = this.latestCommitInfo();
      } catch {
        /* 仓库损坏时状态如实降级 */
      }
    }
    const cfg = this.readConfig();
    return {
      gitAvailable: available,
      initialized,
      remoteUrl: cfg.remoteUrl,
      branch: cfg.branch,
      headCommit: head,
      lastCommit,
      pendingConflictCount: this.loadConflicts().length,
      snapshotCount,
    };
  }

  // ───────────────────────── 本地备份 ─────────────────────────

  /**
   * 本地备份：把当前库内容 git add -A + commit（不配置、不触碰远端）。
   * 内容与上一版本一致时返回 up-to-date；库中没有任何内容时抛 SYNC_NOTHING_TO_COMMIT。
   */
  async commit(opts: { message?: string } = {}): Promise<LocalCommitResult> {
    return this.lock.runExclusive('backup-commit', async () => {
      assertGitInstalled();
      this.ensureRepo();
      this.ensureProtocolFile();
      this.assertLocalProtocol();
      await this.library.rescan();
      const before = this.head();
      const { commit } = this.commitWorktree(
        opts.message ?? '本地备份',
        { [PROTOCOL_TRAILER]: String(SYNC_PROTOCOL_VERSION) },
        before ? [before] : [],
      );
      const head = commit ?? before;
      if (!head) throw new BackupError('SYNC_NOTHING_TO_COMMIT', '库中没有可备份的内容');
      return { status: commit ? 'committed' : 'up-to-date', commitId: head };
    });
  }

  /** 配置远端（只写 DATA_DIR；不把地址写进仓库配置，更不写凭据）。 */
  async configureRemote(rawUrl: string): Promise<BackupStatus> {
    return this.lock.runExclusive('backup-configure', async () => {
      assertGitInstalled();
      const url = validateRemoteUrl(rawUrl);
      this.ensureRepo();
      this.writeConfig({ ...this.readConfig(), remoteUrl: url });
      return this.getStatus();
    });
  }

  /** 初始化备份仓库（工作树 = 库目录）。可同时配置远端。 */
  async init(opts: { remoteUrl?: string } = {}): Promise<BackupStatus> {
    return this.lock.runExclusive('backup-init', async () => {
      assertGitInstalled();
      this.ensureRepo();
      this.ensureProtocolFile();
      if (opts.remoteUrl) {
        const url = validateRemoteUrl(opts.remoteUrl);
        this.writeConfig({ ...this.readConfig(), remoteUrl: url });
      }
      return this.getStatus();
    });
  }

  /**
   * 只读探测远端（连接前校验可达性/认证/分支状态）：
   * 不改本机仓库、不写配置，失败时给出可读原因，供备份页「连接」直接提示。
   */
  probeRemote(rawUrl: string): RemoteProbe {
    assertGitInstalled();
    const url = validateRemoteUrl(rawUrl);
    const branch = this.readConfig().branch;
    fs.mkdirSync(this.libraryDir, { recursive: true });
    const res = runGit(['ls-remote', '--heads', url, `refs/heads/${branch}`], {
      cwd: this.libraryDir,
      timeoutMs: REMOTE_TIMEOUT_MS,
      allowFailure: true,
      operation: 'ls-remote',
    });
    if (res.status !== 0) {
      const code = classifyGitFailure(res.stderr, 'ls-remote');
      const firstLine = res.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return { reachable: false, branchExists: false, head: null, code, message: firstLine ?? `git 退出码 ${res.status}` };
    }
    const line = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0];
    if (!line) return { reachable: true, branchExists: false, head: null };
    const oid = line.split(/\s+/)[0];
    const head = /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
    return { reachable: true, branchExists: head !== null, head };
  }

  // ───────────────────────── Push ─────────────────────────

  /**
   * Push：把本机变化提交（带协议 trailer + 快照 ref）后推送。
   * 远端领先 → 返回 rejected（GIT_PUSH_REJECTED / 先 Pull），本机提交与工作树完整保留。
   */
  async push(opts: { message?: string } = {}): Promise<PushResult> {
    return this.lock.runExclusive('sync-push', async () => {
      assertGitInstalled();
      this.ensureRepo();
      this.ensureProtocolFile();
      this.assertLocalProtocol();
      const cfg = this.requireRemote();
      const pending = this.loadConflicts();
      if (pending.length > 0) {
        throw new BackupError('SYNC_CONFLICTS_PENDING', `还有 ${pending.length} 个冲突待处理，请先处理完再 Push`);
      }

      await this.library.rescan();
      const excluded = this.applyExclusions();
      const before = this.head();
      const { commit } = this.commitWorktree(
        opts.message ?? '备份技能库',
        { [PROTOCOL_TRAILER]: String(SYNC_PROTOCOL_VERSION) },
        before ? [before] : [],
      );
      const head = commit ?? before;
      if (!head) throw new BackupError('SYNC_NOTHING_TO_COMMIT', '库中没有可备份的内容');
      const snapshotRef = commit ? this.createSnapshot(commit, 'push') : null;

      // 远端已经与本地一致 → 无需推送（避免把「没有新提交」误报成推送失败/成功）
      const remoteHead = this.remoteHeadOf(cfg.remoteUrl, cfg.branch);
      if (remoteHead === head) {
        return { status: 'up-to-date', commitId: head, snapshotRef, excluded };
      }

      try {
        runGit(['push', cfg.remoteUrl, `refs/heads/${cfg.branch}:refs/heads/${cfg.branch}`], {
          cwd: this.libraryDir,
          timeoutMs: REMOTE_TIMEOUT_MS,
          operation: 'push',
        });
      } catch (err) {
        if (err instanceof GitError && err.code === 'GIT_PUSH_REJECTED') {
          return {
            status: 'rejected',
            commitId: head,
            snapshotRef,
            excluded,
            code: 'GIT_PUSH_REJECTED',
            hint: 'PULL_REQUIRED',
            reason: '远端有更新的提交，请先 Pull 再 Push（本机变更已提交并保留）',
          };
        }
        throw this.toBackupError(err);
      }

      return { status: 'pushed', commitId: head, snapshotRef, excluded };
    });
  }

  // ───────────────────────── Pull ─────────────────────────

  /**
   * Pull：fetch → 协议校验 → 快进或对象级三方合并。
   * 合并结果不自动部署（只写库内意图）；冲突进待处理区，绝不静默覆盖。
   */
  async pull(opts: PullOptions = {}): Promise<PullResult> {
    return this.lock.runExclusive('sync-pull', async () => {
      assertGitInstalled();
      this.ensureRepo();
      this.ensureProtocolFile();
      this.assertLocalProtocol();
      const cfg = this.requireRemote();
      // 0) 旧的待决冲突记录：界面已不提供冲突处理，必须先用 git 命令处理干净（零网络副作用）
      const pendingBefore = this.loadConflicts();
      if (pendingBefore.length > 0) {
        throw new BackupError(
          'SYNC_CONFLICTS_PENDING',
          `存在 ${pendingBefore.length} 条未处理完的冲突记录，请先用 git 命令在本机库目录处理后再 Pull（${this.libraryDir}）`,
        );
      }
      const reader = createGitObjectReader(this.libraryDir);

      // 1) 先取远端：协议不兼容时不做任何本机提交（零改动）
      try {
        runGit(
          ['fetch', '--no-tags', cfg.remoteUrl, `+refs/heads/${cfg.branch}:refs/remotes/origin/${cfg.branch}`],
          { cwd: this.libraryDir, timeoutMs: REMOTE_TIMEOUT_MS, operation: 'fetch' },
        );
      } catch (err) {
        throw this.toBackupError(err);
      }
      const remoteHead = this.revParse(`refs/remotes/origin/${cfg.branch}`);
      if (!remoteHead) {
        return {
          status: 'no-remote',
          commitId: this.head(),
          remoteCommit: null,
          adopted: [],
          removed: [],
          conflicts: this.loadConflicts(),
          updatedPins: [],
          reason: '远端分支尚不存在（还没有人 Push 过）',
        };
      }

      // 2) 提交协议标记：版本不匹配直接中止并说明，不猜
      const protocolRaw = reader.readFileAt(remoteHead, SYNC_PROTOCOL_FILE);
      const remoteProtocol = protocolRaw ? parseProtocolFile(protocolRaw.toString('utf8')) : null;
      if (!remoteProtocol || remoteProtocol.protocolVersion !== SYNC_PROTOCOL_VERSION) {
        throw new BackupError(
          'GIT_PROTOCOL_MISMATCH',
          `远端备份协议版本为 ${remoteProtocol?.protocolVersion ?? '未知'}，当前应用仅支持 ${SYNC_PROTOCOL_VERSION}；已中止 Pull，本机零改动`,
        );
      }

      // 3) 空库 bootstrap：本机没有任何技能时直接采纳远端（不制造额外的合并历史）
      await this.library.rescan();
      const localSkillCount = this.library.listSkills().length;
      const headBefore = this.head();
      if (!headBefore && localSkillCount === 0) {
        const beforeIds = this.skillIdSet();
        this.updateBranch(remoteHead);
        this.applyTree(remoteHead);
        this.restoreLocalOrigins();
        await this.library.rescan();
        this.emitImportedForNew(beforeIds, '从远端备份获得');
        return {
          status: 'initialized',
          commitId: remoteHead,
          remoteCommit: remoteHead,
          adopted: this.diffSkillIds(beforeIds),
          removed: [],
          conflicts: [],
          updatedPins: [],
        };
      }

      // 4) 保存本机变更（未提交过则形成首个提交，保证本机历史不丢）
      this.commitWorktree(
        'Pull 前保存本机变更',
        { [PROTOCOL_TRAILER]: String(SYNC_PROTOCOL_VERSION) },
        headBefore ? [headBefore] : [],
        { force: !headBefore },
      );
      const localHead = this.head();
      if (!localHead) throw new BackupError('SYNC_NOTHING_TO_RESTORE', '本机库为空，无法开始 Pull');

      if (remoteHead === localHead) {
        return {
          status: 'up-to-date',
          commitId: localHead,
          remoteCommit: remoteHead,
          adopted: [],
          removed: [],
          conflicts: this.loadConflicts(),
          updatedPins: [],
        };
      }

      if (this.isAncestor(remoteHead, localHead)) {
        return {
          status: 'local-ahead',
          commitId: localHead,
          remoteCommit: remoteHead,
          adopted: [],
          removed: [],
          conflicts: [],
          updatedPins: [],
        };
      }

      if (this.isAncestor(localHead, remoteHead)) {
        const beforeIds = this.skillIdSet();
        const beforeHashes = this.hashAllSkills();
        this.updateBranch(remoteHead);
        this.applyTree(remoteHead);
        this.restoreLocalOrigins();
        await this.library.rescan();
        this.emitChangedSince(beforeHashes, 'Pull 更新');
        this.emitImportedForNew(beforeIds, '从远端备份获得');
        return {
          status: 'fast-forward',
          commitId: remoteHead,
          remoteCommit: remoteHead,
          adopted: this.diffSkillIds(beforeIds),
          removed: [],
          conflicts: [],
          updatedPins: [],
        };
      }

      // 4) 分叉（或本机无共同历史）：对象级三方合并（无 pin：冲突一律整次失败）
      const baseCommit = this.mergeBaseOrEmpty(localHead, remoteHead);
      const baseSnap: LibrarySnapshot = baseCommit
        ? buildLibrarySnapshot(reader, baseCommit)
        : { commit: null, skills: {} };
      const localSnap = buildLibrarySnapshot(reader, localHead);
      const remoteSnap = buildLibrarySnapshot(reader, remoteHead);

      let plan = planMerge({
        base: baseSnap,
        local: localSnap,
        remote: remoteSnap,
        pinnedSkillIds: [],
      } satisfies PlanMergeInput);
      validateMergePlan(plan);

      if (opts.mergePlanHook) {
        plan = opts.mergePlanHook(plan, { baseCommit, localCommit: localHead, remoteCommit: remoteHead });
        validateMergePlan(plan);
      }

      // 5) 双向都改过的技能：整次 Pull 失败、零落地（尚未写盘，本机保持原样），由用户用 git 命令处理
      if (plan.conflicts.length > 0) {
        const names = plan.conflicts
          .map((c) => c.localDirName ?? c.remoteDirName ?? c.skillId)
          .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        throw new BackupError(
          'SYNC_CONFLICTS',
          `以下 ${names.length} 个技能在本机与远端都有改动，本次 Pull 已中止、未修改任何内容：${names.join('、')}。请用 git 命令在本机库目录自行处理（${this.libraryDir}）`,
        );
      }

      const beforeIds = this.skillIdSet();
      const beforeHashes = this.hashAllSkills();
      try {
        this.materializePlan(plan, reader);
        this.restoreLocalOrigins();
        await this.library.rescan();
      } catch (err) {
        // 结果落盘失败：整体回滚到合并前的提交，工作树与索引零改动
        this.rollbackWorktree(localHead);
        await this.library.rescan();
        throw this.toBackupError(err);
      }

      try {
        const res = this.commitWorktree(
          `Pull 合并远端变更（base ${(baseCommit || 'empty').slice(0, 8)}）`,
          { [PROTOCOL_TRAILER]: String(SYNC_PROTOCOL_VERSION) },
          [localHead, remoteHead],
          { force: true },
        );
        if (!res.commit) throw new BackupError('SYNC_MERGE_COMMIT_FAILED', '合并提交创建失败');
      } catch (err) {
        this.rollbackWorktree(localHead);
        await this.library.rescan();
        throw this.toBackupError(err);
      }

      this.emitChangedSince(beforeHashes, 'Pull 合并');
      this.emitImportedForNew(beforeIds, '从远端备份获得');

      return {
        status: 'merged',
        commitId: this.head(),
        remoteCommit: remoteHead,
        adopted: plan.adoptedFromRemote,
        removed: plan.removed,
        conflicts: [],
        updatedPins: [],
      };
    });
  }

  // ───────────────────────── 历史与差异 ─────────────────────────

  listHistory(opts: { limit?: number } = {}): CommitSummary[] {
    if (!this.hasRepo() || !this.head()) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const out = runGit(['log', `-n${limit}`, '--pretty=format:%H%x1f%aI%x1f%an%x1f%B%x1e'], {
      cwd: this.libraryDir,
      allowFailure: true,
      operation: 'log',
    }).stdout;
    const commits: CommitSummary[] = [];
    for (const record of out.split('\x1e')) {
      const trimmed = record.replace(/^\r?\n/, '');
      if (!trimmed.trim()) continue;
      const [commitId, committedAt, author, ...rest] = trimmed.split('\x1f');
      const message = rest.join('\x1f').trim();
      const changedSkills = this.changedSkillsOf(commitId);
      commits.push({
        commitId,
        shortId: commitId.slice(0, 8),
        committedAt,
        author,
        message,
        changedSkills,
        changedSkillCount: changedSkills.length,
      });
    }
    return commits;
  }

  /**
   * 只读：历史摘要（单次 `git log --name-only` 批量算出变更技能）。
   * 与 listHistory 结果同形，但避免逐提交 spawn 一个 `git diff`——
   * Windows 上每次子进程约 100~200ms，历史一长会把备份页拖到几秒。
   */
  listHistoryBatched(opts: { limit?: number } = {}): CommitSummary[] {
    if (!this.hasRepo() || !this.head()) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    // \x1e 分隔提交，\x1f 分隔字段，\x02 结束头部（其后为 --name-only 的文件清单）
    const out = runGit(
      ['log', `-n${limit}`, '--name-only', '--no-renames', '--pretty=format:%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%b%x02'],
      { cwd: this.libraryDir, allowFailure: true, operation: 'log' },
    ).stdout;
    const commits: CommitSummary[] = [];
    for (const record of out.split('\x1e')) {
      if (!record.trim()) continue;
      const [meta, fileBlock = ''] = record.split('\x02');
      const [commitId, committedAt, author, subject, ...body] = meta.split('\x1f');
      if (!commitId || !committedAt) continue;
      const message = [subject?.trim() ?? '', body.join('\x1f').trim()].filter(Boolean).join('\n');
      const changedSkills = [
        ...this.dirNamesFromTreePaths(fileBlock.split(/\r?\n/).map((raw) => raw.trim())),
      ].sort();
      commits.push({
        commitId,
        shortId: commitId.slice(0, 8),
        committedAt,
        author: author ?? '',
        message,
        changedSkills,
        changedSkillCount: changedSkills.length,
      });
    }
    return commits;
  }

  /** 只读：单个提交的时间（冲突两侧的修改时间；不计算变更技能，避免多余子进程）。 */
  getCommitTime(commitId: string): string | null {
    const commit = this.resolveCommit(commitId);
    if (!commit) return null;
    const out = runGit(['log', '-n1', '--pretty=format:%aI', commit], {
      cwd: this.libraryDir,
      allowFailure: true,
      operation: 'log',
    }).stdout.trim();
    return out.length > 0 ? out : null;
  }

  /** 只读：单个提交的摘要（版本详情的说明/时间；冲突两侧的修改时间）。 */
  getCommitSummary(commitId: string): CommitSummary | null {
    const commit = this.resolveCommit(commitId);
    if (!commit) return null;
    const out = runGit(['log', '-n1', '--pretty=format:%H%x1f%aI%x1f%an%x1f%B', commit], {
      cwd: this.libraryDir,
      allowFailure: true,
      operation: 'log',
    }).stdout;
    if (!out.trim()) return null;
    const [id, committedAt, author, ...rest] = out.split('\x1f');
    if (!id || !committedAt) return null;
    const changedSkills = this.changedSkillsOf(commit);
    return {
      commitId: id,
      shortId: id.slice(0, 8),
      committedAt,
      author: author ?? '',
      message: rest.join('\x1f').trim(),
      changedSkills,
      changedSkillCount: changedSkills.length,
    };
  }

  /** 只读：`from`（不含）..`to`（含）之间的提交数；用于 Pull 结果里的「N 个新版本」。 */
  countCommitsBetween(from: string | null, to: string): number {
    const target = this.resolveCommit(to);
    if (!target) return 0;
    const args = from
      ? ['rev-list', '--count', `${from}..${target}`]
      : ['rev-list', '--count', target];
    const res = runGit(args, { cwd: this.libraryDir, allowFailure: true, operation: 'rev-list' });
    const count = Number(res.stdout.trim());
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  /** 某次提交对某技能的差异（文件级 changed/added/removed 摘要）。 */
  getCommitSkillDiff(commitId: string, dirName: string): CommitSkillDiff {    const commit = this.resolveCommit(commitId);
    if (!commit) throw new BackupError('GIT_COMMIT_NOT_FOUND', `未找到提交 ${commitId}`);
    const reader = createGitObjectReader(this.libraryDir);
    // 提交树元数据按布局演进逐层回退：sync/（2026-11-03 起）→ skills/.meta/（2026-11-02）→ 平铺 skills/
    const metaAt = `sync/${dirName}${SKILL_META_SUFFIX}`;
    const metaAtInDotMeta = `skills/.meta/${dirName}${SKILL_META_SUFFIX}`;
    const legacyMetaAt = `skills/${dirName}${SKILL_META_SUFFIX}`;
    const metaRaw =
      reader.readFileAt(commit, metaAt) ??
      reader.readFileAt(commit, metaAtInDotMeta) ??
      reader.readFileAt(commit, legacyMetaAt);
    let skillId: string | null = null;
    let reportStem: string | null = null;
    if (metaRaw) {
      try {
        const parsed = JSON.parse(metaRaw.toString('utf8')) as { skillId?: string; name?: string };
        if (typeof parsed.skillId === 'string' && isSkillId(parsed.skillId)) {
          skillId = parsed.skillId;
          reportStem = safeReportName(
            typeof parsed.name === 'string' && parsed.name ? parsed.name : dirName,
            parsed.skillId,
          );
        }
      } catch {
        skillId = null;
      }
    }
    const contentRel = readSkillMeta(this.library.skillsDir, dirName)?.relPath ?? dirName;
    const paths = [`skills/${contentRel}`, metaAt, legacyMetaAt];
    const reportPrefix = reportStem ? `reports/${reportStem}_review_` : null;
    if (reportPrefix) paths.push('reports');
    const raw = this.diffFiles(this.parentOf(commit), commit, paths);
    // reports 按整目录 diff 后再筛出本技能的那一份
    const owned = (file: string) => !file.startsWith('reports/') || (reportPrefix != null && file.startsWith(reportPrefix));
    const files = {
      added: raw.added.filter(owned),
      modified: raw.modified.filter(owned),
      removed: raw.removed.filter(owned),
    };
    return {
      commitId: commit,
      dirName,
      skillId,
      files,
      reportChanged:
        reportPrefix != null &&
        [...files.added, ...files.modified, ...files.removed].some((p) => p.startsWith(reportPrefix)),
    };
  }

  /** 本地快照 ref（每次 Push 与恢复/解决冲突前各一条；恢复可回退的依据）。 */
  listSnapshots(): SnapshotInfo[] {
    if (!this.hasRepo()) return [];
    const out = runGit(['for-each-ref', '--format=%(refname)%1f%(objectname)', SNAPSHOT_REF_PREFIX], {
      cwd: this.libraryDir,
      allowFailure: true,
      operation: 'for-each-ref',
    }).stdout;
    const rows: SnapshotInfo[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [ref, commitId] = line.split('\x1f');
      if (!ref || !commitId) continue;
      const tail = ref.slice(SNAPSHOT_REF_PREFIX.length + 1);
      // 形如 20261025-213000-push-abcd1234（kind 里可能含技能 ID）
      const kind = tail.replace(/^\d{8}-\d{6}-/, '').replace(/-[0-9a-f]{8}(-\d+)?$/, '');
      rows.push({ ref, commitId, kind, shortId: commitId.slice(0, 8) });
    }
    return rows.reverse();
  }

  /** 被排除出备份的大技能清单（>100MB，库内保留）。 */
  listExcludedSkills(): ExcludedSkill[] {
    return this.computeExcludedSkills();
  }

  // ───────────────────────── 恢复 ─────────────────────────

  /**
   * 恢复到某次提交。恢复前先把当前状态打成新快照（可回退），恢复本身也形成一次提交
   * （历史保留，可再次找回恢复前的状态）。
   * - 整库恢复：工作树回到该提交；
   * - 单技能恢复：只回滚该技能的技能文件与评测报告，保留元数据（Group/来源/同步配置），
   *   因此完全不触碰部署关系（链接仍在原路径，内容随之变化）。
   */
  async restore(opts: { commitId: string; skillId?: string }): Promise<RestoreResult> {
    return this.lock.runExclusive('sync-restore', async () => {
      assertGitInstalled();
      this.ensureRepo();
      this.ensureProtocolFile();
      this.assertLocalProtocol();
      const target = this.resolveCommit(opts.commitId);
      if (!target) throw new BackupError('GIT_COMMIT_NOT_FOUND', `未找到提交 ${opts.commitId}`);
      const reader = createGitObjectReader(this.libraryDir);

      await this.library.rescan();
      const head = this.head();
      const { commit: pre } = this.commitWorktree(
        '恢复前快照',
        { [PROTOCOL_TRAILER]: String(SYNC_PROTOCOL_VERSION) },
        head ? [head] : [],
        { force: true },
      );
      const preCommit = pre ?? head;
      if (!preCommit) throw new BackupError('SYNC_NOTHING_TO_RESTORE', '库中没有可恢复的内容');
      const snapshotRef = this.createSnapshot(preCommit, 'pre-restore');

      if (opts.skillId) {
        const skillId = opts.skillId;
        const snapshot = buildLibrarySnapshot(reader, target);
        const targetSkill = snapshot.skills[skillId];
        if (!targetSkill) {
          throw new BackupError(
            'RESTORE_SKILL_NOT_IN_COMMIT',
            `该技能不在提交 ${target.slice(0, 8)} 中，未做任何改动`,
          );
        }
        const current = this.findCurrentMeta(skillId);
        if (!current) {
          throw new BackupError('RESTORE_SKILL_NOT_IN_LIBRARY', '中心库中找不到该技能，未做任何改动');
        }
        const dir = skillsDirJoin(this.library.skillsDir, current.relPath);
        const beforeHash = this.hashDirOrNull(dir);
        if (targetSkill.contentTree) {
          syncSkillDirectory(dir, reader.listTree(targetSkill.contentTree), (oid) => reader.readBlob(oid));
        } else if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        this.applyReportFile(targetSkill, skillId, reader);
        await this.library.rescan();
        const afterHash = this.hashDirOrNull(dir);
        if (beforeHash !== afterHash) {
          this.library.appendEvent(skillId, 'content-changed', `恢复：${current.dirName}`);
        }
        this.commitWorktree(
          `恢复技能：${current.dirName} 到 ${target.slice(0, 8)}`,
          { [PROTOCOL_TRAILER]: String(SYNC_PROTOCOL_VERSION) },
          [preCommit],
          { force: true },
        );
        return {
          status: 'restored',
          scope: 'skill',
          from: target,
          snapshotRef,
          skillId,
          dirName: current.dirName,
          changedSkills: beforeHash !== afterHash ? [current.dirName] : [],
        };
      }

      const beforeHashes = this.hashAllSkills();
      try {
        this.applyTree(target);
        this.restoreLocalOrigins();
        await this.library.rescan();
        this.assertLibraryConsistent(); // 恢复后校验：技能目录 ↔ 元数据 1:1
      } catch (err) {
        this.rollbackWorktree(preCommit);
        await this.library.rescan();
        throw this.toBackupError(err);
      }
      const afterHashes = this.hashAllSkills();
      const changedSkills = [...new Set([...beforeHashes.keys(), ...afterHashes.keys()])]
        .filter((dirName) => beforeHashes.get(dirName) !== afterHashes.get(dirName))
        .sort();
      this.emitChangedSince(beforeHashes, '恢复');

      this.commitWorktree(
        `恢复整库到 ${target.slice(0, 8)}`,
        { [PROTOCOL_TRAILER]: String(SYNC_PROTOCOL_VERSION) },
        [preCommit],
        { force: true },
      );

      return {
        status: 'restored',
        scope: 'library',
        from: target,
        snapshotRef,
        skillId: null,
        dirName: null,
        changedSkills,
      };
    });
  }

  // ───────────────────────── 冲突 ─────────────────────────

  listConflicts(): PendingConflictInfo[] {
    return this.loadConflicts();
  }

  /**
   * 解决单个冲突：keep-local（保留本机）/ take-remote（采用远端）/ keep-both（两份都保留）。
   * keep-both 会用新的稳定 Skill ID 保存远端版本，目录名冲突安全处理，评测报告一并换新 ID。
   * 三种选择都会先打一个可回退快照，且不会静默覆盖（提交信息带 Resolved trailer）。
   */
  async resolveConflict(skillId: string, choice: ConflictChoice): Promise<ResolveResult> {
    return this.lock.runExclusive('sync-resolve', async () => {
      assertGitInstalled();
      this.ensureRepo();
      this.ensureProtocolFile();
      this.assertLocalProtocol();
      if (!isSkillId(skillId)) throw new BackupError('SYNC_CONFLICT_NOT_FOUND', `Skill ID 非法：${skillId}`);
      const conflicts = this.loadConflicts();
      const pin = conflicts.find((c) => c.skillId === skillId);
      if (!pin) throw new BackupError('SYNC_CONFLICT_NOT_FOUND', `没有待处理的冲突：${skillId}`);

      await this.library.rescan();
      const head = this.head();
      if (!head) throw new BackupError('SYNC_NOTHING_TO_RESTORE', '库中没有可提交的内容');
      this.createSnapshot(head, `pre-resolve-${skillId.slice(0, 10)}`);

      const reader = createGitObjectReader(this.libraryDir);
      const remoteSnap = buildLibrarySnapshot(reader, pin.remoteCommit);
      const remoteSkill = remoteSnap.skills[skillId] ?? null;
      const current = this.findCurrentMeta(skillId);
      const now = new Date().toISOString();

      let newSkillId: string | null = null;
      let newDirName: string | null = null;
      let resultDirName = current?.dirName ?? pin.dirName;

      if (choice === 'take-remote') {
        if (!remoteSkill) {
          throw new BackupError('SYNC_CONFLICT_NOT_FOUND', '远端已经删除了该技能，无法「采用远端」；请选择保留本机');
        }
        const dirName = this.availableDirName(remoteSkill.meta.dirName, skillId);
        resultDirName = dirName;
        // 本机已有该技能且未改名 → 沿用其现有位置（可能是手动分组后的一层子目录）；否则平铺
        const relPath = current && current.dirName === dirName ? current.relPath : dirName;
        const targetDir = skillsDirJoin(this.library.skillsDir, relPath);
        if (current && current.dirName !== dirName) {
          fs.rmSync(skillsDirJoin(this.library.skillsDir, current.relPath), { recursive: true, force: true });
          fs.rmSync(skillMetaPath(this.library.skillsDir, current.dirName), { force: true });
        }
        if (remoteSkill.contentTree) {
          syncSkillDirectory(targetDir, reader.listTree(remoteSkill.contentTree), (oid) => reader.readBlob(oid));
        } else if (fs.existsSync(targetDir)) {
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
        this.writeSkillMetaFromPlan(
          {
            skillId,
            meta: { ...remoteSkill.meta, dirName },
            contentTree: remoteSkill.contentTree,
            reportBlob: remoteSkill.reportBlob,
            reportFile: remoteSkill.reportFile,
            from: 'remote',
            renamedForCollision: false,
          },
          current?.addedAt ?? now,
          now,
          relPath,
        );
        this.applyReportFile(remoteSkill, skillId, reader);
      } else if (choice === 'keep-both') {
        if (!remoteSkill) {
          throw new BackupError('SYNC_CONFLICT_NOT_FOUND', '远端已经删除了该技能，没有第二份可保留');
        }
        newSkillId = generateSkillId();
        newDirName = this.availableDirName(remoteSkill.meta.dirName, newSkillId);
        const targetDir = path.join(this.library.skillsDir, newDirName);
        // 保留两边：新技能与原技能同名，报告按目录名另存一份，避免两边共用同一个文件
        const keptReportFile = remoteSkill.reportBlob
          ? `reports/${safeReportName(newDirName, newSkillId)}_review_${reportStamp()}.md`
          : null;
        if (remoteSkill.contentTree) {
          syncSkillDirectory(targetDir, reader.listTree(remoteSkill.contentTree), (oid) => reader.readBlob(oid));
        }
        this.writeSkillMetaFromPlan(
          {
            skillId: newSkillId,
            meta: { ...remoteSkill.meta, dirName: newDirName },
            contentTree: remoteSkill.contentTree,
            reportBlob: remoteSkill.reportBlob,
            reportFile: keptReportFile,
            from: 'remote',
            renamedForCollision: false,
          },
          now,
          now,
          newDirName,
        );
        this.applyReportFile(
          { ...remoteSkill, meta: { ...remoteSkill.meta, name: newDirName }, reportFile: keptReportFile },
          newSkillId,
          reader,
        );
      }

      await this.library.rescan();
      const label = choice === 'keep-local' ? '保留本机' : choice === 'take-remote' ? '采用远端' : '两份都保留';
      const { commit } = this.commitWorktree(
        `解决冲突：${pin.dirName ?? skillId}（${label}）`,
        {
          [PROTOCOL_TRAILER]: String(SYNC_PROTOCOL_VERSION),
          [RESOLVED_TRAILER]: skillId,
        },
        [head],
        { force: true },
      );
      const commitId = commit ?? head;

      this.writeConflicts(conflicts.filter((c) => c.skillId !== skillId));
      this.deleteRef(`${PENDING_REF_PREFIX}/${skillId}`);
      if (newSkillId) this.library.appendEvent(newSkillId, 'imported', `冲突解决：保留远端版本为新 Skill（${label}）`);

      return {
        status: 'resolved',
        choice,
        skillId,
        dirName: resultDirName ?? null,
        newSkillId,
        newDirName,
        commitId,
      };
    });
  }

  // ═════════════════════════ Git 基础操作 ═════════════════════════

  /** 最近一次本地提交的展示信息（单条 git log，不做变更统计；空仓库返回 null）。 */
  private latestCommitInfo(): LastCommitInfo | null {
    const out = runGit(
      ['log', '-n1', '--pretty=format:%H%x1f%cI%x1f%s'],
      { cwd: this.libraryDir, allowFailure: true, operation: 'log' },
    ).stdout;
    const line = out.split(/\r?\n/).find((part) => part.trim().length > 0);
    if (!line) return null;
    const [commitId, committedAt, ...rest] = line.split('\x1f');
    if (!commitId || !committedAt) return null;
    return {
      commitId,
      // 与版本历史同口径：固定 8 位（git log %h 为自适应长度，不能直接用）
      shortId: commitId.slice(0, 8),
      committedAt,
      message: rest.join('\x1f').trim(),
    };
  }

  private hasRepo(): boolean {
    if (!fs.existsSync(path.join(this.libraryDir, '.git'))) return false;
    const res = runGit(['rev-parse', '--git-dir'], {
      cwd: this.libraryDir,
      allowFailure: true,
      operation: 'rev-parse',
    });
    return res.status === 0;
  }

  private ensureRepo(): void {
    fs.mkdirSync(this.libraryDir, { recursive: true });
    if (this.hasRepo()) return;
    runGit(['init', '-b', 'main'], { cwd: this.libraryDir, operation: 'init' });
    // 跨机同步必须保持字节原样：关闭换行转换，允许长路径
    runGit(['config', 'core.autocrlf', 'false'], { cwd: this.libraryDir, operation: 'config' });
    runGit(['config', 'core.safecrlf', 'false'], { cwd: this.libraryDir, operation: 'config' });
    runGit(['config', 'core.longpaths', 'true'], { cwd: this.libraryDir, operation: 'config' });
    runGit(['config', 'core.quotepath', 'false'], { cwd: this.libraryDir, operation: 'config' });
    const email = runGit(['config', 'user.email'], {
      cwd: this.libraryDir,
      allowFailure: true,
      operation: 'config',
    }).stdout.trim();
    if (!email) {
      runGit(['config', 'user.name', 'Skills Studio'], { cwd: this.libraryDir, operation: 'config' });
      runGit(['config', 'user.email', 'skills-studio@localhost'], { cwd: this.libraryDir, operation: 'config' });
    }
    this.logger?.info('backup:repo-initialized', { libraryDir: this.libraryDir });
  }

  private head(): string | null {
    return this.revParse('HEAD');
  }

  private revParse(rev: string): string | null {
    const res = runGit(['rev-parse', '--verify', '--quiet', rev], {
      cwd: this.libraryDir,
      allowFailure: true,
      operation: 'rev-parse',
    });
    const out = res.stdout.trim();
    return res.status === 0 && /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  }

  private resolveCommit(rev: string): string | null {
    if (!rev || rev.startsWith('-')) return null;
    return this.revParse(`${rev}^{commit}`);
  }

  /** 远端分支当前指向（ls-remote 只读；远端不可达时返回 null，交给随后的 push/fetch 报错）。 */
  private remoteHeadOf(url: string, branch: string): string | null {
    const res = runGit(['ls-remote', '--heads', url, `refs/heads/${branch}`], {
      cwd: this.libraryDir,
      timeoutMs: REMOTE_TIMEOUT_MS,
      allowFailure: true,
      operation: 'ls-remote',
    });
    if (res.status !== 0) return null;
    const line = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    if (!line) return null;
    const oid = line.split(/\s+/)[0];
    return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
  }

  private parentOf(commit: string): string | null {
    return this.revParse(`${commit}^`);
  }

  private isAncestor(maybeAncestor: string, descendant: string): boolean {
    return (
      runGit(['merge-base', '--is-ancestor', maybeAncestor, descendant], {
        cwd: this.libraryDir,
        allowFailure: true,
        operation: 'merge-base',
      }).status === 0
    );
  }

  /** 共同祖先；无共同历史时返回 ''（按空库为 base 合并）。 */
  private mergeBaseOrEmpty(a: string, b: string): string {
    const res = runGit(['merge-base', a, b], {
      cwd: this.libraryDir,
      allowFailure: true,
      operation: 'merge-base',
    });
    const out = res.stdout.trim();
    return res.status === 0 && out ? out : '';
  }

  private assertLocalProtocol(): void {
    const file = path.join(this.libraryDir, SYNC_PROTOCOL_FILE);
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      raw = null;
    }
    const parsed = raw ? parseProtocolFile(raw) : null;
    if (!parsed || parsed.protocolVersion !== SYNC_PROTOCOL_VERSION) {
      throw new BackupError(
        'GIT_PROTOCOL_MISMATCH',
        `本机备份协议版本为 ${parsed?.protocolVersion ?? '缺失'}，当前应用仅支持 ${SYNC_PROTOCOL_VERSION}`,
      );
    }
  }

  /** 写协议标记文件（sticky：已有更高版本时不降级，交由 assertLocalProtocol 报错）。 */
  private ensureProtocolFile(): void {
    const file = path.join(this.libraryDir, SYNC_PROTOCOL_FILE);
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      existing = null;
    }
    const parsed = existing ? parseProtocolFile(existing) : null;
    if (parsed && parsed.protocolVersion >= SYNC_PROTOCOL_VERSION) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, protocolFileBytes(SYNC_PROTOCOL_VERSION), 'utf8');
  }

  private requireRemote(): BackupConfigFile & { remoteUrl: string } {
    const cfg = this.readConfig();
    if (!cfg.remoteUrl) {
      throw new BackupError('GIT_REMOTE_NOT_CONFIGURED', '尚未配置 Git 远端，请先在备份页填写远端地址');
    }
    return cfg as BackupConfigFile & { remoteUrl: string };
  }

  /**
   * 把工作树提交成一次应用提交（协议 trailer 由调用方给出）。
   * 提交前统一：排除大技能 → `git add -A` → 把元数据里的本机绝对路径换成可移植形态。
   */
  private commitWorktree(
    message: string,
    trailers: Record<string, string>,
    parents: string[],
    opts: { force?: boolean } = {},
  ): { commit: string | null; tree: string } {
    this.applyExclusions();
    runGit(['add', '-A', '--', '.'], { cwd: this.libraryDir, operation: 'add' });
    this.stagePortableMetadata();
    const tree = runGitOk(['write-tree'], { cwd: this.libraryDir, operation: 'write-tree' });

    if (!opts.force && parents.length === 1) {
      const parentTree = runGitOk(['rev-parse', `${parents[0]}^{tree}`], {
        cwd: this.libraryDir,
        operation: 'rev-parse',
      });
      if (parentTree === tree) return { commit: null, tree };
    }

    const args = ['commit-tree', tree];
    for (const parent of parents) args.push('-p', parent);
    args.push('-m', appCommitMessage(message, trailers));
    const commit = runGitOk(args, { cwd: this.libraryDir, operation: 'commit-tree' });
    this.updateBranch(commit);
    return { commit, tree };
  }

  private updateBranch(commit: string): void {
    runGit(['update-ref', `refs/heads/${this.readConfig().branch}`, commit], {
      cwd: this.libraryDir,
      operation: 'update-ref',
    });
  }

  /** 把索引里的元数据换成不含本机绝对路径的版本（工作树保持可用的本机路径）。 */
  private stagePortableMetadata(): void {
    const origins = this.readOrigins();
    const next: Record<string, string> = {};
    for (const dirName of listMetaDirNames(this.library.skillsDir)) {
      const meta = readSkillMeta(this.library.skillsDir, dirName);
      if (!meta) continue;
      const origin = meta.source?.origin;
      if (!origin || !isLocalAbsolutePath(origin)) continue;
      next[meta.skillId] = origin;
      const { origin: _dropped, ...sourceRest } = meta.source;
      const portable = { ...meta, source: sourceRest };
      const blob = runGitOk(['hash-object', '-w', '--stdin'], {
        cwd: this.libraryDir,
        operation: 'hash-object',
        input: JSON.stringify(portable, null, 2) + '\n',
      });
      runGit(
        ['update-index', '--add', '--cacheinfo', '100644', blob, `sync/${dirName}${SKILL_META_SUFFIX}`],
        { cwd: this.libraryDir, operation: 'update-index' },
      );
    }
    this.writeOrigins(next);
  }

  /** 单个提交的变更技能（按 skills/ 目录 diff，含元数据变化；不含 reports/）。 */
  /**
   * 提交树里的 skills/ 变更路径 → dirName 集合（新旧布局都认）：
   * .meta 下的元数据直接给 dirName；内容路径用本机已知 relPath 最长前缀匹配，回退首段。
   */
  private dirNamesFromTreePaths(files: readonly string[]): Set<string> {
    const relToDir = new Map(this.library.listSkills().map((s) => [s.relPath, s.dirName] as const));
    const dirs = new Set<string>();
    for (const file of files) {
      if (!file.startsWith('skills/')) continue;
      const rest = file.slice('skills/'.length);
      if (rest.startsWith('.meta/') && rest.endsWith(SKILL_META_SUFFIX)) {
        dirs.add(rest.slice('.meta/'.length, -SKILL_META_SUFFIX.length));
        continue;
      }
      if (rest.endsWith(SKILL_META_SUFFIX)) {
        dirs.add(rest.slice(0, -SKILL_META_SUFFIX.length)); // 旧布局：skills/<dirName>.skill.json
        continue;
      }
      const segments = rest.split('/');
      const twoSeg = segments.length >= 2 ? segments.slice(0, 2).join('/') : null;
      if (twoSeg != null && relToDir.has(twoSeg)) {
        dirs.add(relToDir.get(twoSeg)!);
        continue;
      }
      if (relToDir.has(segments[0])) {
        dirs.add(relToDir.get(segments[0])!);
        continue;
      }
      dirs.add(segments[0]);
    }
    return dirs;
  }

  private changedSkillsOf(commit: string): string[] {
    const paths = this.diffFilePaths(this.parentOf(commit), commit, ['skills']);
    return [...this.dirNamesFromTreePaths(paths)].sort();
  }

  private diffFilePaths(from: string | null, to: string, paths: string[]): string[] {
    const args = from
      ? ['diff', '--name-only', '--no-renames', '-z', from, to, '--', ...paths]
      : ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', to, '--', ...paths];
    const res = runGit(args, { cwd: this.libraryDir, allowFailure: true, operation: from ? 'diff' : 'diff-tree' });
    return res.stdout.split('\0').filter(Boolean);
  }

  private diffFiles(from: string | null, to: string, paths: string[]): CommitFileDiff {
    const base = from === '' ? EMPTY_TREE : from;
    const args = base
      ? ['diff', '--name-status', '--no-renames', '-z', base, to, '--', ...paths]
      : ['diff-tree', '--root', '--no-commit-id', '--name-status', '--no-renames', '-r', '-z', to, '--', ...paths];
    const res = runGit(args, { cwd: this.libraryDir, allowFailure: true, operation: base ? 'diff' : 'diff-tree' });
    const tokens = res.stdout.split('\0').filter(Boolean);
    const result: CommitFileDiff = { added: [], modified: [], removed: [] };
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const status = tokens[i][0];
      const file = tokens[i + 1];
      if (status === 'A') result.added.push(file);
      else if (status === 'D') result.removed.push(file);
      else result.modified.push(file);
    }
    return result;
  }

  /**
   * 落盘单个技能的评测报告。文件名沿用快照里的实际文件名，保证两端合并后名字一致；
   * 同技能同前缀的其它报告一并清掉（每个技能只保留一份）。
   */
  private applyReportFile(
    skill: { reportBlob: string | null; reportFile: string | null; meta: { name: string } },
    skillId: string,
    reader: GitObjectReader,
  ): void {
    const reportsDir = path.join(this.libraryDir, 'reports');
    const targetRel = skill.reportBlob
      ? (skill.reportFile ??
        `reports/${safeReportName(skill.meta.name, skillId)}_review_${reportStamp()}.md`)
      : null;
    if (targetRel) {
      writeReportFile(path.join(this.libraryDir, targetRel), reader.readBlob(skill.reportBlob!));
    }
    const stem = targetRel
      ? parseReportFile(path.basename(targetRel))?.name
      : safeReportName(skill.meta.name, skillId);
    if (!stem) return;
    const prefix = `reports/${stem}_review_`;
    let files: string[];
    try {
      files = fs.readdirSync(reportsDir);
    } catch {
      return;
    }
    for (const file of files) {
      const rel = `reports/${file}`;
      if (!rel.startsWith(prefix) || rel === targetRel) continue;
      try {
        fs.rmSync(path.join(reportsDir, file), { force: true });
      } catch {
        /* 旧报告清理失败不改变结果 */
      }
    }
  }

  // ═════════════════════════ 大文件排除 ═════════════════════════

  private computeExcludedSkills(): ExcludedSkill[] {
    const skillsDir = this.library.skillsDir;
    const out: ExcludedSkill[] = [];
    for (const dirName of listMetaDirNames(skillsDir)) {
      const meta = readSkillMeta(skillsDir, dirName);
      if (!meta) continue;
      const dir = skillsDirJoin(skillsDir, meta.relPath);
      if (!fs.existsSync(dir)) continue; // 已丢失技能不参与排除
      let size = meta.sizeBytes ?? null;
      if (size == null) {
        try {
          size = hashAndSizeSkillDir(dir).sizeBytes;
        } catch {
          continue;
        }
      }
      if (size > BIG_SKILL_THRESHOLD_BYTES) {
        out.push({ dirName, relPath: meta.relPath, skillId: meta.skillId, sizeBytes: size });
      }
    }
    return out.sort((a, b) => (a.dirName < b.dirName ? -1 : 1));
  }

  /**
   * 把 >100MB 的技能（目录 + 元数据）写进 `.git/info/exclude` 并从索引移除：
   * 库内保留、备份不含。返回本次被排除清单（供备份页展示）。
   */
  private applyExclusions(): ExcludedSkill[] {
    const excluded = this.computeExcludedSkills();
    const lines = [
      '# Skills 工作台：>100MB 技能留在库中但不进备份（本文件由应用自动维护）',
      '*.tmp',
      'Thumbs.db',
      '.DS_Store',
    ];
    for (const item of excluded) {
      const escapedRel = item.relPath.split('/').map(gitignoreEscape).join('/');
      lines.push(`/skills/${escapedRel}/`, `/sync/${gitignoreEscape(item.dirName)}${SKILL_META_SUFFIX}`);
    }
    const infoDir = path.join(this.libraryDir, '.git', 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(path.join(infoDir, 'exclude'), lines.join('\n') + '\n', 'utf8');

    for (const item of excluded) {
      runGit(
        [
          'rm',
          '-r',
          '--cached',
          '--ignore-unmatch',
          '--',
          `skills/${item.relPath}`,
          `sync/${item.dirName}${SKILL_META_SUFFIX}`,
        ],
        { cwd: this.libraryDir, allowFailure: true, operation: 'rm' },
      );
    }
    return excluded;
  }

  // ═════════════════════════ 合并结果落盘 ═════════════════════════

  /** 按计划写入工作树：内容树就地同步、元数据重算派生字段、报告单文件替换。 */
  private materializePlan(plan: MergePlan, reader: GitObjectReader): void {
    const skillsDir = this.library.skillsDir;
    const now = new Date().toISOString();
    // 被排除出备份的技能不在任何提交里，绝不能被「合并结果」顺手删掉
    const excluded = this.computeExcludedSkills();
    const excludedDirs = new Set(excluded.map((e) => e.dirName.toLowerCase()));
    const excludedRelPaths = new Set(excluded.map((e) => e.relPath));
    const plannedRelPaths = new Set<string>();

    for (const [skillId, skill] of Object.entries(plan.skills)) {
      const dirName = skill.meta.dirName;
      if (excludedDirs.has(dirName.toLowerCase())) continue; // 大技能留在本机，不参与备份内容
      // 落点：本机已有该技能（按 skillId）沿用其现有位置；否则按计划 meta 记录的位置（平铺兜底）
      const existing = readSkillMeta(skillsDir, dirName);
      const relPath = existing && existing.skillId === skillId
        ? existing.relPath
        : (skill.meta.relPath ?? dirName);
      plannedRelPaths.add(relPath);
      const targetDir = skillsDirJoin(skillsDir, relPath);

      if (skill.contentTree) {
        syncSkillDirectory(targetDir, reader.listTree(skill.contentTree), (oid) => reader.readBlob(oid));
      } else if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }

      const addedAt = existing && existing.skillId === skillId ? existing.addedAt : now;
      // 逻辑内容或本机位置变化就重写元数据（relPath 必须与磁盘一致，保持树=磁盘）
      if (!existing || existing.skillId !== skillId || !samePortableMeta(existing, skill) || existing.relPath !== relPath) {
        this.writeSkillMetaFromPlan(skill, addedAt, now, relPath);
      }
      this.applyReportFile(skill, skillId, reader);
    }

    // 计划外技能：目录 / 元数据 / 报告一并清理（对端删除生效）；
    // 技能目录按本机扫描口径精确定位（支持一层组子目录），排除技能保留
    for (const rel of collectLocalSkillRels(skillsDir)) {
      if (plannedRelPaths.has(rel) || excludedRelPaths.has(rel)) continue;
      fs.rmSync(skillsDirJoin(skillsDir, rel), { recursive: true, force: true });
    }
    // 清掉删空的一层组目录（点开头内部目录不动）
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const groupDir = path.join(skillsDir, entry.name);
      const remaining = fs.existsSync(groupDir) ? fs.readdirSync(groupDir, { withFileTypes: true }) : [];
      if (remaining.length === 0) fs.rmSync(groupDir, { recursive: true, force: true });
    }
    for (const dirName of listMetaDirNames(skillsDir)) {
      const meta = readSkillMeta(skillsDir, dirName);
      if (!meta) continue;
      if (plan.skills[meta.skillId] || excludedDirs.has(dirName.toLowerCase())) continue;
      fs.rmSync(skillMetaPath(skillsDir, dirName), { force: true });
    }
    const reportsDir = path.join(this.libraryDir, 'reports');
    if (fs.existsSync(reportsDir)) {
      // 报告文件名不再含 Skill ID，按「计划内路径 + 库内现存技能的取名规则」判断归属
      const plannedReports = new Set(
        Object.values(plan.skills)
          .map((planned) => planned.reportFile)
          .filter((file): file is string => typeof file === 'string'),
      );
      const liveNames = new Set<string>();
      const resolveName = reportNameResolver(this.library);
      for (const summary of this.library.listSkills()) {
        const name = resolveName(summary.skillId);
        if (name) liveNames.add(safeReportName(name, summary.skillId));
      }
      for (const file of fs.readdirSync(reportsDir)) {
        if (!file.endsWith('.md')) continue;
        if (plannedReports.has(`reports/${file}`)) continue;
        const parsed = parseReportFile(file);
        if (parsed && liveNames.has(parsed.name)) continue;
        fs.rmSync(path.join(reportsDir, file), { force: true });
      }
    }
  }

  private writeSkillMetaFromPlan(
    skill: PlannedSkill,
    addedAt: string,
    updatedAt: string,
    /** 实际落点（相对 skills 根）；覆盖计划/远端 meta 里的 relPath，保证与磁盘一致 */
    relPath: string,
  ): void {
    const source: SkillSourceInfo | null = skill.meta.source
      ? {
          type: skill.meta.source.type,
          ...(skill.meta.source.origin ? { origin: skill.meta.source.origin } : {}),
          importedAt: skill.meta.source.importedAt ?? updatedAt,
          ...(skill.meta.source.sourceRelPath ? { sourceRelPath: skill.meta.source.sourceRelPath } : {}),
          ...(skill.meta.source.sourceHash ? { sourceHash: skill.meta.source.sourceHash } : {}),
          ...(skill.meta.source.sourceBranch ? { sourceBranch: skill.meta.source.sourceBranch } : {}),
          ...(skill.meta.source.sourceRevision ? { sourceRevision: skill.meta.source.sourceRevision } : {}),
        }
      : null;
    let contentHash: string | null = null;
    let sizeBytes = 0;
    const skillDir = skillsDirJoin(this.library.skillsDir, relPath);
    if (skill.contentTree && fs.existsSync(skillDir)) {
      const hashed = hashAndSizeSkillDir(skillDir);
      contentHash = hashed.hash;
      sizeBytes = hashed.sizeBytes;
    }
    const meta: SkillMetadataFile = {
      schemaVersion: skill.meta.schemaVersion,
      skillId: skill.skillId,
      dirName: skill.meta.dirName,
      relPath,
      name: skill.meta.name,
      nameSource: skill.meta.nameSource,
      description: skill.meta.description,
      groups: [...new Set(skill.meta.groups)],
      source: source ?? { type: 'scan', importedAt: updatedAt },
      sync: { agents: [...new Set(skill.meta.sync.agents)] },
      contentHash,
      contentHashAt: contentHash ? updatedAt : null,
      sizeBytes,
      addedAt,
      updatedAt,
    };
    this.library.writeExternalMeta(meta);
  }

  // ═════════════════════════ 冲突 pin ═════════════════════════

  private deleteRef(ref: string): void {
    runGit(['update-ref', '-d', ref], { cwd: this.libraryDir, allowFailure: true, operation: 'update-ref' });
  }

  private loadConflicts(): PendingConflictInfo[] {
    try {
      const raw = fs.readFileSync(path.join(this.dataDir, CONFLICTS_FILE), 'utf8');
      const parsed = JSON.parse(raw) as PendingConflictsFile;
      if (!Array.isArray(parsed.conflicts)) return [];
      return parsed.conflicts.filter((c) => typeof c?.skillId === 'string');
    } catch {
      return [];
    }
  }

  private writeConflicts(conflicts: PendingConflictInfo[]): void {
    atomicWriteJson(path.join(this.dataDir, CONFLICTS_FILE), { schemaVersion: 1, conflicts });
    this.prunePendingRefs(new Set(conflicts.map((c) => c.skillId)));
  }

  /** 清掉已不再待决的 pin ref（解决冲突 / 双方都删掉该技能时）。 */
  private prunePendingRefs(keep: Set<string>): void {
    const out = runGit(['for-each-ref', '--format=%(refname)', PENDING_REF_PREFIX], {
      cwd: this.libraryDir,
      allowFailure: true,
      operation: 'for-each-ref',
    }).stdout;
    for (const ref of out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const id = ref.slice(PENDING_REF_PREFIX.length + 1);
      if (!keep.has(id)) this.deleteRef(ref);
    }
  }

  // ═════════════════════════ 本机映射与快照 ═════════════════════════

  private readConfig(): BackupConfigFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.dataDir, CONFIG_FILE), 'utf8')) as BackupConfigFile;
      return {
        schemaVersion: 1,
        remoteUrl: typeof parsed.remoteUrl === 'string' && parsed.remoteUrl ? parsed.remoteUrl : null,
        branch: typeof parsed.branch === 'string' && parsed.branch ? parsed.branch : 'main',
      };
    } catch {
      return { schemaVersion: 1, remoteUrl: null, branch: 'main' };
    }
  }

  private writeConfig(cfg: BackupConfigFile): void {
    atomicWriteJson(path.join(this.dataDir, CONFIG_FILE), cfg);
  }

  private readOrigins(): Record<string, string> {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.dataDir, ORIGINS_FILE), 'utf8')) as OriginsFile;
      return parsed && typeof parsed.origins === 'object' && parsed.origins ? parsed.origins : {};
    } catch {
      return {};
    }
  }

  private writeOrigins(origins: Record<string, string>): void {
    atomicWriteJson(path.join(this.dataDir, ORIGINS_FILE), { schemaVersion: 1, origins });
  }

  /** 拉取/恢复后把本机绝对来源路径合并回元数据（库内元数据本身不含它）。 */
  private restoreLocalOrigins(): void {
    const origins = this.readOrigins();
    for (const dirName of listMetaDirNames(this.library.skillsDir)) {
      const meta = readSkillMeta(this.library.skillsDir, dirName);
      if (!meta) continue;
      if (meta.source?.origin) continue;
      const origin = origins[meta.skillId];
      if (!origin) continue;
      this.library.writeExternalMeta({ ...meta, source: { ...meta.source, origin } });
    }
  }

  private createSnapshot(commit: string, kind: string): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // YYYYMMDD-HHMMSS
    const safeKind = kind.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
    const base = `${SNAPSHOT_REF_PREFIX}/${stamp}-${safeKind}-${commit.slice(0, 8)}`;
    let ref = base;
    let n = 2;
    while (this.refExists(ref)) ref = `${base}-${n++}`;
    runGit(['update-ref', ref, commit], { cwd: this.libraryDir, operation: 'update-ref' });
    return ref;
  }

  private refExists(ref: string): boolean {
    return (
      runGit(['show-ref', '--verify', '--quiet', ref], {
        cwd: this.libraryDir,
        allowFailure: true,
        operation: 'show-ref',
      }).status === 0
    );
  }

  // ═════════════════════════ 工作树切换 ═════════════════════════

  /** 工作树与索引切换到某提交（不移动分支）。 */
  private applyTree(commit: string): void {
    runGit(['read-tree', '-u', '--reset', commit], { cwd: this.libraryDir, operation: 'read-tree' });
  }

  private rollbackWorktree(commit: string): void {
    try {
      this.applyTree(commit);
      this.logger?.info('backup:rollback', { commit });
    } catch (err) {
      this.logger?.error('backup:rollback-failed', { error: (err as Error).message });
      throw new BackupError('GIT_ROLLBACK_FAILED', `回滚到 ${commit.slice(0, 8)} 失败：${(err as Error).message}`);
    }
  }

  // ═════════════════════════ 小工具 ═════════════════════════

  private skillIdSet(): Set<string> {
    return new Set(this.library.listSkills().map((s) => s.skillId));
  }

  private diffSkillIds(before: Set<string>): string[] {
    return [...this.skillIdSet()].filter((id) => !before.has(id)).sort();
  }

  private emitImportedForNew(before: Set<string>, detail: string): void {
    for (const skill of this.library.listSkills()) {
      if (before.has(skill.skillId)) continue;
      this.library.appendEvent(skill.skillId, 'imported', detail);
    }
  }

  /**
   * 拉取/恢复带来的真实内容变化事件（按目录内容哈希比对）。
   * 元数据里的 contentHash 是从对端带过来的，rescan 因此看不出变化，必须显式补事件；
   * 只对「之前存在且哈希变了」的技能发事件，新增技能发 imported、未变化的不发。
   */
  private emitChangedSince(before: Map<string, string | null>, detailPrefix: string): void {
    const byRel = new Map(this.library.listSkills().map((s) => [s.relPath, s] as const));
    const after = this.hashAllSkills();
    for (const [relPath, hash] of after) {
      const previous = before.get(relPath);
      if (previous === undefined || previous === hash) continue;
      const skill = byRel.get(relPath);
      if (skill) this.library.appendEvent(skill.skillId, 'content-changed', `${detailPrefix}：${skill.dirName}`);
    }
  }

  private findCurrentMeta(skillId: string): ReadSkillMeta | null {
    for (const dirName of listMetaDirNames(this.library.skillsDir)) {
      const meta = readSkillMeta(this.library.skillsDir, dirName);
      if (meta?.skillId === skillId) return meta;
    }
    return null;
  }

  /** 目录名冲突安全处理：优先原名，被占用则顺延 `原名 (2)`。 */
  private availableDirName(preferred: string, forSkillId: string): string {
    const taken = new Set<string>();
    const metaDirNames = listMetaDirNames(this.library.skillsDir);
    const known = new Set(metaDirNames.map((n) => n.toLowerCase()));
    for (const dirName of metaDirNames) {
      const meta = readSkillMeta(this.library.skillsDir, dirName);
      if (meta && meta.skillId === forSkillId) continue;
      taken.add(dirName.toLowerCase());
    }
    // 没有元数据的目录同样不能被占用（宁可多让一个名字，也不写坏别人的目录）
    try {
      for (const entry of fs.readdirSync(this.library.skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !known.has(entry.name.toLowerCase())) taken.add(entry.name.toLowerCase());
      }
    } catch {
      /* 空库 */
    }
    if (!taken.has(preferred.toLowerCase())) return preferred;
    let n = 2;
    for (;;) {
      const candidate = `${preferred} (${n})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
      n++;
    }
  }

  /** 全库内容哈希快照（键 = relPath，支持一层组子目录）。 */
  private hashAllSkills(): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const skill of this.library.listSkills()) {
      if (skill.missing) continue;
      out.set(skill.relPath, this.hashDirOrNull(skillsDirJoin(this.library.skillsDir, skill.relPath)));
    }
    return out;
  }

  private hashDirOrNull(dir: string): string | null {
    try {
      return hashAndSizeSkillDir(dir).hash;
    } catch {
      return null;
    }
  }

  /**
   * 库一致性校验：每个技能目录都必须有元数据（反之元数据可以没有目录——T01「已丢失」）。
   * 恢复/合并落盘后调用，违规整体中止（调用方负责回滚）。
   */
  private assertLibraryConsistent(): void {
    const skillsDir = this.library.skillsDir;
    const metaDirs = new Set(listMetaDirNames(skillsDir));
    const orphanDirs: string[] = [];
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!metaDirs.has(entry.name)) orphanDirs.push(entry.name);
    }
    if (orphanDirs.length > 0) {
      throw new BackupError(
        'LIBRARY_INCONSISTENT',
        `校验失败：技能目录缺少元数据（${orphanDirs.join(', ')}），已回滚`,
      );
    }
  }

  private toBackupError(err: unknown): BackupError {
    if (err instanceof BackupError) return err;
    if (err instanceof GitError) return new BackupError(err.code, err.detail, err.diagnostic);
    if (err instanceof MergeValidationError) return new BackupError(err.code, err.message, err.reasons.join('；'));
    return new BackupError('SYNC_FAILED', (err as Error).message ?? String(err));
  }
}

// ═════════════════════════ 文件工具 ═════════════════════════

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** gitignore 模式转义（目录名来自清洗后的技能名，只需处理 glob 元字符）。 */
function gitignoreEscape(name: string): string {
  return name.replace(/([\\*?\[\]!#])/g, '\\$1');
}

/** 比较「落盘元数据」与「计划元数据」的逻辑内容（忽略本机 origin 与派生字段）。 */
function samePortableMeta(disk: SkillMetadataFile, planned: PlannedSkill): boolean {
  const strip = (meta: PortableSkillMeta): PortableSkillMeta => ({
    ...meta,
    source: meta.source ? { type: meta.source.type, sourceRelPath: meta.source.sourceRelPath,
      sourceHash: meta.source.sourceHash, sourceBranch: meta.source.sourceBranch,
      sourceRevision: meta.source.sourceRevision } : null,
  });
  return metaComparableKey(strip(toPortableMeta(disk, disk.dirName))) === metaComparableKey(strip(planned.meta));
}
