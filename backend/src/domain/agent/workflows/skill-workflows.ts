/**
 * T07：对话创建 / 改进 / 评测的业务编排（prd.md §5.4/§5.8/§5.9、tec.md §5.4/§5.8/§5.9）。
 *
 * 与 T06 的分工：
 *  - ConversationService = 通用会话与运行（Pi、工具边界、事件流、持久化）；
 *  - 本服务 = 三个工作流的业务语义：
 *      创建：校验目标名与重名 → 预建 `<库>/skills/<名>/` 并授权 → 运行结束后写元数据（source=conversation）+ rescan；
 *      改进：授权目标技能目录 → 运行 → rescan（内容哈希变化 → content-changed 事件）；
 *      评测：授权目录内可读写 → 运行结束后由**应用**把 assistant 最终文本原子写入 `<库>/reports/<技能名>_review_<时间戳>.md`；
 *  - 三个入口只生成「可编辑预填提示词」，**不启动运行**；运行必须显式调用 runXxx()。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SKILL_META_SCHEMA_VERSION, libraryDestDirOf, readSkillMeta, skillsDirJoin } from '../../../infra/fs-meta';
import { hashAndSizeSkillDir } from '../../content-hash';
import { isSkillDir, readSkillMd } from '../../frontmatter';
import { SkillLibraryService } from '../../library';
import { sanitizeName, validateNewDirName } from '../../path-guard';
import { generateSkillId } from '../../skill-id';
import type { SkillDetail, SkillMetadataFile, SkillSummary } from '../../types';
import { ConversationService } from '../conversation-service';
import { AgentRunError, asAgentError } from '../errors';
import type { AgentErrorCode, AgentSessionDetail, RunResult } from '../types';
import { buildBuiltinSkillSystemPrompt, buildFlowSystemPrompt, buildQuickActionPrompt, type QuickAction, type QuickPromptContext } from './quick-prompts';
import { EvalReportStore, type EvalReportStoreLike } from './report-store';

// ── 结果/事件类型 ──────────────────────────────────────────────────────────

/** 改进运行后内容确实变化（PRD 5.4：部署是链接，Agent 目录立即读到新内容）。 */
export interface ContentChangedEvent {
  type: 'content-changed';
  skillId: string;
  dirName: string;
  contentHash: string | null;
  at: string;
}

export type WorkflowEvent = ContentChangedEvent;

/** 库根会话（聊天页三个快捷入口）：授权到 `skills/` 根，不指定目标技能。 */
export interface LibraryConversation {
  action: QuickAction;
  sessionId: string;
  prompt: string;
  authorizedDir: string;
}

export interface CreateConversation {
  action: 'create';
  sessionId: string;
  /** 可编辑的预填提示词（未发送） */
  prompt: string;
  /** 清洗后的目标目录名 */
  targetName: string;
  authorizedDir: string;
}

export interface ImproveConversation {
  action: 'improve';
  sessionId: string;
  prompt: string;
  skillId: string;
  dirName: string;
  skillName: string;
  authorizedDir: string;
}

export interface EvaluateConversation {
  action: 'evaluate';
  sessionId: string;
  prompt: string;
  skillId: string;
  dirName: string;
  skillName: string;
  authorizedDir: string;
  /** 本次评测报告的目标位置（即使运行失败也保持不变） */
  reportPath: string;
  /** 运行前是否已有当前报告（决定是否显示「评测查看」） */
  hasReport: boolean;
}

export interface CreateRunOutcome {
  result: RunResult;
  dirName: string;
  authorizedDir: string;
  /** 运行后（含中断）若目录内已有 SKILL.md，则入索引并给出 ID */
  skillId: string | null;
  indexed: boolean;
  sourceType: string | null;
}

export interface ImproveRunOutcome {
  result: RunResult;
  /** 库根会话改动了多个技能时取第一个；没有改动为 null */
  skillId: string | null;
  dirName: string | null;
  /** 内容哈希是否变化（true 时已发出 content-changed 事件） */
  contentChanged: boolean;
  contentHash: string | null;
}

