/**
 * 技能删除（prd.md §5.1 / §5.8 / §5.14、tec.md §5.14、用例 C-31）。
 *
 * 语义（与 GUI 行菜单删除、CLI `skills remove` 完全一致，只有一条写路径）：
 *  1. **先撤下受管理链接**：只删「确认指向本技能库目录」的链接；实体目录、文件、
 *     指向别处的链接一律保留并如实报告（skippedTargets），绝不删除非归属内容。
 *  2. **再删库内技能目录 + 元数据文件 + reports/<技能名>_review_*.md**，然后重扫索引。
 *  3. 事件：近期动态没有 deleted 类型，删除**不伪造事件**（append-only 历史保留该技能旧事件）。
 *
 * 整个删除在跨进程写锁内执行（CLI 与 GUI 共用同一把锁），避免另一端正在部署/导入时互踩。
 * 撤下链接复用 SkillDeployService.undeploy：意图维护、事件、链接归属判定全部沿用 T03 实现，
 * 不另写一套（锁可重入，嵌套调用安全）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WriteLock } from '../infra/write-lock';
import { deleteSkillMeta, skillMetaPath, skillsDirJoin } from '../infra/fs-meta';
import { inspectTarget, samePath } from '../infra/link-manager';
import { validateSkillRelPath } from './path-guard';
import { EvalReportStore } from './agent/workflows/report-store';
import { AgentConfigService } from './agents';
import { SkillDeployService } from './deploy-service';
import { SkillLibraryService } from './library';
import type { RemoveLinkMethod } from '../infra/link-manager';
import type { SkillSummary } from './types';

/** 结构化删除错误（CLI 输出 code + detail）。 */
export class SkillRemovalError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'SkillRemovalError';
  }
}

export type RemovalTargetKind = 'link-to-skill' | 'dir' | 'file' | 'link-elsewhere' | 'other';

/** 一个 Agent 目录项在删除计划中的判定结果。 */
export interface RemovalTarget {
  agentId: string;
  agentName: string;
  targetPath: string;
  targetKind: RemovalTargetKind;
  /** 保留项的原因（removable 时为空） */
  reason?: string;
  code?: string;
}

/** 删除计划（只读）：供 GUI 二次确认与 CLI 无 --yes 时说明「将撤下 N 个链接」。 */
export interface RemovalPlan {
  skillId: string;
  dirName: string;
  name: string;
  /** 确认指向本技能、将被撤下的链接 */
  linksToRemove: RemovalTarget[];
  /** 存在但不是本技能链接 → 保留并报告 */
  skippedTargets: RemovalTarget[];
  reportPath: string;
  hasReport: boolean;
  dirExists: boolean;
}

export interface RemovedLinkDetail {
  agentId: string;
  agentName: string;
  targetPath: string;
  removedVia: RemoveLinkMethod;
}

export interface RemoveSkillResult {
  skillId: string;
  dirName: string;
  name: string;
  /** 实际撤下的受管理链接数（prd.md §5.1「撤下多少个受管理链接」） */
  removedLinks: number;
  removedLinkDetails: RemovedLinkDetail[];
  /** 非归属目标：原样保留 */
  skippedTargets: RemovalTarget[];
  reportDeleted: boolean;
  metadataDeleted: boolean;
  libraryDirDeleted: boolean;
  /** 删除后重扫得到的库内技能数 */
  remainingSkills: number;
}

export interface SkillRemovalServiceOptions {
  library: SkillLibraryService;
  agents: AgentConfigService;
  /** 撤下链接复用部署服务（同一套归属判定与事件） */
  deploy: SkillDeployService;
  lock: WriteLock;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
}

export class SkillRemovalService {
  private readonly library: SkillLibraryService;
  private readonly agents: AgentConfigService;
  private readonly deploy: SkillDeployService;
  private readonly lock: WriteLock;
  private readonly logger: SkillRemovalServiceOptions['logger'];

  constructor(opts: SkillRemovalServiceOptions) {
    this.library = opts.library;
    this.agents = opts.agents;
    this.deploy = opts.deploy;
    this.lock = opts.lock;
    this.logger = opts.logger;
  }

  // ────────────────────────── 计划（只读） ──────────────────────────

  /** 统计删除影响面：不写任何文件，可安全用于「确认前」提示。 */
  planRemoval(skillId: string): RemovalPlan {
    const skill = this.library.getSkillDetail(skillId);
    if (!skill) throw new SkillRemovalError('SKILL_NOT_FOUND', `技能不存在：${skillId}`);
    return this.planFor(skill);
  }

