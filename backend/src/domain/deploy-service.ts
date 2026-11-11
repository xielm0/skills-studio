/**
 * 部署服务（prd.md M5、tec.md §5.5/§8/T03）：链接部署、撤下、灰灯入库、Agent 视图数据。
 *
 * 唯一形态是链接：symlink 优先 → junction 兜底，绝不复制。判定一律 lstat（见 link-manager）。
 * 目标现状三分支：不存在 → 建链；已指向本技能 → 幂等；实体目录或指向别处 → 冲突且零覆盖零删除。
 * 所有写操作（部署 / 撤下 / 入库）经同一把跨进程锁串行化（GUI 与 CLI 共库时安全）。
 * 同步意图（元数据 sync.agents）随库进 Git，是本机「应部署到哪些 Agent」的意图；
 * 跨机拉来的意图只显示不自动执行——部署只由显式调用触发。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WriteLock } from '../infra/write-lock';
import { readSkillMeta, readSkillMetaAsync, skillMetaPath } from '../infra/fs-meta';
import {
  LinkError,
  createDirLink,
  ensureDir,
  inspectTarget,
  inspectTargetAsync,
  isPathInside,
  removeDirLink,
  resolveLinkPath,
  samePath,
  type LinkType,
  type RemoveLinkMethod,
  type TargetKind,
} from '../infra/link-manager';
import { AgentConfigService, type AgentInfo } from './agents';
import { hashSkillDir, isIgnoredDirName, isIgnoredFileName } from './content-hash';
import { compareSkillDirs } from './skill-dir-diff';
import { isSkillDir, readSkillMd } from './frontmatter';
import { SkillLibraryService, type MovedSkill } from './library';
import { groupOfSkillRelPath, isPathSafe, sanitizeName, validateNewDirName, validateSkillRelPath } from './path-guard';
import { libraryDestDirOf } from '../infra/fs-meta';
import { scanLocalSkills, type DiscoveredToolSkill } from './tool-scanner';
import type { PlacementStore } from './placement-store';
import type { SkillSourceService } from './sources/source-service';
import type { DeploymentStatusProbe, SkillSummary } from './types';
import type { AgentsAdoptResult, LibrarySyncDiffRequest, LibrarySyncDiffResult } from '../shared/ipc';

export type DeployItemStatus = 'deployed' | 'already' | 'conflict' | 'failed' | 'skipped';

export interface DeployConflictInfo {
  /** 目标当前位置的形态（不含 missing：不存在的目标走建链分支） */
  targetType: 'dir' | 'file' | 'link-elsewhere' | 'other';
  /** link-elsewhere 时给出实际指向 */
  actualTarget: string | null;
}

export interface DeployItemResult {
  skillId: string;
  dirName: string;
  agentId: string;
  agentName: string;
  targetPath: string;
  status: DeployItemStatus;
  /** 实际使用的链接形态（deployed / already 时给出） */
  linkType?: LinkType;
  /** symlink 首次失败的错误码（走 junction 兜底时存在；属预期路径） */
  symlinkErrorCode?: string;
  conflict?: DeployConflictInfo;
  reason?: string;
  code?: string;
}

export interface SyncToAgentsResult {
  items: DeployItemResult[];
  /** 汇总计数（UI 状态条用） */
  summary: Record<DeployItemStatus, number>;
}

export type DeployPlanStatus = 'ready' | 'already' | 'same-content' | 'conflict' | 'failed' | 'skipped';

export interface DeployPlanItem {
  skillId: string;
  dirName: string;
  agentId: string;
  agentName: string;
  status: DeployPlanStatus;
  reason?: string;
  /** 复核用户选择时使用；不作为写入授权，执行时重新读取磁盘。 */
  fingerprint?: string;
  sourceHash?: string;
}

export interface DeployDecision {
  skillId: string;
  agentId: string;
  choice: 'overwrite' | 'skip';
  fingerprint: string;
  sourceHash: string;
}

export type UndeployItemStatus = 'removed' | 'noop' | 'replaced' | 'failed';

export interface UndeployItemResult {
  skillId: string;
  dirName: string;
  agentId: string;
  agentName: string;
  targetPath: string;
  status: UndeployItemStatus;
  /** 实际删除链接的方式（Windows junction 上 unlink / rmdir 的实测结论） */
  removedVia?: RemoveLinkMethod;
  reason?: string;
  code?: string;
}

export type AgentSkillEntryType = 'link-to-library' | 'link-elsewhere' | 'real-dir' | 'real-file' | 'other';

/** Agents Tab 每行数据源（绿/灰灯）：调用时实时读目录，不缓存。 */
export interface AgentSkillEntry {
  name: string;
  entryType: AgentSkillEntryType;
  /** entryType='link-to-library' */
  isLibraryLink: boolean;
  skillId: string | null;
  /** 链接指向库内但技能目录已不存在（复用 T01「已丢失」语义） */
  missing: boolean;
}

export interface PendingIntentSkill {
  skillId: string;
  dirName: string;
  name: string;
}

/** 跨机拉来的同步意图中「已配置、未执行」的项（只显示，不自动部署）。 */
export interface PendingDeployIntent {
  agentId: string;
  agentName: string;
  skills: PendingIntentSkill[];
}

export type AdoptStatus = 'adopted' | 'already-managed' | 'failed';

export interface AdoptResult {
  entry: string;
  status: AdoptStatus;
  skillId: string | null;
  /** 库内已有同名同内容技能 → 复用，不复制 */
  reused?: boolean;
  linkType?: LinkType;
  /** 失败后原位置是否已确认恢复 */
  restored?: boolean;
  reason?: string;
  code?: string;
}

export interface DeploymentVerification {
  deployed: boolean;
  targetPath: string;
  targetKind: TargetKind;
  actualTarget: string | null;
}

export interface SkillDeployServiceOptions {
  library: SkillLibraryService;
  agents: AgentConfigService;
  lock: WriteLock;
  /** 灰灯入库复用 T02 导入服务（不传则 adoptExisting 明确报不支持） */
  sources?: SkillSourceService;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
  /**
   * 测试专用失败注入点：在 adopt 的指定阶段抛错，用于验证「任一步失败 → 恢复原位置 + 撤销库内新增」。
   * 生产不设置。
   */
  adoptFailPoint?: 'after-copy' | 'after-stage' | 'after-link' | null;
  /** adopt 暂存前缀（暂存位必须在被重命名目录之外：放在 agent skills 目录内） */
  adoptStagingPrefix?: string;
  /**
   * 同步落点记忆（`<库>/agents-skills/<agentId>.skills`）。不传则不启用记忆，一律按平铺 + 回找。
   * 启用后：有记录就用记录的位置；扫描时整份重写；同步成功/撤下后更新该条。
   */
  placement?: PlacementStore;
}

const DEFAULT_ADOPT_PREFIX = '.adopt-old-';

export class SkillDeployService {
  private readonly library: SkillLibraryService;
  private readonly agents: AgentConfigService;
  private readonly lock: WriteLock;
  private readonly sources: SkillSourceService | undefined;
  private readonly logger: SkillDeployServiceOptions['logger'];
  private readonly adoptFailPoint: SkillDeployServiceOptions['adoptFailPoint'];
  private readonly adoptStagingPrefix: string;
  private readonly placement: PlacementStore | undefined;

  constructor(opts: SkillDeployServiceOptions) {
    this.library = opts.library;
    this.agents = opts.agents;
    this.lock = opts.lock;
    this.sources = opts.sources;
    this.logger = opts.logger;
    this.adoptFailPoint = opts.adoptFailPoint ?? null;
    this.adoptStagingPrefix = opts.adoptStagingPrefix ?? DEFAULT_ADOPT_PREFIX;
    this.placement = opts.placement;
  }

