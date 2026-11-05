/**
 * 中心库路径迁移（T10：tec.md §5.11「库路径迁移是事务性动作」）。
 *
 * 顺序（任一步失败 → 回退旧路径并恢复链接，绝不让用户处于半迁移状态）：
 *  1) 校验目标：可写、不是当前库、不与当前库互相嵌套；非空须显式选择「空目录」或「合并」；
 *  2) 合并预检：同名技能内容不同 → 直接拒绝，零改动（不静默覆盖）；
 *  3) 迁移 skills/、reports/、library.json、.skills-sync/ 到目标；
 *  4) 更新本机配置（app-state.json 的 libraryPath）并切换库服务到新路径；
 *  5) **按同步意图重建全部链接**——junction 存的是绝对路径，路径一变全部失效；
 *  6) 校验（库内技能数 + 每条意图链接的 lstat/readlink 指向新路径）；成功后清理旧库内容。
 *
 * 注入点 failPoint 仅测试使用，用于验证每个阶段失败都能回退。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SKILL_META_DIRNAME, readSkillMeta, listMetaDirNames, skillsDirJoin, skillsDirOf } from '../infra/fs-meta';
import {
  createDirLink,
  ensureDir,
  inspectTarget,
  isPathInside,
  removeDirLink,
  samePath,
} from '../infra/link-manager';
import type { AgentConfigService } from './agents';
import type { AppStateService } from './app-state';
import { hashSkillDir } from './content-hash';
import type {
  LibraryChangeDirectoryResult,
  LibraryMigrationLinkItem,
  LibraryMigrationLinkSummary,
  LibraryMigrationPolicy,
} from '../shared/ipc';

export interface LibraryMigrationOptions {
  /** 本机数据目录（本机配置写在这里） */
  dataDir: string;
  /** 当前中心库目录 */
  libraryDir: string;
  agents: AgentConfigService;
  state: AppStateService;
  /**
   * 切换库服务到指定目录（由宿主提供：关闭旧库服务、按新路径重建并重扫）。
   * 迁移期间迁移服务不持有库服务实例，避免读到已关闭的连接。
   */
  switchLibrary: (dir: string) => Promise<void>;
  failPoint?: 'after-copy' | 'after-config' | 'after-link' | 'after-verify' | null;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
}

interface IntentEntry {
  dirName: string;
  /** 技能相对 skills 根的位置（迁移后链接源按它定位） */
  relPath: string;
  skillId: string;
  agentIds: string[];
}

const MANAGED_ENTRIES = ['skills', 'reports', 'library.json', '.skills-sync'] as const;

export class LibraryMigrationService {
  private readonly opts: LibraryMigrationOptions;

  constructor(opts: LibraryMigrationOptions) {
    this.opts = opts;
  }

  /** 当前库路径（迁移成功后变化）。 */
  get libraryDir(): string {
    return this.opts.libraryDir;
  }