export interface EvaluateRunOutcome {
  result: RunResult;
  /** 库根会话不落盘报告，该字段为 null */
  skillId: string | null;
  reportPath: string | null;
  /** 本次是否成功替换报告（失败/中断/空文本均 false，旧报告保持原样） */
  saved: boolean;
  /** 应用层错误（provider 错误沿用 RunResult.error） */
  error: { code: AgentErrorCode; detail: string } | null;
  hasReport: boolean;
}

export interface SkillWorkflowServiceOptions {
  library: SkillLibraryService;
  conversations: ConversationService;
  /** 产品自带流程文本根目录（缺省自动定位 agents/skills） */
  resourcesDir?: string;
  /** 报告存储（测试可注入失败实现） */
  reports?: EvalReportStoreLike;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
}

// ── 服务 ──────────────────────────────────────────────────────────────────

export class SkillWorkflowService {
  readonly library: SkillLibraryService;
  readonly conversations: ConversationService;
  readonly reports: EvalReportStoreLike;
  private readonly resourcesDir: string | undefined;
  private readonly logger: SkillWorkflowServiceOptions['logger'];
  private readonly listeners = new Set<(event: WorkflowEvent) => void>();

  constructor(options: SkillWorkflowServiceOptions) {
    this.library = options.library;
    this.conversations = options.conversations;
    this.resourcesDir = options.resourcesDir;
    this.reports =
      options.reports ?? new EvalReportStore(path.join(this.library.libraryDir, 'reports'), (skillId) => this.library.getSkillDetail(skillId)?.name ?? null);
    this.logger = options.logger;
  }

  // ── 订阅（content-changed 等业务事件） ───────────────────────────────────