  // ────────────────────────── 部署 ──────────────────────────

  /**
   * 批量同步：只处理**启用且已安装**的 Agent；逐项返回结果，单项失败不影响其他项。
   * 成功后把 Agent 记入该技能的同步意图（随库进 Git）并发 deploy-status 事件。
   */
  async syncToAgents(skillIds: string[], agentIds: string[]): Promise<SyncToAgentsResult> {
    return this.lock.runExclusive('deploy', async () => {
      await this.ensurePlacement(agentIds);
      const items: DeployItemResult[] = [];
      for (const skillId of skillIds) {
        for (const agentId of agentIds) items.push(this.deployOneUnlocked(skillId, agentId));
      }
      this.rememberDeployed(items);
      return { items, summary: summarize(items) };
    });
  }

  /** 中心库页面只读预检查：同名目标按内容分成自动接管和待用户选择两类。 */
  async planSyncToAgents(skillIds: string[], agentIds: string[]): Promise<DeployPlanItem[]> {
    return this.lock.runExclusive('deploy-plan', async () => {
      // 预检与执行必须看同一张落点表，否则会出现「预检说待同步、点了报冲突」
      await this.ensurePlacement(agentIds);
      return skillIds.flatMap((skillId) => agentIds.map((agentId) => this.planOneUnlocked(skillId, agentId)));
    });
  }

  /** Read-only comparison of the exact placement used by deployment. */
  async syncDiff(request: LibrarySyncDiffRequest): Promise<LibrarySyncDiffResult> {
    return this.lock.runExclusive('deploy-plan', async () => {
      await this.ensurePlacement([request.agentId]);
      const plan = this.planOneUnlocked(request.skillId, request.agentId);
      if (plan.status !== 'conflict' || plan.fingerprint !== request.fingerprint || plan.sourceHash !== request.sourceHash) {
        return { stale: true, sourceMtime: null, targetMtime: null, files: [], source: null, target: null };
      }
      const sourceRoot = this.librarySkillDir(plan.dirName);
      const agent = this.agents.get(request.agentId)!;
      const targetRoot = this.resolveAgentTarget(agent, plan.dirName);
      return compareSkillDirs(sourceRoot, targetRoot, request.relPath);
    });
  }

  /** 逐项执行，冲突只接受与预检查一致的显式选择。其他直接调用者仍走原有无覆盖接口。 */
  async syncToAgentsResolved(skillIds: string[], agentIds: string[], decisions: DeployDecision[]): Promise<SyncToAgentsResult> {
    return this.lock.runExclusive('deploy', async () => {
      await this.ensurePlacement(agentIds);
      const choices = new Map(decisions.map((d) => [`${d.skillId}\0${d.agentId}`, d]));
      const items: DeployItemResult[] = [];
      for (const skillId of skillIds) {
        for (const agentId of agentIds) {
          const plan = this.planOneUnlocked(skillId, agentId);
          if (plan.status === 'ready' || plan.status === 'already') {
            items.push(this.deployOneUnlocked(skillId, agentId));
            continue;
          }
          const base = this.planToResult(plan);
          if (plan.status === 'failed' || plan.status === 'skipped') {
            items.push(base);
            continue;
          }
          if (plan.status === 'same-content') {
            items.push(this.replaceExistingUnlocked(plan));
            continue;
          }
          const choice = choices.get(`${skillId}\0${agentId}`);
          if (!choice) {
            items.push(base);
          } else if (choice.fingerprint !== plan.fingerprint || choice.sourceHash !== plan.sourceHash) {
            items.push({ ...base, reason: '内容在确认后发生变化，请重新检查并选择' });
          } else if (choice.choice === 'skip') {
            items.push({ ...base, status: 'skipped', reason: '已跳过，Agent 原内容保持不变' });
          } else {
            items.push(this.replaceExistingUnlocked(plan));
          }
        }
      }
      this.rememberDeployed(items);
      return { items, summary: summarize(items) };
    });
  }

  /** Agents 页单项冲突：显式确认后建链。 */
  async resolveAgentConflict(decision: DeployDecision): Promise<DeployItemResult> {
    return this.lock.runExclusive('deploy', async () => {
      await this.ensurePlacement([decision.agentId]);
      const plan = this.planOneUnlocked(decision.skillId, decision.agentId);
      if (plan.status !== 'conflict' || plan.fingerprint !== decision.fingerprint || plan.sourceHash !== decision.sourceHash) {
        return { ...this.planToResult(plan), status: 'conflict', reason: '内容已变化，请重新查看差异' };
      }
      const result = decision.choice === 'skip'
        ? { ...this.planToResult(plan), status: 'skipped' as const, reason: '已跳过' }
        : this.replaceExistingUnlocked(plan);
      this.rememberDeployed([result]);
      return result;
    });
  }

  private planOneUnlocked(skillId: string, agentId: string): DeployPlanItem {
    const skill = this.findSkill(skillId);
    const agent = this.agents.get(agentId);
    const base = { skillId, agentId, dirName: skill?.dirName ?? '', agentName: agent?.name ?? agentId };
    if (!skill || skill.missing) return { ...base, status: 'failed', reason: '中心库技能不存在或目录已丢失' };
    if (!agent) return { ...base, status: 'failed', reason: 'Agent 不存在' };
    if (!agent.enabled || !agent.installed) return { ...base, status: 'skipped', reason: 'Agent 已停用或技能目录不存在' };
    const source = this.librarySkillDir(skill.dirName);
    // 预检与执行必须用同一条落点解析，否则会出现「预检说待同步、执行说已同步」
    const target = this.resolveAgentTarget(agent, skill.dirName);
    const guard = this.checkRecursive(source, target);
    if (guard) return { ...base, status: 'failed', reason: guard };
    try {
      const insp = inspectTarget(target);
      if (insp.kind === 'missing') return { ...base, status: 'ready' };
      if (insp.kind === 'link' && samePath(insp.resolvedTarget, source)) return { ...base, status: 'already' };
      const sourceHash = this.syncContentHash(source);
      const contentHash = this.targetContentHash(target, insp);
      const fingerprint = this.targetFingerprint(target, insp, contentHash);
      return {
        ...base,
        status: contentHash === sourceHash ? 'same-content' : 'conflict',
        fingerprint,
        sourceHash,
        reason: contentHash === sourceHash ? undefined : 'Agent 中已有同名但内容不同的文件',
      };
    } catch (err) {
      return { ...base, status: 'failed', reason: `读取目标内容失败：${(err as Error).message}` };
    }
  }

  private targetContentHash(target: string, insp: ReturnType<typeof inspectTarget>): string | null {
    if (insp.kind === 'dir' || (insp.kind === 'link' && isDir(target))) return this.syncContentHash(target);
    if (insp.kind === 'file') return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    return null;
  }

  /** 部署判同额外纳入目录内的链接，避免内容哈希忽略链接时误删用户的目录项。 */
  private syncContentHash(dir: string): string {
    const hash = crypto.createHash('sha256').update(hashSkillDir(dir));
    const walk = (current: string, prefix: string) => {
      const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (isIgnoredDirName(entry.name) || isIgnoredFileName(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) hash.update(`link\0${rel}\0${fs.readlinkSync(full)}\0`);
        else if (entry.isDirectory()) walk(full, rel);
      }
    };
    walk(dir, '');
    return hash.digest('hex');
  }

  private targetFingerprint(target: string, insp: ReturnType<typeof inspectTarget>, contentHash = this.targetContentHash(target, insp)): string {
    return `${insp.kind}:${insp.linkTarget ?? ''}:${insp.resolvedTarget ?? ''}:${contentHash ?? 'unreadable'}`;
  }