  async change(targetDirRaw: string, policy?: LibraryMigrationPolicy): Promise<LibraryChangeDirectoryResult> {
    const from = path.resolve(this.opts.libraryDir);
    const targetInput = String(targetDirRaw ?? '').trim();
    if (!targetInput) {
      return { status: 'failed', libraryPath: from, targetDir: targetInput, error: '目标目录为空', errorCode: 'BAD_REQUEST' };
    }
    const to = path.resolve(targetInput);
    const base = { libraryPath: from, targetDir: to };

    // ── 1) 目标合法性 ──
    const invalid = validateTarget(from, to);
    if (invalid) return { status: 'failed', ...base, error: invalid.detail, errorCode: invalid.code };

    try {
      fs.mkdirSync(to, { recursive: true });
    } catch (err) {
      return {
        status: 'failed',
        ...base,
        error: `目标目录不可创建：${(err as Error).message}`,
        errorCode: 'TARGET_NOT_WRITABLE',
      };
    }
    const writable = probeWritable(to);
    if (writable !== null) {
      return { status: 'failed', ...base, error: `目标目录不可写：${writable}`, errorCode: 'TARGET_NOT_WRITABLE' };
    }

    const existing = listEntries(to);
    if (existing.length > 0) {
      if (policy == null) return { status: 'needs-policy', ...base };
      if (policy === 'empty') {
        return {
          status: 'failed',
          ...base,
          error: '目标目录不是空目录：请选择「空目录」以外的处理方式，或改选其他目录',
          errorCode: 'TARGET_NOT_EMPTY',
        };
      }
      if (policy !== 'merge') {
        return { status: 'failed', ...base, error: `未知的迁移策略：${policy}`, errorCode: 'BAD_REQUEST' };
      }
    }

    // ── 2) 合并预检（零写入）──
    if (policy === 'merge') {
      const conflict = this.precheckMerge(from, to);
      if (conflict) return { status: 'failed', ...base, error: conflict, errorCode: 'MERGE_CONFLICT' };
    }

    const intents = this.collectIntents(from);
    const prevLibraryPath = this.opts.state.get().libraryPath;
    const copied: string[] = [];
    const createdLinks: string[] = [];
    const removedLinks: { targetPath: string; oldTarget: string }[] = [];

    try {
      // ── 3) 迁移文件 ──
      const movedSkills = copyLibrary(from, to, copied);
      if (this.opts.failPoint === 'after-copy') throw new Error('注入失败（after-copy）');

      // ── 4) 更新本机配置 ──
      this.opts.state.setLibraryPath(to);
      if (this.opts.failPoint === 'after-config') throw new Error('注入失败（after-config）');
      await this.opts.switchLibrary(to);

      // ── 5) 按同步意图重建全部链接 ──
      const links = this.rebuildLinks(intents, to, from, createdLinks, removedLinks);
      if (this.opts.failPoint === 'after-link') throw new Error('注入失败（after-link）');

      // ── 6) 校验 ──
      this.verify(intents, to, links);
      if (this.opts.failPoint === 'after-verify') throw new Error('注入失败（after-verify）');

      const warning = cleanupOldLibrary(from);
      this.opts.logger?.info('library:migration-done', { from, to, movedSkills });
      return { status: 'moved', libraryPath: to, targetDir: to, movedSkills, links, warning };
    } catch (err) {
      const detail = (err as Error).message;
      this.opts.logger?.error('library:migration-failed', { from, to, error: detail });
      const rolledBack = await this.rollback({
        from,
        to,
        intents,
        copied,
        createdLinks,
        removedLinks,
        prevLibraryPath,
      });
      return {
        status: 'failed',
        libraryPath: rolledBack ? from : path.resolve(this.opts.state.get().libraryPath ?? from),
        targetDir: to,
        rolledBack,
        error: rolledBack ? `迁移失败，已回退到原库路径：${detail}` : `迁移失败且回退未完成，请人工检查：${detail}`,
        errorCode: 'MIGRATION_FAILED',
      };
    }
  }

  // ────────────────────────── 校验 ──────────────────────────

  /** 合并预检：同名技能内容不同 → 拒绝；内容相同 → 视为已存在，跳过。 */
  private precheckMerge(from: string, to: string): string | null {
    const fromSkills = skillsDirOf(from);
    const toSkills = skillsDirOf(to);
    if (!fs.existsSync(fromSkills)) return null;
    const conflicts: string[] = [];
    for (const entry of fs.readdirSync(fromSkills, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === SKILL_META_DIRNAME) continue;
      const dest = path.join(toSkills, entry.name);
      if (!fs.existsSync(dest)) continue;
      const same = (() => {
        try {
          return hashSkillDir(path.join(fromSkills, entry.name)) === hashSkillDir(dest);
        } catch {
          return false;
        }
      })();
      if (!same) conflicts.push(entry.name);
    }
    if (conflicts.length === 0) return null;
    return `目标库已有同名但内容不同的 Skill：${conflicts.join('、')}；未做任何改动，请先处理冲突或换一个空目录`;
  }

  /** 迁移后的硬校验：库内技能齐全 + 每条意图链接确实指向新库。 */
  private verify(intents: IntentEntry[], to: string, links: LibraryMigrationLinkSummary): void {
    const toSkills = skillsDirOf(to);
    const missing = intents.filter((it) => !fs.existsSync(skillsDirJoin(toSkills, it.relPath)));
    if (missing.length > 0) {
      throw new Error(`迁移后库内缺少技能目录：${missing.map((m) => m.dirName).join('、')}`);
    }
    const broken: string[] = [];
    for (const item of links.items) {
      if (item.status === 'skipped') continue;
      const insp = inspectTarget(item.targetPath);
      const expected = skillsDirJoin(toSkills, intents.find((it) => it.dirName === item.dirName)?.relPath ?? item.dirName);
      if (insp.kind !== 'link' || !samePath(insp.resolvedTarget, expected)) {
        broken.push(`${item.dirName} → ${item.agentName}`);
      }
    }
    if (broken.length > 0) {
      throw new Error(`迁移后链接校验失败：${broken.join('；')}`);
    }
    if (links.failed > 0) {
      throw new Error(`迁移时有 ${links.failed} 条链接重建失败`);
    }
  }