  subscribe(listener: (event: WorkflowEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── 快捷提示词 ───────────────────────────────────────────────────────────

  /** 三个快捷项的预填文本（纯文本，无副作用、不启动运行）。 */
  buildPrompt(action: QuickAction, ctx: QuickPromptContext = {}): string {
    return buildQuickActionPrompt(action, ctx);
  }

  /**
   * 库根会话（聊天页三个快捷入口）：授权到 `<库>/skills/` 根，不指定目标技能。
   * 提示词里不出现技能名，由 Agent 在库内自行定位；流程文本仍按 action 注入。
   */
  startLibraryConversation(action: QuickAction): LibraryConversation {
    this.requireModel();
    const authorizedDir = path.resolve(this.library.skillsDir);
    if (!isDirectory(authorizedDir)) {
      throw new AgentRunError('INVALID_SCOPE', `中心库 skills 目录不存在：${authorizedDir}`);
    }
    const title = action === 'create' ? '创建 Skill' : action === 'improve' ? '优化 Skill' : '评测 Skill';
    const session = this.conversations.createSession({
      authorizedDir,
      title,
      systemPrompt: buildFlowSystemPrompt(action, this.resourcesDir),
      workflow: action,
    });
    this.log('workflow:library-started', { sessionId: session.sessionId, action });
    return {
      action,
      sessionId: session.sessionId,
      prompt: buildQuickActionPrompt(action, { libraryScope: true }),
      authorizedDir,
    };
  }

  /** 给聊天页的库根会话绑定选定的内部 Skill，保留会话并切换流程。 */
  bindLibraryWorkflow(sessionId: string, action: QuickAction, skillName?: string): void {
    const detail = this.conversations.getSession(sessionId);
    if (!this.isLibraryRoot(detail.authorizedDir)) {
      throw new AgentRunError('TARGET_INVALID', '当前会话已绑定具体技能，请在新对话中选择其他内部 Skill');
    }
    const systemPrompt = skillName
      ? buildBuiltinSkillSystemPrompt(skillName, this.resourcesDir)
      : buildFlowSystemPrompt(action, this.resourcesDir);
    this.conversations.setWorkflow(sessionId, action, systemPrompt);
  }

  /**
   * 给聊天页的库根会话绑定**任意**内部 Skill（含用户随时投放进 `agents/skills` 的）：
   * 只注入它的流程正文，不继承上一次的创建/改进/评测归属。
   */
  bindInternalSkill(sessionId: string, skillName: string): void {
    const detail = this.conversations.getSession(sessionId);
    if (!this.isLibraryRoot(detail.authorizedDir)) {
      throw new AgentRunError('TARGET_INVALID', '当前会话已绑定具体技能，请在新对话中选择其他内部 Skill');
    }
    this.conversations.setWorkflow(
      sessionId,
      null,
      buildBuiltinSkillSystemPrompt(skillName, this.resourcesDir),
    );
  }

  // ── 创建（M9） ───────────────────────────────────────────────────────────

  /**
   * 创建入口：校验名称与重名 → 预建目标技能目录 → 建只写该目录的会话。
   * 只返回预填提示词，不运行 Agent（PRD 5.9「未发送提示词时不运行 Agent」）。
   */
  startCreateConversation(input: {
    targetName: string;
    /** 调用方声明的库路径；与当前服务不一致时拒绝，避免写错库 */
    libraryPath?: string | null;
    /** 恢复既有创建会话（重启后从原会话继续） */
    sessionId?: string | null;
    title?: string;
  }): CreateConversation {
    const dirName = validateTargetName(input.targetName);
    if (input.libraryPath != null && !samePath(input.libraryPath, this.library.libraryDir)) {
      throw new AgentRunError(
        'TARGET_INVALID',
        `目标库与当前打开的库不一致：${path.resolve(input.libraryPath)}`,
      );
    }
    // 库内已有同名技能（元数据存在）→ 授权目录 = 其现有位置（可能是手动分组后的一层子目录）
    const authorizedDir = libraryDestDirOf(this.library.skillsDir, dirName);

    if (input.sessionId) {
      const detail = this.assertWorkflow(input.sessionId, 'create');
      if (!samePath(detail.authorizedDir, authorizedDir)) {
        throw new AgentRunError('TARGET_INVALID', '该会话不是针对这个目标技能目录创建的');
      }
      this.requireModel();
      // 目录被外部删除时重建空目录（已写文件无法恢复，但不阻断继续）
      fs.mkdirSync(authorizedDir, { recursive: true });
      return this.createHandle(input.sessionId, dirName, authorizedDir);
    }

    this.assertNameAvailable(dirName);
    this.requireModel();

    // 校验通过后才落盘：非法名/重名/未配置模型都不留任何目录残骸
    fs.mkdirSync(authorizedDir, { recursive: true });
    const session = this.conversations.createSession({
      authorizedDir,
      title: input.title?.trim() || `创建技能：${dirName}`,
      systemPrompt: buildFlowSystemPrompt('create', this.resourcesDir),
      workflow: 'create',
    });
    this.log('workflow:create-started', { sessionId: session.sessionId, dirName });
    return this.createHandle(session.sessionId, dirName, authorizedDir);
  }

  private createHandle(sessionId: string, dirName: string, authorizedDir: string): CreateConversation {
    return {
      action: 'create',
      sessionId,
      prompt: buildQuickActionPrompt('create', { targetName: dirName }),
      targetName: dirName,
      authorizedDir,
    };
  }

  /** 显式运行创建会话；结束后若已生成 SKILL.md，则写 conversation 来源元数据并重扫入索引。 */
  async runCreate(sessionId: string, options: { prompt: string; modelId?: string }): Promise<CreateRunOutcome> {
    const detail = this.assertWorkflow(sessionId, 'create');
    const authorizedDir = detail.authorizedDir;
    this.assertInsideSkills(authorizedDir);
    const libraryScope = this.isLibraryRoot(authorizedDir);
    // 库根会话：运行前记下已有技能目录，运行后按新增目录判定创建结果
    const before = libraryScope ? this.listSkillDirNames() : null;

    const result = await this.conversations.startRun(sessionId, {
      prompt: options.prompt,
      modelId: options.modelId,
    });

    let dirName = path.basename(authorizedDir);
    let skillId: string | null = null;
    let indexed = false;
    let sourceType: string | null = null;
    if (libraryScope) {
      const createdDirs = [...this.listSkillDirNames()].filter((name) => !before!.has(name));
      if (createdDirs.length > 0) {
        dirName = createdDirs[0];
        const ensured = createdDirs.map((name) =>
          this.ensureConversationMeta(name, path.join(this.library.skillsDir, name)),
        );
        await this.library.rescan();
        const found = this.findByDirName(dirName);
        skillId = found?.skillId ?? ensured[0].meta.skillId;
        sourceType = found?.source?.type ?? ensured[0].meta.source.type;
        indexed = found != null;
        if (found && ensured[0].created) {
          this.library.appendEvent(found.skillId, 'created', `对话创建：${dirName}`);
        }
      }
    } else if (isSkillDir(authorizedDir)) {
      const ensured = this.ensureConversationMeta(dirName, authorizedDir);
      await this.library.rescan();
      const found = this.findByDirName(dirName);
      skillId = found?.skillId ?? ensured.meta.skillId;
      sourceType = found?.source?.type ?? ensured.meta.source.type;
      indexed = found != null;
      if (found && ensured.created) {
        this.library.appendEvent(found.skillId, 'created', `对话创建：${dirName}`);
      }
    }
    this.log('workflow:create-finished', {
      sessionId,
      dirName,
      status: result.status,
      indexed,
      skillId,
    });
    return { result, dirName, authorizedDir, skillId, indexed, sourceType };
  }

  // ── 改进（M4） ───────────────────────────────────────────────────────────

  startImproveConversation(
    skillId: string,
    options: { sessionId?: string | null } = {},
  ): ImproveConversation {
    const skill = this.requireSkill(skillId);
    const authorizedDir = this.skillDirPath(skill);
    this.requireModel();

    if (options.sessionId) {
      const detail = this.assertWorkflow(options.sessionId, 'improve');
      if (!samePath(detail.authorizedDir, authorizedDir)) {
        throw new AgentRunError('TARGET_INVALID', '该会话不是针对这个技能目录创建的');
      }
      return this.improveHandle(options.sessionId, skill, authorizedDir);
    }

    const session = this.conversations.createSession({
      authorizedDir,
      title: `优化 Skill：${skill.name}`,
      systemPrompt: buildFlowSystemPrompt('improve', this.resourcesDir),
      workflow: 'improve',
    });
    this.log('workflow:improve-started', { sessionId: session.sessionId, skillId });
    return this.improveHandle(session.sessionId, skill, authorizedDir);
  }

  private improveHandle(sessionId: string, skill: SkillDetail, authorizedDir: string): ImproveConversation {
    return {
      action: 'improve',
      sessionId,
      prompt: buildQuickActionPrompt('improve', {
        skillName: skill.name,
        skillId: skill.skillId,
        dirName: skill.dirName,
      }),
      skillId: skill.skillId,
      dirName: skill.dirName,
      skillName: skill.name,
      authorizedDir,
    };
  }

  /** 显式运行改进会话；运行后重扫，内容哈希变化时发出 content-changed 事件。 */
  async runImprove(sessionId: string, options: { prompt: string; modelId?: string }): Promise<ImproveRunOutcome> {
    const detail = this.assertWorkflow(sessionId, 'improve');
    if (this.isLibraryRoot(detail.authorizedDir)) return this.runImproveInLibrary(sessionId, options);
    const dirName = path.basename(detail.authorizedDir);
    const before = this.findByDirName(dirName);
    if (!before) {
      throw new AgentRunError('SKILL_NOT_FOUND', `库内找不到该技能目录：${dirName}`);
    }
    const beforeHash = this.library.getSkillDetail(before.skillId)?.contentHash ?? null;

    const result = await this.conversations.startRun(sessionId, {
      prompt: options.prompt,
      modelId: options.modelId,
    });
    await this.library.rescan();

    const after = this.findByDirName(dirName);
    const afterDetail = after ? this.library.getSkillDetail(after.skillId) : null;
    const contentHash = afterDetail?.contentHash ?? null;
    const contentChanged = afterDetail != null && beforeHash !== contentHash;
    if (contentChanged && afterDetail) {
      this.emit({
        type: 'content-changed',
        skillId: afterDetail.skillId,
        dirName: afterDetail.dirName,
        contentHash,
        at: new Date().toISOString(),
      });
    }
    this.log('workflow:improve-finished', {
      sessionId,
      dirName,
      status: result.status,
      contentChanged,
    });
    return {
      result,
      skillId: afterDetail?.skillId ?? before.skillId,
      dirName,
      contentChanged,
      contentHash,
    };
  }

  /**
   * 库根会话的改进运行：不知道目标技能，改为对比运行前后**全库**内容哈希，
   * 变化的技能逐个发 content-changed。
   */
  private async runImproveInLibrary(
    sessionId: string,
    options: { prompt: string; modelId?: string },
  ): Promise<ImproveRunOutcome> {
    const before = this.hashByDirName();
    const result = await this.conversations.startRun(sessionId, {
      prompt: options.prompt,
      modelId: options.modelId,
    });
    await this.library.rescan();

    const changed: { skillId: string; dirName: string; contentHash: string | null }[] = [];
    for (const [dirName, hash] of this.hashByDirName()) {
      if (!before.has(dirName) || before.get(dirName) === hash) continue;
      const found = this.findByDirName(dirName);
      if (!found) continue;
      changed.push({ skillId: found.skillId, dirName, contentHash: hash });
    }
    for (const item of changed) {
      this.emit({
        type: 'content-changed',
        skillId: item.skillId,
        dirName: item.dirName,
        contentHash: item.contentHash,
        at: new Date().toISOString(),
      });
    }
    const first = changed[0] ?? null;
    this.log('workflow:improve-finished', {
      sessionId,
      dirName: first?.dirName ?? null,
      libraryScope: true,
      changedCount: changed.length,
      status: result.status,
    });
    return {
      result,
      skillId: first?.skillId ?? null,
      dirName: first?.dirName ?? null,
      contentChanged: changed.length > 0,
      contentHash: first?.contentHash ?? null,
    };
  }

  // ── 评测（M8） ───────────────────────────────────────────────────────────

  startEvaluateConversation(
    skillId: string,
    options: { sessionId?: string | null } = {},
  ): EvaluateConversation {
    const skill = this.requireSkill(skillId);
    const authorizedDir = this.skillDirPath(skill);
    this.requireModel();
    const reportPath = this.reports.path(skill.skillId);
    const hasReport = this.reports.has(skill.skillId);

    if (options.sessionId) {
      const detail = this.assertWorkflow(options.sessionId, 'evaluate');
      if (!samePath(detail.authorizedDir, authorizedDir)) {
        throw new AgentRunError('TARGET_INVALID', '该会话不是针对这个技能目录创建的');
      }
      return this.evaluateHandle(options.sessionId, skill, authorizedDir, reportPath, hasReport);
    }

    const session = this.conversations.createSession({
      authorizedDir,
      title: `评测 Skill：${skill.name}`,
      systemPrompt: buildFlowSystemPrompt('evaluate', this.resourcesDir),
      workflow: 'evaluate',
    });
    this.log('workflow:evaluate-started', { sessionId: session.sessionId, skillId });
    return this.evaluateHandle(session.sessionId, skill, authorizedDir, reportPath, hasReport);
  }

  private evaluateHandle(
    sessionId: string,
    skill: SkillDetail,
    authorizedDir: string,
    reportPath: string,
    hasReport: boolean,
  ): EvaluateConversation {
    return {
      action: 'evaluate',
      sessionId,
      prompt: buildQuickActionPrompt('evaluate', {
        skillName: skill.name,
        skillId: skill.skillId,
        dirName: skill.dirName,
        hasReport,
      }),
      skillId: skill.skillId,
      dirName: skill.dirName,
      skillName: skill.name,
      authorizedDir,
      reportPath,
      hasReport,
    };
  }

  /**
   * 显式运行评测会话。报告由应用（而非模型）落盘：
   * 仅当运行 done 且捕获文本非空时原子写入 `reports/<技能名>_review_<时间戳>.md` 并清理旧报告；
   * 失败、中断、空文本、保存失败都保留旧报告。
   */
  async runEvaluate(sessionId: string, options: { prompt: string; modelId?: string }): Promise<EvaluateRunOutcome> {
    const detail = this.assertWorkflow(sessionId, 'evaluate');
    // 库根会话不指定目标技能 → 无可归属的报告文件，结论只留在对话里
    if (this.isLibraryRoot(detail.authorizedDir)) {
      const result = await this.conversations.startRun(sessionId, {
        prompt: options.prompt,
        modelId: options.modelId,
      });
      this.log('workflow:evaluate-finished', {
        sessionId,
        libraryScope: true,
        status: result.status,
        saved: false,
        code: result.error?.code ?? null,
      });
      return { result, skillId: null, reportPath: null, saved: false, error: result.error, hasReport: false };
    }
    const dirName = path.basename(detail.authorizedDir);
    const skill = this.findByDirName(dirName);
    if (!skill) throw new AgentRunError('SKILL_NOT_FOUND', `库内找不到该技能目录：${dirName}`);
    let reportPath = this.reports.path(skill.skillId);

    const result = await this.conversations.startRun(sessionId, {
      prompt: options.prompt,
      modelId: options.modelId,
    });

    let saved = false;
    let error: EvaluateRunOutcome['error'] = result.error;
    if (result.status === 'done') {
      error = null;
      const text = result.text ?? '';
      if (text.trim().length === 0) {
        error = {
          code: 'EVAL_REPORT_EMPTY',
          detail: '模型没有返回任何报告文本，已保留旧报告。',
        };
      } else {
        try {
          // 文件名带保存时刻的时间戳，返回给调用方的路径以实际落盘结果为准
          reportPath = this.reports.save(skill.skillId, text).path;
          saved = true;
        } catch (err) {
          const normalized = asAgentError(err, 'EVAL_SAVE_FAILED');
          error = {
            code: normalized.code === 'EVAL_REPORT_EMPTY' ? 'EVAL_REPORT_EMPTY' : 'EVAL_SAVE_FAILED',
            detail: normalized.detail,
          };
        }
      }
    }
    this.log('workflow:evaluate-finished', {
      sessionId,
      skillId: skill.skillId,
      status: result.status,
      saved,
      code: error?.code ?? null,
    });
    return {
      result,
      skillId: skill.skillId,
      reportPath,
      saved,
      error,
      hasReport: this.reports.has(skill.skillId),
    };
  }

  /** 「评测查看」入口：有当前报告才返回内容。 */
  readReport(skillId: string): { path: string; text: string } | null {
    if (!this.reports.has(skillId)) return null;
    const text = this.reports.read(skillId);
    if (text == null) return null;
    return { path: this.reports.path(skillId), text };
  }

  hasReport(skillId: string): boolean {
    return this.reports.has(skillId);
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  /** 校验会话归属，避免把「改进」会话当「创建」运行而改写技能来源。 */
  private assertWorkflow(sessionId: string, expected: 'create' | 'improve' | 'evaluate'): AgentSessionDetail {
    const detail = this.conversations.getSession(sessionId);
    if (detail.workflow != null && detail.workflow !== expected) {
      throw new AgentRunError(
        'TARGET_INVALID',
        `该会话属于「${detail.workflow}」工作流，不能用于「${expected}」操作`,
      );
    }
    return detail;
  }

  private requireModel(): void {
    // 未配置供应商/模型/凭据 → NO_MODEL_CONFIGURED（带设置引导），三个入口语义一致
    this.conversations.providers.getSelection();
  }

  private requireSkill(skillId: string): SkillDetail {
    const skill = this.library.getSkillDetail(skillId);
    if (!skill) throw new AgentRunError('SKILL_NOT_FOUND', `技能不存在：${skillId}`);
    if (skill.missing) {
      throw new AgentRunError('SKILL_NOT_FOUND', `技能目录已丢失：${skill.dirName}（请从备份恢复或移除）`);
    }
    return skill;
  }

  private skillDirPath(skill: SkillDetail): string {
    const dir = skillsDirJoin(this.library.skillsDir, skill.relPath);
    if (!isDirectory(dir)) {
      throw new AgentRunError('SKILL_NOT_FOUND', `技能目录不存在：${skill.dirName}`);
    }
    return dir;
  }

  /** 会话授权目录是否就是 `skills/` 根（聊天页快捷入口的库根会话）。 */
  private isLibraryRoot(dir: string): boolean {
    return samePath(dir, this.library.skillsDir);
  }

  /** `skills/` 下现有一层技能目录名（含 SKILL.md）。 */
  private listSkillDirNames(): Set<string> {
    const out = new Set<string>();
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.library.skillsDir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (name.endsWith('.skill.json')) continue;
      if (isSkillDir(path.join(this.library.skillsDir, name))) out.add(name);
    }
    return out;
  }

  /** 全库 contentHash 快照（dirName → hash），用于库根改进会话的前后对比。 */
  private hashByDirName(): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const skill of this.library.listSkills()) {
      out.set(skill.dirName, this.library.getSkillDetail(skill.skillId)?.contentHash ?? null);
    }
    return out;
  }