  private planToResult(plan: DeployPlanItem): DeployItemResult {
    const agent = this.agents.get(plan.agentId);
    const targetPath = agent && plan.dirName ? this.resolveAgentTarget(agent, plan.dirName) : '';
    return {
      skillId: plan.skillId, agentId: plan.agentId, dirName: plan.dirName, agentName: plan.agentName,
      targetPath,
      status: plan.status === 'conflict' ? 'conflict' : plan.status === 'skipped' ? 'skipped' : 'failed',
      reason: plan.reason,
    };
  }

  private replaceExistingUnlocked(plan: DeployPlanItem): DeployItemResult {
    const agent = this.agents.get(plan.agentId);
    if (!agent) return { ...this.planToResult(plan), status: 'failed', reason: 'Agent 不存在' };
    const source = this.librarySkillDir(plan.dirName);
    const target = this.resolveAgentTarget(agent, plan.dirName);
    const current = this.planOneUnlocked(plan.skillId, plan.agentId);
    if (current.fingerprint !== plan.fingerprint || current.sourceHash !== plan.sourceHash) {
      return { ...this.planToResult(plan), status: 'conflict', reason: '内容发生变化，请重新检查并选择' };
    }
    const base = this.planToResult(plan);
    const staged = path.join(agent.skillsDir, `.skills-studio-replace-${crypto.randomUUID()}`);
    let stagedExists = false;
    try {
      fs.renameSync(target, staged);
      stagedExists = true;
      const stagedInspection = inspectTarget(staged);
      if (this.targetFingerprint(staged, stagedInspection) !== plan.fingerprint) throw new Error('暂存期间内容发生变化');
      const created = createDirLink(source, target);
      const verify = inspectTarget(target);
      if (verify.kind !== 'link' || !samePath(verify.resolvedTarget, source)) throw new Error('新链接校验失败');
      if (stagedInspection.kind === 'dir') fs.rmSync(staged, { recursive: true });
      else if (stagedInspection.kind === 'link') removeDirLink(staged);
      else fs.unlinkSync(staged);
      stagedExists = false;
      this.addIntent(plan.dirName, plan.agentId);
      this.library.appendEvent(plan.skillId, 'deploy-status', `同步到 ${agent.name}`);
      return { ...base, status: 'deployed', linkType: created.linkType };
    } catch (err) {
      try {
        const now = inspectTarget(target);
        if (now.kind === 'link' && samePath(now.resolvedTarget, source)) removeDirLink(target);
        if (stagedExists) {
          if (inspectTarget(target).kind !== 'missing') throw new Error('目标位置已被占用');
          fs.renameSync(staged, target);
        }
      } catch (restoreError) {
        return { ...base, status: 'failed', reason: `同步失败且恢复原位置失败：${(restoreError as Error).message}` };
      }
      return { ...base, status: 'failed', reason: `同步失败，原位置已恢复：${(err as Error).message}` };
    }
  }

  /** 单个部署（同样持锁，供 UI 单项操作调用）。 */
  async deployOne(skillId: string, agentId: string): Promise<DeployItemResult> {
    return this.lock.runExclusive('deploy', () => this.deployOneUnlocked(skillId, agentId));
  }

  private deployOneUnlocked(skillId: string, agentId: string): DeployItemResult {
    const skill = this.findSkill(skillId);
    const agent = this.agents.get(agentId);
    const base: Pick<DeployItemResult, 'skillId' | 'agentId' | 'agentName' | 'dirName' | 'targetPath'> = {
      skillId,
      agentId,
      agentName: agent?.name ?? agentId,
      dirName: skill?.dirName ?? '',
      targetPath: agent ? path.join(agent.skillsDir, skill?.dirName ?? '') : '',
    };

    if (!skill) return { ...base, status: 'failed', code: 'SKILL_NOT_FOUND', reason: `技能不存在：${skillId}` };
    if (skill.missing) {
      return { ...base, status: 'failed', code: 'SKILL_MISSING', reason: '技能目录已丢失，无法同步' };
    }
    if (!agent) return { ...base, status: 'failed', code: 'AGENT_NOT_FOUND', reason: `Agent 不存在：${agentId}` };
    if (!agent.enabled) {
      // 停用 Agent：保留已有链接，但不再作为同步目标
      return { ...base, status: 'skipped', code: 'AGENT_DISABLED', reason: 'Agent 已停用，不作为同步目标' };
    }
    if (!agent.installed) {
      return { ...base, status: 'skipped', code: 'AGENT_NOT_INSTALLED', reason: '未检测到该 Agent 的 Skills 目录' };
    }

    const srcDir = this.librarySkillDir(skill.dirName);
    const target = this.resolveAgentTarget(agent, skill.dirName);
    // 返回的实际落点必须与解析结果一致（落点记忆可能是两层），否则界面与记忆都会写错
    base.targetPath = target;
    const guard = this.checkRecursive(srcDir, target);
    if (guard != null) return { ...base, status: 'failed', code: 'RECURSIVE_TARGET', reason: guard };

    const insp = inspectTarget(target);

    // ① 不存在 → 建链
    if (insp.kind === 'missing') {
      ensureDir(agent.skillsDir);
      // 落点可能是两层（skills/<group>/<技能名>），group 目录此时可能还不存在
      ensureDir(path.dirname(target));
      let created: { linkType: LinkType; symlinkErrorCode?: string };
      try {
        created = createDirLink(srcDir, target);
      } catch (err) {
        const le = err as LinkError;
        return {
          ...base,
          status: 'failed',
          code: le.code ?? 'LINK_CREATE_FAILED',
          reason: le.detail ?? (err as Error).message,
        };
      }
      // 回读验证：必须确实是链接且指向本技能
      const verify = inspectTarget(target);
      if (verify.kind !== 'link' || !samePath(verify.resolvedTarget, srcDir)) {
        try {
          if (verify.kind === 'link') removeDirLink(target);
        } catch {
          /* 清理失败已在 reason 中体现 */
        }
        return {
          ...base,
          status: 'failed',
          code: 'LINK_VERIFY_FAILED',
          reason: `建链后回读校验失败（lstat=${verify.kind}，指向 ${verify.resolvedTarget ?? 'null'}），已尝试恢复`,
        };
      }
      const changed = this.addIntent(skill.dirName, agentId);
      if (changed) {
        this.library.appendEvent(skillId, 'deploy-status', `同步到 ${agent.name}（${created.linkType}）`);
      }
      this.logger?.info('deploy:created', {
        skillId,
        agentId,
        linkType: created.linkType,
        symlinkErrorCode: created.symlinkErrorCode ?? null,
        target,
      });
      return {
        ...base,
        status: 'deployed',
        linkType: created.linkType,
        symlinkErrorCode: created.symlinkErrorCode,
      };
    }

    // ② 已是链接且指向本技能 → 幂等
    if (insp.kind === 'link' && samePath(insp.resolvedTarget, srcDir)) {
      const changed = this.addIntent(skill.dirName, agentId);
      if (changed) this.library.appendEvent(skillId, 'deploy-status', `同步到 ${agent.name}（已存在链接）`);
      return { ...base, status: 'already' };
    }

    // ③ 实体目录 / 文件 / 指向别处 → 冲突，零覆盖零删除
    const targetType: DeployConflictInfo['targetType'] =
      insp.kind === 'dir' ? 'dir' : insp.kind === 'file' ? 'file' : insp.kind === 'link' ? 'link-elsewhere' : 'other';
    this.logger?.info('deploy:conflict', { skillId, agentId, targetType, actualTarget: insp.resolvedTarget });
    return {
      ...base,
      status: 'conflict',
      code: 'TARGET_CONFLICT',
      conflict: { targetType, actualTarget: insp.resolvedTarget },
      reason:
        targetType === 'link-elsewhere'
          ? `目标已存在且是指向别处的链接（${insp.resolvedTarget ?? '未知'}），未覆盖、未删除`
          : '目标已存在且不是本技能的链接（实体目录/文件），未覆盖、未删除',
    };
  }