  // ────────────────────────── 链接重建 ──────────────────────────

  /** 收集同步意图（真相 = 元数据文件；索引里的 sync 是派生值）。 */
  private collectIntents(libraryDir: string): IntentEntry[] {
    const skillsDir = skillsDirOf(libraryDir);
    const out: IntentEntry[] = [];
    for (const dirName of listMetaDirNames(skillsDir)) {
      const meta = readSkillMeta(skillsDir, dirName);
      if (!meta) continue;
      out.push({ dirName, relPath: meta.relPath, skillId: meta.skillId, agentIds: [...meta.sync.agents] });
    }
    return out;
  }

  /**
   * 按同步意图重建链接：
   *  - 目标缺失 → 建链；
   *  - 链接指向旧库 → 删链接后重建（**只删链接**）；
   *  - 链接已指向新库 → unchanged；
   *  - 实体目录 / 指向别处的链接 → skipped（零覆盖零删除）。
   */
  private rebuildLinks(
    intents: IntentEntry[],
    to: string,
    from: string,
    createdLinks: string[],
    removedLinks: { targetPath: string; oldTarget: string }[],
  ): LibraryMigrationLinkSummary {
    const items: LibraryMigrationLinkItem[] = [];
    const toSkills = skillsDirOf(to);
    const fromSkills = skillsDirOf(from);

    for (const intent of intents) {
      const srcDir = skillsDirJoin(toSkills, intent.relPath);
      for (const agentId of intent.agentIds) {
        const agent = this.opts.agents.get(agentId);
        if (!agent) {
          items.push({
            skillId: intent.skillId,
            dirName: intent.dirName,
            agentId,
            agentName: agentId,
            targetPath: '',
            status: 'skipped',
            reason: '本机不存在该 Agent（意图来自其他机器）',
          });
          continue;
        }
        const targetPath = path.join(agent.skillsDir, intent.dirName);
        const item: LibraryMigrationLinkItem = {
          skillId: intent.skillId,
          dirName: intent.dirName,
          agentId,
          agentName: agent.name,
          targetPath,
          status: 'skipped',
        };
        try {
          const insp = inspectTarget(targetPath);
          if (insp.kind === 'link' && samePath(insp.resolvedTarget, srcDir)) {
            item.status = 'unchanged';
          } else if (insp.kind === 'link' && samePath(insp.resolvedTarget, skillsDirJoin(fromSkills, intent.relPath))) {
            const oldResolved = insp.resolvedTarget as string;
            removeDirLink(targetPath);
            removedLinks.push({ targetPath, oldTarget: oldResolved });
            ensureDir(agent.skillsDir);
            createDirLink(srcDir, targetPath);
            createdLinks.push(targetPath);
            item.status = 'rebuilt';
          } else if (insp.kind === 'missing') {
            ensureDir(agent.skillsDir);
            createDirLink(srcDir, targetPath);
            createdLinks.push(targetPath);
            item.status = 'rebuilt';
          } else {
            item.status = 'skipped';
            item.reason =
              insp.kind === 'link'
                ? `目标已是指向别处的链接（${insp.resolvedTarget ?? '未知'}），未覆盖、未删除`
                : '目标已存在且不是链接（实体目录/文件），未覆盖、未删除';
          }
        } catch (err) {
          item.status = 'failed';
          item.reason = (err as Error).message;
        }
        items.push(item);
      }
    }

    return summarize(items);
  }

  // ────────────────────────── 回退 ──────────────────────────