  private planFor(skill: SkillSummary): RemovalPlan {
    const srcDir = skillsDirJoin(this.library.skillsDir, skill.relPath);
    const linksToRemove: RemovalTarget[] = [];
    const skippedTargets: RemovalTarget[] = [];

    // 遍历**全部**已知 Agent（含停用），因为链接可能由别处创建而不在同步意图里
    for (const agent of this.agents.list()) {
      const targetPath = path.join(agent.skillsDir, skill.dirName);
      let insp;
      try {
        insp = inspectTarget(targetPath);
      } catch {
        continue; // 读不到就跳过：删除流程不因单个 Agent 目录异常而中断
      }
      if (!insp.exists) continue;

      if (insp.kind === 'link' && samePath(insp.resolvedTarget, srcDir)) {
        linksToRemove.push({ agentId: agent.id, agentName: agent.name, targetPath, targetKind: 'link-to-skill' });
        continue;
      }
      if (insp.kind === 'link') {
        skippedTargets.push({
          agentId: agent.id,
          agentName: agent.name,
          targetPath,
          targetKind: 'link-elsewhere',
          code: 'TARGET_REPLACED',
          reason: `目标是指向别处的链接（${insp.resolvedTarget ?? '未知'}），未删除`,
        });
        continue;
      }
      const kind: RemovalTargetKind =
        insp.kind === 'dir' ? 'dir' : insp.kind === 'file' ? 'file' : 'other';
      skippedTargets.push({
        agentId: agent.id,
        agentName: agent.name,
        targetPath,
        targetKind: kind,
        code: 'TARGET_REPLACED',
        reason:
          kind === 'dir'
            ? '目标是实体目录（非本应用的受管理链接），未删除'
            : '目标不是本应用的受管理链接，未删除',
      });
    }

    const reportStore = new EvalReportStore(path.join(this.library.libraryDir, 'reports'), (id) => this.library.getSkillDetail(id)?.name ?? null);
    return {
      skillId: skill.skillId,
      dirName: skill.dirName,
      name: skill.name,
      linksToRemove,
      skippedTargets,
      reportPath: reportStore.path(skill.skillId),
      hasReport: reportStore.has(skill.skillId),
      dirExists: fs.existsSync(srcDir),
    };
  }

  // ────────────────────────── 执行 ──────────────────────────

  /**
   * 删除技能：撤下链接 → 删报告 → 删技能目录 → 删元数据 → 重扫索引。
   * 返回真实计数；非归属目标保留并列入 skippedTargets。
   */
  async removeSkill(skillId: string): Promise<RemoveSkillResult> {
    return this.lock.runExclusive('remove-skill', async () => {
      // 索引可能滞后于另一端的写入：先对账，避免拿过期 dirName/意图做删除
      await this.library.rescan();
      const skill = this.library.getSkillDetail(skillId);
      if (!skill) throw new SkillRemovalError('SKILL_NOT_FOUND', `技能不存在：${skillId}`);

      const plan = this.planFor(skill);
      const skippedTargets: RemovalTarget[] = [...plan.skippedTargets];
      const removedLinkDetails: RemovedLinkDetail[] = [];

      // 1) 撤下受管理链接（只删确认指向本技能的链接）
      for (const target of plan.linksToRemove) {
        const res = await this.deploy.undeploy(skillId, target.agentId);
        if (res.status === 'removed') {
          removedLinkDetails.push({
            agentId: target.agentId,
            agentName: target.agentName,
            targetPath: target.targetPath,
            removedVia: res.removedVia ?? 'unlink',
          });
        } else if (res.status === 'noop') {
          // 计划与实际之间被外部改掉：目标已不存在，不算撤下也不算跳过
          this.logger?.info('remove:link-vanished', { skillId, agentId: target.agentId });
        } else {
          skippedTargets.push({
            agentId: target.agentId,
            agentName: target.agentName,
            targetPath: target.targetPath,
            targetKind: 'other',
            code: res.code ?? 'TARGET_REPLACED',
            reason: res.reason ?? '链接撤下失败，已保留',
          });
        }
      }

      // 2) 删除当前评测报告（reports/<技能名>_review_*.md；不存在则为 false）
      const reportStore = new EvalReportStore(path.join(this.library.libraryDir, 'reports'), (id) => this.library.getSkillDetail(id)?.name ?? null);
      const reportDeleted = reportStore.has(skillId) ? reportStore.remove(skillId) : false;

      // 3) 删除库内技能目录（守卫：relPath 必须 1-2 段且落在 skills/ 内，绝不影响别处）
      const dir = skillsDirJoin(this.library.skillsDir, skill.relPath);
      this.assertOwnedSkillDir(dir, skill.relPath);
      const libraryDirDeleted = fs.existsSync(dir);
      if (libraryDirDeleted) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          throw new SkillRemovalError(
            'SKILL_DELETE_FAILED',
            `删除技能目录失败（可能被其他程序占用）：${(err as Error).message}`,
          );
        }
      }

      // 4) 删除元数据文件（否则会被重扫当成「已丢失」永久保留）
      deleteSkillMeta(this.library.skillsDir, skill.dirName);
      const metadataDeleted = !fs.existsSync(skillMetaPath(this.library.skillsDir, skill.dirName));

      // 5) 重扫：索引清理是派生的，必须在真相改完后执行
      const rescan = await this.library.rescan();

      // 6) 不伪造事件：ActivityType 没有 deleted，近期动态保留该技能的历史记录
      this.logger?.info('remove:done', {
        skillId,
        dirName: skill.dirName,
        removedLinks: removedLinkDetails.length,
        skipped: skippedTargets.length,
        reportDeleted,
      });

      return {
        skillId,
        dirName: skill.dirName,
        name: skill.name,
        removedLinks: removedLinkDetails.length,
        removedLinkDetails,
        skippedTargets,
        reportDeleted,
        metadataDeleted,
        libraryDirDeleted,
        remainingSkills: rescan.total,
      };
    });
  }

  /**
   * 目录守卫：relPath 必须是合法技能路径（1-2 段、无穿越、拒绝 .meta 等点开头段），
   * 且 dir 必须正好等于 skills/<relPath>（防御元数据被改坏时的越界删除）。
   */
  private assertOwnedSkillDir(dir: string, relPath: string): void {
    if (
      validateSkillRelPath(relPath) !== relPath ||
      path.resolve(dir) !== path.resolve(skillsDirJoin(this.library.skillsDir, relPath))
    ) {
      throw new SkillRemovalError('TARGET_INVALID', `技能目录不在库内，拒绝删除：${dir}`);
    }
  }
}