  private assertInsideSkills(dir: string): void {
    const base = path.resolve(this.library.skillsDir);
    const target = path.resolve(dir);
    const b = process.platform === 'win32' ? base.toLowerCase() : base;
    const t = process.platform === 'win32' ? target.toLowerCase() : target;
    if (t !== b && !t.startsWith(b.endsWith(path.sep) ? b : b + path.sep)) {
      throw new AgentRunError('INVALID_SCOPE', `创建会话的目录不在中心库 skills/ 下：${dir}`);
    }
  }

  /** 目标名可用性：索引内同名/同目录名或磁盘上已有同名目录 → NAME_CONFLICT。 */
  private assertNameAvailable(dirName: string): void {
    const wanted = dirName.toLowerCase();
    for (const skill of this.library.listSkills()) {
      if (skill.dirName.toLowerCase() === wanted || skill.name.toLowerCase() === wanted) {
        throw new AgentRunError(
          'NAME_CONFLICT',
          `中心库已存在同名技能：${skill.dirName}（请换一个名称，或对该技能使用「改进」）`,
        );
      }
    }
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.library.skillsDir);
    } catch {
      entries = [];
    }
    const clash = entries.find(
      (name) => !name.endsWith('.skill.json') && name.toLowerCase() === wanted,
    );
    if (clash) {
      throw new AgentRunError(
        'NAME_CONFLICT',
        `中心库 skills/ 下已存在同名目录：${clash}（可能是上次中断的创建，请在原会话继续）`,
      );
    }
  }

  private findByDirName(dirName: string): SkillSummary | null {
    const wanted = dirName.toLowerCase();
    return this.library.listSkills().find((s) => s.dirName.toLowerCase() === wanted) ?? null;
  }

  /**
   * 创建出的技能目录写入「对话创建」来源的元数据（在 rescan 之前写，
   * 否则 rescan 会按「扫描入库」生成 scan 来源）。
   */
  private ensureConversationMeta(
    dirName: string,
    dir: string,
  ): { meta: SkillMetadataFile; created: boolean } {
    const now = new Date().toISOString();
    const md = readSkillMd(dir);
    const { hash, sizeBytes } = hashAndSizeSkillDir(dir);
    const frontmatterName = md?.meta.name ? sanitizeName(md.meta.name).trim() : '';
    const name = frontmatterName.length > 0 ? frontmatterName : dirName;
    const nameSource = frontmatterName.length > 0 ? 'frontmatter' : 'dirname';
    const description = md?.meta.description ?? '';

    const existing = readSkillMeta(this.library.skillsDir, dirName);
    if (existing) {
      let dirty = false;
      if (existing.source?.type !== 'conversation') {
        existing.source = { ...existing.source, type: 'conversation', importedAt: existing.source?.importedAt ?? now };
        dirty = true;
      }
      if (existing.contentHash !== hash) {
        existing.contentHash = hash;
        existing.contentHashAt = now;
        existing.sizeBytes = sizeBytes;
        existing.updatedAt = now;
        dirty = true;
      }
      if (existing.name !== name || existing.description !== description || existing.nameSource !== nameSource) {
        existing.name = name;
        existing.description = description;
        existing.nameSource = nameSource;
        existing.updatedAt = now;
        dirty = true;
      }
      if (dirty) this.library.writeExternalMeta(existing);
      return { meta: existing, created: false };
    }

    const meta: SkillMetadataFile = {
      schemaVersion: SKILL_META_SCHEMA_VERSION,
      skillId: generateSkillId(),
      dirName,
      relPath: dirName,
      name,
      nameSource,
      description,
      groups: [],
      source: { type: 'conversation', importedAt: now },
      sync: { agents: [] },
      contentHash: hash,
      contentHashAt: now,
      sizeBytes,
      addedAt: now,
      updatedAt: now,
    };
    this.library.writeExternalMeta(meta);
    return { meta, created: true };
  }

  private emit(event: WorkflowEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger?.error('workflow-listener-failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private log(event: string, data?: unknown): void {
    this.logger?.info(event, data);
  }
}