  private async rollback(ctx: {
    from: string;
    to: string;
    intents: IntentEntry[];
    copied: string[];
    createdLinks: string[];
    removedLinks: { targetPath: string; oldTarget: string }[];
    prevLibraryPath: string | null;
  }): Promise<boolean> {
    let ok = true;

    // a) 撤销新库中本次复制的条目（只删自己复制的，绝不动目标原有内容）
    for (const created of [...ctx.copied].reverse()) {
      try {
        fs.rmSync(created, { recursive: true, force: true });
      } catch (err) {
        ok = false;
        this.opts.logger?.error('library:migration-rollback-copy', { path: created, error: (err as Error).message });
      }
    }

    // b) 撤销本次新建的链接（只删链接本身）
    for (const linkPath of ctx.createdLinks) {
      const insp = inspectTarget(linkPath);
      if (insp.kind !== 'link') continue;
      try {
        removeDirLink(linkPath);
      } catch (err) {
        ok = false;
        this.opts.logger?.error('library:migration-rollback-unlink', { path: linkPath, error: (err as Error).message });
      }
    }

    // c) 本机配置回到迁移前（null = 使用默认路径）
    this.opts.state.setLibraryPath(ctx.prevLibraryPath);

    // d) 库服务切回旧路径
    try {
      await this.opts.switchLibrary(ctx.from);
    } catch (err) {
      ok = false;
      this.opts.logger?.error('library:migration-rollback-switch', { error: (err as Error).message });
    }

    // e) 恢复链接指向旧库
    const fromSkills = skillsDirOf(ctx.from);
    for (const intent of ctx.intents) {
      const oldSrc = skillsDirJoin(fromSkills, intent.relPath);
      for (const agentId of intent.agentIds) {
        const agent = this.opts.agents.get(agentId);
        if (!agent) continue;
        const targetPath = path.join(agent.skillsDir, intent.dirName);
        const insp = inspectTarget(targetPath);
        if (insp.kind === 'link' && samePath(insp.resolvedTarget, oldSrc)) continue;
        if (insp.exists && insp.kind !== 'link') continue; // 实体内容不碰
        try {
          if (insp.kind === 'link') removeDirLink(targetPath);
          ensureDir(agent.skillsDir);
          createDirLink(oldSrc, targetPath);
        } catch (err) {
          ok = false;
          this.opts.logger?.error('library:migration-rollback-relink', {
            targetPath,
            error: (err as Error).message,
          });
        }
      }
    }

    // f) 回读：所有意图链接必须指向旧库、且旧库技能目录仍在
    for (const intent of ctx.intents) {
      const oldSrc = skillsDirJoin(fromSkills, intent.relPath);
      if (!fs.existsSync(oldSrc)) ok = false;
      for (const agentId of intent.agentIds) {
        const agent = this.opts.agents.get(agentId);
        if (!agent) continue;
        const insp = inspectTarget(path.join(agent.skillsDir, intent.dirName));
        if (insp.kind === 'link') {
          if (!samePath(insp.resolvedTarget, oldSrc)) ok = false;
        } else if (insp.kind !== 'missing') {
          // 实体目录：迁移前就不是链接，回退后仍保持原状，不算失败
        } else {
          ok = false;
        }
      }
    }

    this.opts.logger?.info('library:migration-rollback', { rolledBack: ok, from: ctx.from, to: ctx.to });
    return ok;
  }
}

// ────────────────────────── 纯工具 ──────────────────────────

function validateTarget(from: string, to: string): { code: string; detail: string } | null {
  if (samePath(from, to)) {
    return { code: 'SAME_DIRECTORY', detail: '目标目录与当前中心库相同' };
  }
  if (isPathInside(from, to)) {
    return { code: 'NESTED_DIRECTORY', detail: '目标目录位于当前中心库内部，无法迁移' };
  }
  if (isPathInside(to, from)) {
    return { code: 'NESTED_DIRECTORY', detail: '当前中心库位于目标目录内部，无法迁移' };
  }
  return null;
}