  // ────────────────────────── 撤下 ──────────────────────────

  /** 撤下部署：只删「确实指向本技能」的链接；被替换为实体目录时不动并如实报告。 */
  async undeploy(skillId: string, agentId: string): Promise<UndeployItemResult> {
    return this.lock.runExclusive('undeploy', () => this.undeployUnlocked(skillId, agentId));
  }

  async undeployFromAgents(skillId: string, agentIds: string[]): Promise<UndeployItemResult[]> {
    return this.lock.runExclusive('undeploy', () => agentIds.map((id) => this.undeployUnlocked(skillId, id)));
  }

  /**
   * 库内目录移动（文件夹改名 / 删除）后重建 Agent 侧链接。
   *
   * 链接里存的是库内绝对路径，目录一移就悬空，所以必须跟着改：
   *  - 只删「确实指向该技能旧位置」的链接（previousPath），指向别处的链接零覆盖零删除；
   *  - 按原落点重建（resolveAgentTarget 读落点记忆，不动记忆本身），落点层级不变；
   *  - 目标已被替换成实体目录/文件时跳过并如实报告，交用户处理。
   * 意图取元数据 sync.agents：链接断了之后 deployedAgents（意图 ∩ 实测）会变空，不能用它。
   */
  async relinkMoved(items: readonly MovedSkill[]): Promise<DeployItemResult[]> {
    return this.lock.runExclusive('deploy', async () => {
      const results: DeployItemResult[] = [];
      for (const item of items) {
        const skill = this.findSkill(item.skillId);
        if (!skill) continue;
        const agentIds = readSkillMeta(this.library.skillsDir, item.dirName)?.sync?.agents ?? [];
        for (const agentId of agentIds) {
          const agent = this.agents.get(agentId);
          if (!agent) continue;
          const target = this.resolveAgentTarget(agent, item.dirName);
          const insp = inspectTarget(target);
          const isOldLink = insp.kind === 'link' && insp.resolvedTarget != null
            && samePath(insp.resolvedTarget, item.previousPath);
          if (insp.kind !== 'missing' && !isOldLink) {
            results.push({
              skillId: item.skillId,
              agentId,
              agentName: agent.name,
              dirName: item.dirName,
              targetPath: target,
              status: 'skipped',
              code: 'TARGET_REPLACED',
              reason: '目标已被替换（实体目录或指向别处的链接），未自动重建',
            });
            continue;
          }
          if (isOldLink) {
            try {
              removeDirLink(target);
            } catch (err) {
              const le = err as LinkError;
              results.push({
                skillId: item.skillId,
                agentId,
                agentName: agent.name,
                dirName: item.dirName,
                targetPath: target,
                status: 'failed',
                code: le.code ?? 'LINK_REMOVE_FAILED',
                reason: le.detail ?? (err as Error).message,
              });
              continue;
            }
          }
          results.push(this.deployOneUnlocked(item.skillId, agentId));
        }
      }
      return results;
    });
  }

  private undeployUnlocked(skillId: string, agentId: string): UndeployItemResult {
    const skill = this.findSkill(skillId);
    const agent = this.agents.get(agentId);
    const base: Pick<UndeployItemResult, 'skillId' | 'agentId' | 'agentName' | 'dirName' | 'targetPath'> = {
      skillId,
      agentId,
      agentName: agent?.name ?? agentId,
      dirName: skill?.dirName ?? '',
      targetPath: agent ? path.join(agent.skillsDir, skill?.dirName ?? '') : '',
    };
    if (!skill) return { ...base, status: 'failed', code: 'SKILL_NOT_FOUND', reason: `技能不存在：${skillId}` };
    if (!agent) return { ...base, status: 'failed', code: 'AGENT_NOT_FOUND', reason: `Agent 不存在：${agentId}` };

    const srcDir = this.librarySkillDir(skill.dirName);
    const target = this.resolveAgentTarget(agent, skill.dirName);
    const insp = inspectTarget(target);

    if (insp.kind === 'missing') {
      this.removeIntent(skill.dirName, agentId);
      this.placement?.remove(agentId, skill.dirName);
      return { ...base, status: 'noop' };
    }
    if (insp.kind === 'link' && samePath(insp.resolvedTarget, srcDir)) {
      let removedVia: RemoveLinkMethod;
      try {
        removedVia = removeDirLink(target);
      } catch (err) {
        const le = err as LinkError;
        return {
          ...base,
          status: 'failed',
          code: le.code ?? 'LINK_REMOVE_FAILED',
          reason: le.detail ?? (err as Error).message,
        };
      }
      const changed = this.removeIntent(skill.dirName, agentId);
      this.placement?.remove(agentId, skill.dirName);
      if (changed) this.library.appendEvent(skillId, 'deploy-status', `已从 ${agent.name} 撤下`);
      this.logger?.info('deploy:removed', { skillId, agentId, removedVia, target });
      // 库内真身必须零影响：只删了链接，这里不做任何库目录操作
      return { ...base, status: 'removed', removedVia };
    }
    // 实体目录 / 文件 / 指向别处：不删、不改意图，交由用户处理
    return {
      ...base,
      status: 'replaced',
      code: 'TARGET_REPLACED',
      reason: '目标已被替换（实体目录或指向别处的链接），未删除，需人工处理',
    };
  }

  /**
   * Agents 页删掉该 Agent 上的库链接后复位：清同步意图与落点记忆（库内真身零影响）。
   * 只删链接的调用方已经确认过目标确实指向本库，这里只维护元数据与事件。
   */
  forgetSync(agentId: string, libraryDirName: string): void {
    const changed = this.removeIntent(libraryDirName, agentId);
    this.placement?.remove(agentId, libraryDirName);
    if (!changed) return;
    const summary = this.library.listSkills().find((s) => s.dirName === libraryDirName);
    if (!summary) return;
    const agentName = this.agents.get(agentId)?.name ?? agentId;
    this.library.appendEvent(summary.skillId, 'deploy-status', `已从 ${agentName} 撤下`);
    this.logger?.info('deploy:forgotten', { skillId: summary.skillId, agentId });
  }

  // ────────────────────────── Agent 视图数据 ──────────────────────────