// ── 辅助 ──────────────────────────────────────────────────────────────────

/**
 * 创建目标名校验（复用 path-guard 清洗规则并收紧为「拒绝而非静默改写」）：
 * 空值、`.`/`..`、Windows 非法字符、首尾空白/点、会触发清洗改写的名称、Windows 保留名一律拒绝。
 */
export function validateTargetName(raw: string): string {
  const input = String(raw ?? '');
  if (input.trim().length === 0) {
    throw new AgentRunError('TARGET_INVALID', '目标技能名不能为空');
  }
  if (input !== input.trim()) {
    throw new AgentRunError('TARGET_INVALID', `目标技能名首尾不能有空白：${JSON.stringify(input)}`);
  }
  if (input === '.' || input === '..' || /^\.+$/.test(input)) {
    throw new AgentRunError('TARGET_INVALID', `目标技能名不能是相对路径记号：${input}`);
  }
  if (/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(input)) {
    throw new AgentRunError('TARGET_INVALID', `目标技能名包含非法字符：${input}`);
  }
  const cleaned = validateNewDirName(input);
  if (!cleaned) {
    throw new AgentRunError('TARGET_INVALID', `目标技能名不合法：${input}`);
  }
  if (cleaned !== input) {
    throw new AgentRunError(
      'TARGET_INVALID',
      `目标技能名不符合目录命名规则（首尾点、Windows 保留名或长度超限）：${input}`,
    );
  }
  if ([...input].length > 100) {
    throw new AgentRunError('TARGET_INVALID', `目标技能名过长（最多 100 字符）：${input}`);
  }
  return input;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