/** 写入探针文件验证可写；成功返回 null，失败返回原因。 */
function probeWritable(dir: string): string | null {
  const probe = path.join(dir, `.skills-studio-write-test-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    return null;
  } catch (err) {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      /* ignore */
    }
    return (err as Error).message;
  }
}

function listEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => !name.startsWith('.skills-studio-write-test-'));
  } catch {
    return [];
  }
}

/**
 * 把库内容复制到目标（保留目标已有内容）。返回本次搬入的技能目录数。
 * copied 收集本次在目标侧新建的路径，供回退精确删除。
 */
function copyLibrary(from: string, to: string, copied: string[]): number {
  const fromSkills = skillsDirOf(from);
  const toSkills = skillsDirOf(to);
  ensureDir(toSkills);

  let moved = 0;
  if (fs.existsSync(fromSkills)) {
    for (const entry of fs.readdirSync(fromSkills, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === SKILL_META_DIRNAME) continue;
      const src = path.join(fromSkills, entry.name);
      const dest = path.join(toSkills, entry.name);
      if (fs.existsSync(dest)) continue; // 合并：同名同内容已在目标（预检已保证），不覆盖也不入回退清单
      fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
      copied.push(dest);
      moved++;
    }
    // 元数据统一收在库根 sync/（2026-11-03 起，与 skills/ 同级；旧库收在 skills/.meta/，
    // 源库是旧布局时照搬整个目录，目标侧 SkillLibraryService.create 迁移统一归位）
    const fromMeta = path.join(fromSkills, SKILL_META_DIRNAME);
    if (fs.existsSync(fromMeta)) {
      const toMeta = path.join(to, SKILL_META_DIRNAME);
      if (!fs.existsSync(toMeta)) {
        fs.cpSync(fromMeta, toMeta, { recursive: true, errorOnExist: true, force: false });
        copied.push(toMeta);
      }
    }
    // 源库已是新布局：库根 sync/ 就是元数据目录，直接搬。
    // 注意旧布局的库根 sync/ 放的是落点快照（*.skills 文件，可由扫描重建），不搬；
    // 以目录内容区分（存在 *.skill.json 才当元数据），避免把旧快照误当元数据。
    const fromSyncMeta = path.join(from, SKILL_META_DIRNAME);
    if (fs.existsSync(fromSyncMeta) && !fs.existsSync(path.join(fromSkills, SKILL_META_DIRNAME))) {
      const isSkillMeta = fs
        .readdirSync(fromSyncMeta, { withFileTypes: true })
        .some((e) => e.isFile() && e.name.endsWith('.skill.json'));
      const toSyncMeta = path.join(to, SKILL_META_DIRNAME);
      if (isSkillMeta && !fs.existsSync(toSyncMeta)) {
        fs.cpSync(fromSyncMeta, toSyncMeta, { recursive: true, errorOnExist: true, force: false });
        copied.push(toSyncMeta);
      }
    }
    // 旧布局残留（.skill.json 平铺技能区）：一并带走，目标侧 create 时统一迁移
    for (const entry of fs.readdirSync(fromSkills, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.skill.json')) continue;
      const dest = path.join(toSkills, entry.name);
      if (fs.existsSync(dest)) continue; // 目标已有该技能的元数据：以目标为准
      fs.copyFileSync(path.join(fromSkills, entry.name), dest);
      copied.push(dest);
    }
  }

  // reports/（评测报告，不在 skills/ 下，不会被部署）
  const fromReports = path.join(from, 'reports');
  if (fs.existsSync(fromReports)) {
    const toReports = path.join(to, 'reports');
    ensureDir(toReports);
    for (const entry of fs.readdirSync(fromReports, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const dest = path.join(toReports, entry.name);
      if (fs.existsSync(dest)) continue;
      fs.copyFileSync(path.join(fromReports, entry.name), dest);
      copied.push(dest);
    }
  }

  // 库级元数据与协议目录
  const fromLibMeta = path.join(from, 'library.json');
  const toLibMeta = path.join(to, 'library.json');
  if (fs.existsSync(fromLibMeta) && !fs.existsSync(toLibMeta)) {
    fs.copyFileSync(fromLibMeta, toLibMeta);
    copied.push(toLibMeta);
  }
  const fromProtocol = path.join(from, '.skills-sync');
  const toProtocol = path.join(to, '.skills-sync');
  if (fs.existsSync(fromProtocol) && !fs.existsSync(toProtocol)) {
    fs.cpSync(fromProtocol, toProtocol, { recursive: true });
    copied.push(toProtocol);
  }

  return moved;
}

/** 迁移成功后清空旧库内容（目录本身保留，避免误删用户自建位置）。 */
function cleanupOldLibrary(from: string): string | undefined {
  const warnings: string[] = [];
  for (const name of MANAGED_ENTRIES) {
    const target = path.join(from, name);
    if (!fs.existsSync(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
      warnings.push(`${name}: ${(err as Error).message}`);
    }
  }
  return warnings.length > 0 ? `旧目录清理未完成（${warnings.join('；')}），可手动删除` : undefined;
}

function summarize(items: LibraryMigrationLinkItem[]): LibraryMigrationLinkSummary {
  const out: LibraryMigrationLinkSummary = { rebuilt: 0, unchanged: 0, skipped: 0, failed: 0, items };
  for (const item of items) out[item.status] += 1;
  return out;
}