  /**
   * 某 Agent 目录的实际条目（绿/灰灯数据源）：每次调用实时 readdir + lstat，不加缓存。
   * 跳过 `.` 开头的条目（adopt 暂存位 `.adopt-old-*` 等管理性目录）。
   */
  listAgentSkills(agentId: string): AgentSkillEntry[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(agent.skillsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const libSkills = new Map(this.library.listSkills().map((s) => [s.dirName, s]));
    const out: AgentSkillEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(agent.skillsDir, entry.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue; // 竞态：读取瞬间被外部删除
      }
      if (st.isSymbolicLink()) {
        let resolved: string | null = null;
        try {
          resolved = resolveLinkPath(full, fs.readlinkSync(full));
        } catch {
          resolved = null;
        }
        const linkedDirName = resolved != null ? this.libraryLinkedDirName(resolved) : null;
        if (resolved != null && linkedDirName != null) {
          const dirName = linkedDirName;
          const summary = libSkills.get(dirName);
          const meta = summary ? null : readSkillMeta(this.library.skillsDir, dirName);
          const skillId = summary?.skillId ?? meta?.skillId ?? null;
          out.push({
            name: entry.name,
            entryType: 'link-to-library',
            isLibraryLink: true,
            skillId,
            missing: summary?.missing ?? !fs.existsSync(resolved),
          });
          continue;
        }
        out.push({ name: entry.name, entryType: 'link-elsewhere', isLibraryLink: false, skillId: null, missing: false });
        continue;
      }
      if (st.isDirectory()) {
        // 实体目录里的技能本身不是库链接（灰灯），skillId 不在此处猜测
        out.push({ name: entry.name, entryType: 'real-dir', isLibraryLink: false, skillId: null, missing: false });
        continue;
      }
      if (st.isFile()) {
        out.push({ name: entry.name, entryType: 'real-file', isLibraryLink: false, skillId: null, missing: false });
        continue;
      }
      out.push({ name: entry.name, entryType: 'other', isLibraryLink: false, skillId: null, missing: false });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /**
   * 跨机拉来的同步意图中尚未执行的项：只列出，绝不自动部署（PRD 5.5 / 5.10）。
   * 只统计启用且已安装的 Agent（未安装工具上的意图不显示为待执行）。
   */
  listPendingIntents(): PendingDeployIntent[] {
    const out: PendingDeployIntent[] = [];
    const skills = this.library.listSkills();
    for (const agent of this.agents.syncTargets()) {
      const pending: PendingIntentSkill[] = [];
      for (const skill of skills) {
        const intent = this.readIntent(skill.dirName);
        if (!intent.includes(agent.id)) continue;
        const target = this.resolveAgentTarget(agent, skill.dirName);
        const insp = inspectTarget(target);
        const deployed =
          insp.kind === 'link' && samePath(insp.resolvedTarget, this.librarySkillDir(skill.dirName));
        if (deployed) continue;
        pending.push({ skillId: skill.skillId, dirName: skill.dirName, name: skill.name });
      }
      if (pending.length > 0) out.push({ agentId: agent.id, agentName: agent.name, skills: pending });
    }
    return out;
  }

  /** 单点验证（供 UI 与测试查询真实链接状态，不看意图）。 */
  verifyDeployment(skillId: string, agentId: string): DeploymentVerification {
    const skill = this.findSkill(skillId);
    const agent = this.agents.get(agentId);
    if (!skill || !agent) {
      return { deployed: false, targetPath: '', targetKind: 'missing', actualTarget: null };
    }
    const target = this.resolveAgentTarget(agent, skill.dirName);
    const insp = inspectTarget(target);
    const srcDir = this.librarySkillDir(skill.dirName);
    return {
      deployed: insp.kind === 'link' && samePath(insp.resolvedTarget, srcDir),
      targetPath: target,
      targetKind: insp.kind,
      actualTarget: insp.resolvedTarget,
    };
  }

  // ────────────────────────── 路径解析 ──────────────────────────

  /**
   * 库内技能源目录（按索引 relPath 定位，支持一层组子目录；与重扫对账后的真实位置一致）。
   */
  private librarySkillDir(dirName: string): string {
    return this.library.skillDirOf(dirName);
  }

  /**
   * 链接目标是否指向中心库内某技能目录（平铺或一层组子目录）；是则返回 dirName。
   * 嵌套布局下链接目标形如 skills/<组>/<技能名>，不能用「父目录 = skillsDir」判定。
   */
  private libraryLinkedDirName(resolved: string): string | null {
    if (!isPathSafe(this.library.skillsDir, resolved)) return null;
    const rel = path.relative(this.library.skillsDir, resolved).split(path.sep).join('/');
    if (validateSkillRelPath(rel) !== rel) return null;
    return rel.split('/').pop() ?? null;
  }

  /**
   * 该技能在某 Agent 目录下的**实际**受管位置。
   *
   * 常规是平铺 `<agent>/skills/<dirName>`；但「入库」会把 Agent 目录里已嵌套的技能
   * 原位替换成链接（`group/a` → 库内 `a`），这类位置要在该 Agent 目录的一层子目录里回找。
   * 找不到时返回平铺路径，调用方按「不存在」处理（用于新建）。
   */
  private resolveAgentTarget(agent: AgentInfo, dirName: string): string {
    const srcDir = this.librarySkillDir(dirName);
    const flat = path.join(agent.skillsDir, dirName);
    // ① 落点记忆优先：上次同步/扫描记下的位置就是唯一定点（可能是两层 skills/<group>/<技能名>）
    const recorded = this.placement?.read(agent.id)[dirName];
    if (recorded != null) {
      const remembered = path.join(agent.skillsDir, ...recorded.split('/'));
      if (isPathInside(agent.skillsDir, remembered)) return remembered;
    }
    const flatInsp = inspectTarget(flat);
    if (flatInsp.kind !== 'missing') {
      // 平铺位置已有东西：是指向本技能的链接就用它，是别的东西也由调用方按冲突处理
      return flat;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(agent.skillsDir, { withFileTypes: true });
    } catch {
      return flat;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      const nested = path.join(agent.skillsDir, entry.name, dirName);
      const insp = inspectTarget(nested);
      if (insp.kind === 'link' && samePath(insp.resolvedTarget, srcDir)) return nested;
    }
    return flat;
  }

  /**
   * resolveAgentTarget 的异步版（判定逻辑与同步版保持一致）：批量探针专用，
   * 把落点表读取与 lstat/readdir 从同步等待改为并行 IO（首屏列表探针路径）。
   */
  private async resolveAgentTargetAsync(agent: AgentInfo, dirName: string): Promise<string> {
    const srcDir = this.librarySkillDir(dirName);
    const flat = path.join(agent.skillsDir, dirName);
    // ① 落点记忆优先（与同步版同口径）
    const recorded = (await this.placement?.readAsync(agent.id))?.[dirName];
    if (recorded != null) {
      const remembered = path.join(agent.skillsDir, ...recorded.split('/'));
      if (isPathInside(agent.skillsDir, remembered)) return remembered;
    }
    const flatInsp = await inspectTargetAsync(flat);
    if (flatInsp.kind !== 'missing') return flat;

    // ② 空缺时一层子目录回找（只认指向本技能的链接）
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(agent.skillsDir, { withFileTypes: true });
    } catch {
      return flat;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      const nested = path.join(agent.skillsDir, entry.name, dirName);
      const insp = await inspectTargetAsync(nested);
      if (insp.kind === 'link' && samePath(insp.resolvedTarget, srcDir)) return nested;
    }
    return flat;
  }

  /** 同步前补齐落点记忆：该 Agent 还没有表（或表为空）时，先扫一次它的目录写一份。 */
  private async ensurePlacement(agentIds: readonly string[]): Promise<void> {
    const store = this.placement;
    if (store == null) return;
    for (const agentId of new Set(agentIds)) {
      if (Object.keys(store.read(agentId)).length > 0) continue;
      const agent = this.agents.get(agentId);
      if (!agent || !agent.installed) continue;
      try {
        const plan = await scanLocalSkills({
          targets: [{ key: agent.id, label: agent.name, dir: agent.skillsDir }],
          centralSkillsDir: this.library.skillsDir,
          includeSynced: true,
        });
        store.writeAll(agentId, placementMapOf(plan.discovered, agent.id));
      } catch (err) {
        this.logger?.error('deploy:placement-scan-failed', { agentId, error: (err as Error).message });
      }
    }
  }

  /** 同步成功后把实际落点写回记忆；失败 / 冲突 / 跳过一律不写。 */
  private rememberDeployed(items: readonly DeployItemResult[]): void {
    const store = this.placement;
    if (store == null) return;
    for (const item of items) {
      if (item.status !== 'deployed' && item.status !== 'already') continue;
      const agent = this.agents.get(item.agentId);
      if (!agent || !item.targetPath) continue;
      const rel = path.relative(agent.skillsDir, item.targetPath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      store.set(item.agentId, item.dirName, rel.split(path.sep).join('/'));
    }
  }

  /** 中心库列表的部署状态叠加：deployedAgents = 意图 ∩ 实际链接。 */
  createProbe(): DeploymentStatusProbe {
    const verifyOne = (
      skill: Pick<SkillSummary, 'skillId' | 'dirName' | 'deployedAgents'>,
      intent: string[],
    ): { deployed: string[]; configured: string[] } => {
      const deployed: string[] = [];
      const configured: string[] = [];
      const srcDir = this.librarySkillDir(skill.dirName);
      for (const agentId of intent) {
        const agent = this.agents.get(agentId);
        if (!agent) continue; // 本机不存在的 Agent：意图只来自别的机器，过滤
        if (agent.enabled && agent.installed) configured.push(agentId);
        const insp = inspectTarget(this.resolveAgentTarget(agent, skill.dirName));
        if (insp.kind === 'link' && samePath(insp.resolvedTarget, srcDir)) deployed.push(agentId);
      }
      return { deployed, configured };
    };

    return {
      verify: (skill) => {
        // 意图的真相是元数据文件（随库进 Git）；索引里的 sync_json 是派生值，
        // 刚写完意图、尚未重扫时可能滞后，故以元数据为准、索引值兜底。
        const meta = readSkillMeta(this.library.skillsDir, skill.dirName);
        const intent = meta?.sync.agents ?? skill.deployedAgents ?? [];
        return verifyOne(skill, intent);
      },

      // 批量异步版：判定口径与 verify 完全一致，IO 全部并行（列表页首屏专用）。
      // 结果按 intent 顺序装配，与同步版逐条 push 的顺序一致。
      verifyBatch: async (skills) => {
        const metas = await Promise.all(
          skills.map((skill) => readSkillMetaAsync(this.library.skillsDir, skill.dirName)),
        );
        const resolved = await Promise.all(
          skills.map((skill, i) => {
            const intent = metas[i]?.sync.agents ?? skill.deployedAgents ?? [];
            return Promise.all(
              intent.map(async (agentId) => {
                const agent = this.agents.get(agentId);
                if (!agent) return { agentId, target: null as string | null, installed: false };
                const target = await this.resolveAgentTargetAsync(agent, skill.dirName);
                return { agentId, target, installed: agent.enabled && agent.installed };
              }),
            );
          }),
        );
        const out = new Map<string, { deployed: string[]; configured: string[] }>();
        for (let i = 0; i < skills.length; i++) {
          const srcDir = this.librarySkillDir(skills[i].dirName);
          // 二段并行：先并行 lstat 所有落点，再按 intent 顺序装配（与同步版顺序一致）
          const inspected = await Promise.all(
            resolved[i].map(async (item) => ({
              agentId: item.agentId,
              installed: item.installed,
              insp: item.target == null ? null : await inspectTargetAsync(item.target),
            })),
          );
          const deployed: string[] = [];
          const configured: string[] = [];
          for (const item of inspected) {
            if (item.insp == null) continue; // 本机不存在的 Agent：意图只来自别的机器，过滤
            if (item.installed) configured.push(item.agentId);
            if (item.insp.kind === 'link' && samePath(item.insp.resolvedTarget, srcDir)) deployed.push(item.agentId);
          }
          out.set(skills[i].skillId, { deployed, configured });
        }
        return out;
      },
    };
  }

  /**
   * 库内技能被手动挪位后的链接自愈：meta 里配置了同步 Agent，但该 Agent 目录里的
   * 链接仍指向库内旧位置（链接记录的是绝对路径，源目录移动后即过期）
   * → 删旧链接并重建到当前 relPath 位置。
   * 判定从紧：只修「目标在库 skills/ 内、末段 = 该技能 dirName、但路径 ≠ 当前位置」
   * 的过期链接；指向别处的链接一律不碰。轻量幂等（每次重扫后调用），不拿写锁：
   * 与 deploy/undeploy 的竞争窗口仅限「同一技能同一 Agent 同时操作」，两边最终
   * 都收敛到「链接指向库内当前位置」，交错无害。
   */
  async reconcileStaleLinks(): Promise<number> {
    let fixed = 0;
    for (const skill of this.library.listSkills()) {
      if (skill.missing) continue;
      const intent = readSkillMeta(this.library.skillsDir, skill.dirName)?.sync.agents ?? [];
      if (intent.length === 0) continue;
      const srcDir = this.librarySkillDir(skill.dirName);
      for (const agentId of intent) {
        const agent = this.agents.get(agentId);
        if (!agent) continue; // 本机不存在该 Agent：意图来自别的机器，无可修
        const target = this.resolveAgentTarget(agent, skill.dirName);
        const insp = inspectTarget(target);
        if (insp.kind !== 'link' || insp.resolvedTarget == null) continue;
        if (samePath(insp.resolvedTarget, srcDir)) continue; // 已指向当前位置
        if (this.libraryLinkedDirName(insp.resolvedTarget) !== skill.dirName) continue; // 非库内过期链接，不碰
        try {
          removeDirLink(target);
          ensureDir(path.dirname(target));
          createDirLink(srcDir, target);
          fixed++;
          this.logger?.info('deploy:link-relocated', {
            agentId,
            dirName: skill.dirName,
            from: insp.resolvedTarget,
            to: srcDir,
          });
        } catch (err) {
          // 单条失败不影响其余链接；下次重扫会再试
          this.logger?.info('deploy:link-relocate-failed', {
            agentId,
            dirName: skill.dirName,
            error: (err as Error).message,
          });
        }
      }
    }
    return fixed;
  }

  // ────────────────────────── 灰灯入库（adoptExisting） ──────────────────────────

  /**
   * 把 Agent 目录中的非库链接技能安全收入中心库，并把原位置替换为受管理链接。
   *
   * 顺序（任一失败都回滚，且回滚必须校验）：
   *  1) 同名同内容 → 复用库内已有技能；同名异内容 → 直接失败，库与原位置零改动；
   *  2) 库内无同名 → 复用 T02 导入服务复制入库，并校验库内副本内容哈希与源一致；
   *  3) 原位置 rename 到**同目录**暂存位（`.adopt-old-<uuid>`，在被重命名目录之外但同卷）；
   *  4) 建链并回读验证 → 成功后才删除暂存；
   *  5) 失败 → 删链接（只删链接）→ 暂存移回原位 → 校验恢复 → 撤销本次库内新增。
   *
   * 原位置是指向外部目录的链接时：rename 只移动链接本身，成功后也只删链接，绝不触碰其目标内容。
   */
  async adoptExisting(agentId: string, entries: string[]): Promise<AdoptResult[]> {
    return this.lock.runExclusive('adopt', async () => {
      const results: AdoptResult[] = [];
      for (const entry of entries) results.push(await this.adoptOne(agentId, entry));
      return results;
    });
  }

  /**
   * T13：Agents 页灰灯「入库」。
   * 与 adoptExisting 同一套安全流程（复制校验 → 暂存 → 建链 → 失败回滚），
   * 差别只在来源记录：type='agent-dir'、origin=Agent 标签（可跨机读，不写绝对路径），
   * 返回值收敛成 linked / reused / failed 三态供 UI 直接分支。
   */
  async adoptFromAgent(agentId: string, entry: string): Promise<AgentsAdoptResult> {
    return this.lock.runExclusive('adopt', async () => {
      const agent = this.agents.requireAgent(agentId);
      const raw = await this.adoptOne(agentId, entry, {
        type: `agent:${agentId}`,
        origin: agent.skillsDir,
        sourceRelPath: entry,
      });
      if (raw.status === 'adopted') {
        return {
          status: raw.reused ? 'reused' : 'linked',
          dirName: entry,
          skillId: raw.skillId,
          linkType: raw.linkType,
        };
      }
      if (raw.status === 'already-managed') {
        return { status: 'linked', dirName: entry, skillId: raw.skillId };
      }
      return {
        status: 'failed',
        dirName: entry,
        skillId: raw.skillId,
        reason: raw.reason,
        code: raw.code,
        restored: raw.restored,
      };
    });
  }

  private async adoptOne(
    agentId: string,
    entry: string,
    source?: { type: string; origin: string; sourceRelPath?: string },
  ): Promise<AdoptResult> {
    const agent = this.agents.get(agentId);
    if (!agent) return fail(entry, 'AGENT_NOT_FOUND', `Agent 不存在：${agentId}`);
    if (!agent.installed) return fail(entry, 'AGENT_NOT_INSTALLED', 'Agent 的 Skills 目录不存在');
    // 条目名可以是相对路径（嵌套目录 group/a），层数与扫描同一上限；越界与穿越一律拒绝
    if (validateSkillRelPath(entry) !== entry) {
      return fail(entry, 'INVALID_NAME', `非法的目录项名称：${JSON.stringify(entry)}`);
    }
    const sourceInfo = source ?? { type: `agent:${agent.id}`, origin: agent.skillsDir, sourceRelPath: entry };

    const target = path.join(agent.skillsDir, entry);
    const insp = inspectTarget(target);
    if (!insp.exists) return fail(entry, 'NOT_FOUND', `Agent 目录中不存在该项：${entry}`);

    // ── 1) 判定来源（实体目录 / 指向别处的链接）──
    let sourceDir: string;
    let sourceKind: 'dir' | 'link';
    if (insp.kind === 'link') {
      if (insp.resolvedTarget == null) return fail(entry, 'LINK_UNREADABLE', '无法读取链接目标');
      const linkedDirName = this.libraryLinkedDirName(insp.resolvedTarget);
      if (linkedDirName != null) {
        const dirName = linkedDirName;
        const summary = this.library.listSkills().find((s) => s.dirName === dirName);
        return {
          entry,
          status: 'already-managed',
          skillId: summary?.skillId ?? readSkillMeta(this.library.skillsDir, dirName)?.skillId ?? null,
        };
      }
      if (!fs.existsSync(insp.resolvedTarget) || !isDir(insp.resolvedTarget)) {
        return fail(entry, 'LINK_TARGET_MISSING', `链接目标不存在或不是目录：${insp.resolvedTarget}`);
      }
      sourceDir = insp.resolvedTarget;
      sourceKind = 'link';
    } else if (insp.kind === 'dir') {
      sourceDir = target;
      sourceKind = 'dir';
    } else {
      return fail(entry, 'NOT_A_SKILL', 'Agent 目录项不是目录（无法作为技能入库）');
    }
    if (!isSkillDir(sourceDir)) return fail(entry, 'NOT_A_SKILL', '不是技能目录（缺少 SKILL.md），无法入库');

    const md = readSkillMd(sourceDir)?.meta;
    // 无 frontmatter name 时用路径最后一段（嵌套条目 group/a → a），不用整串相对路径
    const cleaned = validateNewDirName(md?.name ?? path.basename(entry));
    if (cleaned == null) return fail(entry, 'INVALID_NAME', `技能名称清洗后无效：${JSON.stringify(md?.name ?? entry)}`);
    // 库内已有同名技能 → 沿用其现有位置（可能是手动分组后的一层子目录）；没有 → 平铺
    const destDir = libraryDestDirOf(this.library.skillsDir, cleaned);

    if (this.sources == null) {
      return fail(entry, 'ADOPT_UNSUPPORTED', '未注入导入服务，无法执行入库');
    }

    const sourceHash = hashSkillDir(sourceDir);

    // ── 2) 复制入库（同名同内容复用；同名异内容由导入服务判失败，零改动）──
    let skillId: string | null = null;
    let reused = false;
    try {
      const imported = await this.sources.importSkills([
        {
          path: sourceDir,
          source: sourceInfo,
          groups: adoptGroupsOf(entry),
        },
      ]);
      const item = imported.results[0];
      if (item == null || item.status === 'failed') {
        return {
          entry,
          status: 'failed',
          skillId: null,
          code: item?.code ?? 'ADOPT_IMPORT_FAILED',
          reason: item?.reason ?? '入库失败',
        };
      }
      skillId = item.skillId;
      reused = item.status === 'already-in-library';
    } catch (err) {
      return fail(entry, 'ADOPT_IMPORT_FAILED', `入库失败：${(err as Error).message}`);
    }
    if (skillId == null) return fail(entry, 'ADOPT_IMPORT_FAILED', '入库未返回 skillId');

    // ── 3) 校验库内副本可读且内容一致（复制完整性）──
    let libOk = false;
    try {
      libOk = isSkillDir(destDir) && !isDanglingLink(destDir) && hashSkillDir(destDir) === sourceHash;
    } catch {
      libOk = false;
    }
    if (!libOk) {
      const rolled = await this.rollbackLibraryCopy(skillId, cleaned, reused);
      return {
        entry,
        status: 'failed',
        skillId,
        code: 'COPY_VERIFY_FAILED',
        reason: `库内副本内容校验不一致${rolled ? '，已撤销本次新增' : '；撤销库内新增失败，请人工检查'}`,
        restored: rolled,
      };
    }

    if (this.adoptFailPoint === 'after-copy') {
      await this.rollbackLibraryCopy(skillId, cleaned, reused);
      return fail(entry, 'ADOPT_INJECTED_FAILURE', '注入失败（after-copy）：已撤销库内新增');
    }

    // ── 4) 暂存原位置（同卷同目录 rename；链接只移动链接本身）──
    const stagedPath = path.join(agent.skillsDir, `${this.adoptStagingPrefix}${crypto.randomUUID().slice(0, 8)}`);
    try {
      fs.renameSync(target, stagedPath);
    } catch (err) {
      await this.rollbackLibraryCopy(skillId, cleaned, reused);
      return fail(entry, 'ADOPT_STAGE_FAILED', `暂存原位置失败：${(err as Error).message}`);
    }

    let linkType: LinkType | undefined;
    try {
      if (this.adoptFailPoint === 'after-stage') throw new Error('注入失败（after-stage）：暂存后强制中止');

      ensureDir(agent.skillsDir);
      const created = createDirLink(destDir, target);
      linkType = created.linkType;

      const verify = inspectTarget(target);
      if (verify.kind !== 'link' || !samePath(verify.resolvedTarget, destDir)) {
        throw new LinkError(
          'LINK_VERIFY_FAILED',
          `建链后回读校验失败（lstat=${verify.kind}，指向 ${verify.resolvedTarget ?? 'null'}）`,
        );
      }
      if (this.adoptFailPoint === 'after-link') throw new Error('注入失败（after-link）：建链后强制中止');

      // ── 5) 成功：清暂存（目录递归删；链接只删链接）──
      try {
        if (sourceKind === 'link') removeDirLink(stagedPath);
        else fs.rmSync(stagedPath, { recursive: true, force: true });
      } catch (err) {
        this.logger?.error('adopt:staging-cleanup-failed', { entry, error: (err as Error).message });
      }

      this.addIntent(cleaned, agentId);
      this.library.appendEvent(skillId, 'deploy-status', `收录到中心库并同步到 ${agent.name}（${linkType}）`);
      this.logger?.info('adopt:success', { entry, skillId, reused, linkType, sourceKind });
      return { entry, status: 'adopted', skillId, reused, linkType };
    } catch (err) {
      const restored = await this.rollbackAdopt({
        agent,
        target,
        stagedPath,
        sourceKind,
        sourceHash,
        expectedLinkTarget: insp.resolvedTarget,
        skillId,
        dirName: cleaned,
        reused,
      });
      const code = (err as LinkError).code ?? 'ADOPT_FAILED';
      return {
        entry,
        status: 'failed',
        skillId,
        code: restored ? code : 'RESTORE_FAILED',
        reason: restored
          ? `入库失败，已恢复原位置并撤销库内新增：${(err as Error).message}`
          : `入库失败且恢复未通过校验，请人工检查：${(err as Error).message}`,
        restored,
      };
    }
  }

  /**
   * adopt 失败回滚：删链接（只删链接）→ 暂存移回原位 → **校验恢复** → 撤销库内新增。
   * 每步都如实反馈，任何一步无法确认恢复都返回 false（不能报成功）。
   */
  private async rollbackAdopt(ctx: {
    agent: AgentInfo;
    target: string;
    stagedPath: string;
    sourceKind: 'dir' | 'link';
    sourceHash: string;
    expectedLinkTarget: string | null;
    skillId: string;
    dirName: string;
    reused: boolean;
  }): Promise<boolean> {
    let ok = true;

    // a) 撤销已建链接：只删链接本身（此时它不是本技能的库链接，而是刚建的那条）
    const now = inspectTarget(ctx.target);
    if (now.kind === 'link') {
      try {
        removeDirLink(ctx.target);
      } catch (err) {
        ok = false;
        this.logger?.error('adopt:rollback-unlink-failed', { error: (err as Error).message });
      }
    } else if (now.exists && now.kind !== 'missing') {
      // 目标被意外替换成实体：不动它（宁可不恢复也不能删用户数据）
      ok = false;
      this.logger?.error('adopt:rollback-target-not-link', { kind: now.kind });
    }

    // b) 暂存移回原位
    const staged = inspectTarget(ctx.stagedPath);
    if (staged.exists) {
      try {
        fs.renameSync(ctx.stagedPath, ctx.target);
      } catch (err) {
        ok = false;
        this.logger?.error('adopt:rollback-restore-failed', { error: (err as Error).message });
      }
    } else {
      ok = false;
      this.logger?.error('adopt:rollback-staging-missing', { stagedPath: ctx.stagedPath });
    }

    // c) 校验恢复：实体目录比内容哈希，链接比目标路径
    const restored = inspectTarget(ctx.target);
    if (!restored.exists) {
      ok = false;
    } else if (ctx.sourceKind === 'link') {
      if (restored.kind !== 'link' || !samePath(restored.resolvedTarget, ctx.expectedLinkTarget)) ok = false;
    } else {
      try {
        if (restored.kind !== 'dir' || hashSkillDir(ctx.target) !== ctx.sourceHash) ok = false;
      } catch {
        ok = false;
      }
    }

    // d) 撤销本次新增的库内容（复用的情况不动库）
    const rolled = await this.rollbackLibraryCopy(ctx.skillId, ctx.dirName, ctx.reused);
    if (!rolled) ok = false;

    this.logger?.info('adopt:rollback', { target: ctx.target, restored: ok });
    return ok;
  }

  /** 删除本次 adopt 新增的库目录 + 元数据并重扫；复用（reused）时不删。返回是否确认已无残留。 */
  private async rollbackLibraryCopy(skillId: string, dirName: string, reused: boolean): Promise<boolean> {
    if (reused) return true;
    const dir = this.librarySkillDir(dirName);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(skillMetaPath(this.library.skillsDir, dirName), { force: true });
      await this.library.rescan();
    } catch (err) {
      this.logger?.error('adopt:library-rollback-failed', { skillId, error: (err as Error).message });
      return false;
    }
    const stillThere = fs.existsSync(dir) || this.library.listSkills().some((s) => s.skillId === skillId);
    return !stillThere;
  }

  // ────────────────────────── 内部工具 ──────────────────────────

  private findSkill(skillId: string): SkillSummary | null {
    return this.library.listSkills().find((s) => s.skillId === skillId) ?? null;
  }

  /** 目标不得等于源、不得在源内部，也不得包含源（两个方向都会造成递归自嵌套）。 */
  private checkRecursive(srcDir: string, target: string): string | null {
    if (samePath(srcDir, target)) return `目标路径与源技能目录相同：${target}`;
    if (isPathInside(srcDir, target)) return `目标路径位于源技能目录内部（会导致递归自嵌套）：${target}`;
    if (isPathInside(target, srcDir)) return `源技能目录位于目标路径内部（会成为自身内容的一部分）：${target}`;
    return null;
  }

  private readIntent(dirName: string): string[] {
    const meta = readSkillMeta(this.library.skillsDir, dirName);
    return meta?.sync.agents ?? [];
  }

  /** 把 agentId 记入同步意图（幂等）。返回是否发生真实变化。 */
  private addIntent(dirName: string, agentId: string): boolean {
    const meta = readSkillMeta(this.library.skillsDir, dirName);
    if (!meta) return false;
    if (meta.sync.agents.includes(agentId)) return false;
    meta.sync = { agents: [...meta.sync.agents, agentId] };
    // 部署状态变化不改 updatedAt（该字段语义是「内容/名称最后变化时间」，T01）
    this.library.writeExternalMeta(meta);
    return true;
  }

  private removeIntent(dirName: string, agentId: string): boolean {
    const meta = readSkillMeta(this.library.skillsDir, dirName);
    if (!meta) return false;
    if (!meta.sync.agents.includes(agentId)) return false;
    meta.sync = { agents: meta.sync.agents.filter((a) => a !== agentId) };
    this.library.writeExternalMeta(meta);
    return true;
  }
}

function summarize(items: DeployItemResult[]): Record<DeployItemStatus, number> {
  const out: Record<DeployItemStatus, number> = { deployed: 0, already: 0, conflict: 0, failed: 0, skipped: 0 };
  for (const it of items) out[it.status] += 1;
  return out;
}

function fail(entry: string, code: string, reason: string): AdoptResult {
  return { entry, status: 'failed', skillId: null, code, reason };
}

/** 入库时的自带标签：嵌套条目 `group/a` 的父目录名；一层直放没有标签。 */
function adoptGroupsOf(entry: string): string[] | undefined {
  const group = groupOfSkillRelPath(entry);
  return group != null ? [group] : undefined;
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 防御：库内目标若是悬空链接（异常状态），不能当副本用。 */
function isDanglingLink(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) return false;
    return !fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * 扫描结果 → 落点表。key 用库内目录名（与 `agents-skills/<agentId>.skills` 的键同一个口径）。
 * 同一技能在同一 Agent 出现多处时，按相对路径排序取第一个（「记录先扫描到的」，
 * 排序是为了让「先」可复现，不依赖文件系统的 readdir 顺序）。
 */
function placementMapOf(discovered: readonly DiscoveredToolSkill[], agentId: string): Record<string, string> {
  const picked = new Map<string, string>();
  const rows = discovered
    .filter((rec) => rec.tool === agentId)
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  for (const rec of rows) {
    const key = sanitizeName(rec.name);
    if (!key || picked.has(key)) continue;
    picked.set(key, rec.relPath.split(path.sep).join('/'));
  }
  return Object.fromEntries(picked);
}
