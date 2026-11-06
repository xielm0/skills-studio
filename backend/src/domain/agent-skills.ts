/**
 * Agents 页与 agent 源详情（T13：prd.md M5、tec.md §5.5、ui.md「Agents」「技能详情」）。
 *
 * 数据真相永远来自磁盘：
 *  - 列表每次 readdir + lstat 实时扫描该 Agent 的 Skills 目录，绿/灰灯由「是否指向中心库的链接」决定；
 *  - 入库复用 T03 的安全 adopt（复制校验 → 暂存 → 建链 → 失败回滚），来源记 agent-dir + Agent 标签；
 *  - agent 源详情/读写限定在该 Agent skills 目录下的单个技能子目录内：
 *    已入库链接技能写入落到中心库（走 T11 的文件保存，元数据/事件同步），
 *    未入库技能写入 Agent 原文件。
 *
 * 隔离：本模块不推断任何真实目录，Agent 目录全部来自 AgentConfigService（测试为 agents-mock）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentsAdoptResult, AgentSkillRow, AgentsRemoveSkillResult, AgentsSkillListResult, LibraryDetailResult, LibraryReadFileResult, LibraryWriteFileResult } from '../shared/ipc';
import { readSkillMeta, skillsDirJoin } from '../infra/fs-meta';
import { LinkError, inspectTarget, removeDirLink, samePath } from '../infra/link-manager';
import type { WriteLock } from '../infra/write-lock';
import { type AgentConfigService, type AgentInfo } from './agents';
import {
  CatalogError,
  SkillCatalogService,
  readTextFileInDir,
  writeTextFileAtomicInDir,
} from './catalog';
import { hashAndSizeSkillDir, isIgnoredDirName } from './content-hash';
import { buildFileTree } from './file-tree';
import { isSkillDir, readSkillMd } from './frontmatter';
import type { SkillLibraryService } from './library';
import type { PlacementStore } from './placement-store';
import {
  MAX_SKILL_DEPTH,
  isPathSafe,
  sanitizeName,
  validateNewDirName,
  validateSkillRelPath,
} from './path-guard';
import type { SkillDeployService } from './deploy-service';

export class AgentSkillsError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'AgentSkillsError';
  }
}

export interface AgentSkillsServiceOptions {
  library: SkillLibraryService;
  agents: AgentConfigService;
  deploy: SkillDeployService;
  catalog: SkillCatalogService;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
  /** 同步落点记忆：Agents 页列表本身就是一次扫描，顺带整份重写 `<库>/agents-skills/<agentId>.skills` */
  placement?: PlacementStore;
  /** 与导入/同步共用同一把写锁；未注入时（单元测试）直接执行 */
  lock?: WriteLock;
}

type EntryKind = 'link-to-library' | 'link-elsewhere' | 'real-dir';

interface EntryInfo {
  entry: string;
  /** 技能内容根：实体目录本身，或链接指向的目标目录 */
  root: string;
  kind: EntryKind;
  isManagedLink: boolean;
  /** 链接指向库内时的库目录名 */
  libraryDirName: string | null;
  skillId: string | null;
  missing: boolean;
}

export class AgentSkillsService {
  private readonly library: SkillLibraryService;
  private readonly agents: AgentConfigService;
  private readonly deploy: SkillDeployService;
  private readonly catalog: SkillCatalogService;
  private readonly logger: AgentSkillsServiceOptions['logger'];
  private readonly placement: PlacementStore | undefined;
  private readonly lock: WriteLock | undefined;

  constructor(opts: AgentSkillsServiceOptions) {
    this.library = opts.library;
    this.agents = opts.agents;
    this.deploy = opts.deploy;
    this.catalog = opts.catalog;
    this.logger = opts.logger;
    this.placement = opts.placement;
    this.lock = opts.lock;
  }

  /** 列表（实时扫描，不加缓存）。目录不存在时 exists=false，不抛错。 */
  list(agentId: string): AgentsSkillListResult {
    const agent = this.agents.get(agentId);
    const base = {
      agentId,
      agentLabel: agent?.name ?? agentId,
      skillsDir: agent?.skillsDir ?? '',
      exists: false,
      items: [] as AgentSkillRow[],
      scannedAt: new Date().toISOString(),
    };
    if (!agent || !agent.installed) return base;

    // 目录不可读时按「不存在」处理（与递归收集分开：exists 语义要准确）
    try {
      fs.readdirSync(agent.skillsDir, { withFileTypes: true });
    } catch {
      return base;
    }

    const libSkills = this.library.listSkills();
    const items: AgentSkillRow[] = [];
    const places = new Map<string, string[]>();
    this.collect(agent, agent.skillsDir, '', 0, libSkills, items, places);
    // 排序：先按 group（相对路径首段，扁平条目为空）聚拢，组内按 Skill 名称升序，目录名兜底保证稳定
    items.sort(
      (a, b) =>
        skillCollator.compare(groupOfEntry(a.dirName), groupOfEntry(b.dirName)) ||
        skillCollator.compare(a.name, b.name) ||
        skillCollator.compare(a.dirName, b.dirName),
    );
    // 这个列表本身就是一次扫描：顺手整份重写落点表（内容未变不写盘）
    this.writePlacement(agentId, places);
    return { ...base, exists: true, items };
  }

  /** 落点表：库内目录名 → 该 Agent 下的相对路径；同一技能多处时按路径排序取第一个。 */
  private writePlacement(agentId: string, places: Map<string, string[]>): void {
    const store = this.placement;
    if (store == null) return;
    const table: Record<string, string> = {};
    for (const key of [...places.keys()].sort()) {
      const list = places.get(key);
      if (!list || list.length === 0) continue;
      table[key] = [...list].sort()[0];
    }
    store.writeAll(agentId, table);
  }

  /**
   * 递归收集该 Agent 目录下的技能条目（与 tool-scanner 同一口径：层数 ≤ MAX_SKILL_DEPTH）。
   * 命中即停：目录本身是技能时不再看子目录；嵌套条目的 dirName 为相对路径（`group/a`）。
   */
  private collect(
    agent: AgentInfo,
    root: string,
    rel: string,
    depth: number,
    libSkills: ReturnType<SkillLibraryService['listSkills']>,
    out: AgentSkillRow[],
    places: Map<string, string[]>,
  ): void {
    if (depth >= MAX_SKILL_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of entries) {
      if (dirent.name.startsWith('.')) continue;
      if (isIgnoredDirName(dirent.name)) continue;
      const entry = rel.length === 0 ? dirent.name : `${rel}/${dirent.name}`;

      let info: EntryInfo;
      try {
        info = this.inspectEntry(agent, entry, false);
      } catch {
        continue;
      }
      if (info.missing) continue;

      if (isSkillDir(info.root)) {
        try {
          out.push(this.toRow(info, libSkills));
        } catch (err) {
          this.logger?.error('agent-skills:row-failed', { entry, error: (err as Error).message });
        }
        // 落点键：已接管用库内目录名，实体目录用清洗后的技能名
        const key = info.isManagedLink && info.libraryDirName != null
          ? info.libraryDirName
          : validateNewDirName(readSkillMd(info.root)?.meta.name ?? path.basename(info.entry));
        if (key != null) {
          const list = places.get(key);
          if (list == null) places.set(key, [info.entry]);
          else list.push(info.entry);
        }
        continue;
      }

      this.collect(agent, path.join(root, dirent.name), entry, depth + 1, libSkills, out, places);
    }
  }

  /** 重新扫描：先刷新中心库索引（链接目标可能刚变），再实时读取该 Agent 目录。 */
  async rescan(agentId: string): Promise<AgentsSkillListResult> {
    await this.library.rescan();
    return this.list(agentId);
  }

  /** 灰灯入库：source.type=agent-dir、origin=Agent 标签；同名同内容复用。 */
  async adopt(agentId: string, dirName: string): Promise<AgentsAdoptResult> {
    const agent = this.requireAgent(agentId);
    this.assertEntryName(agent, dirName);
    const result = await this.deploy.adoptFromAgent(agentId, dirName);
    this.logger?.info('agent-skills:adopt', {
      agentId,
      dirName,
      status: result.status,
      skillId: result.skillId ?? null,
    });
    return result;
  }

  /**
   * 删除该 Agent 目录下的一个技能条目（Agents 页行菜单「删除」）：
   *  - 链接 → 只删链接本身，目标目录零影响；指向中心库时还清同步意图与落点记忆；
   *  - 实体目录 → 删除该技能目录（只这一层，父目录与其他技能不动）；
   */
  async remove(agentId: string, dirName: string): Promise<AgentsRemoveSkillResult> {
    const run = (): AgentsRemoveSkillResult => {
      const agent = this.requireAgent(agentId);
      this.assertEntryName(agent, dirName);
      const info = this.inspectEntry(agent, dirName, true);
      const md = readSkillMd(info.root);
      const name = displayName(md, dirName);
      const full = path.join(agent.skillsDir, ...dirName.split('/'));
      // 与扫描同一口径：链接用库内目录名作键，实体目录用清洗后的技能名
      const placementKey =
        info.isManagedLink && info.libraryDirName != null
          ? info.libraryDirName
          : validateNewDirName(md?.meta.name ?? path.basename(dirName));

      if (info.kind === 'link-to-library' || info.kind === 'link-elsewhere') {
        try {
          removeDirLink(full);
        } catch (err) {
          return {
            status: 'failed',
            dirName,
            name,
            code: err instanceof LinkError ? err.code : 'LINK_REMOVE_FAILED',
            reason: err instanceof LinkError ? err.detail : (err as Error).message,
          };
        }
        // 链接已删掉；只有本库链接需要更新同步意图，外部目标不属于本库。
        if (info.kind === 'link-to-library') {
          try {
            this.deploy.forgetSync(agentId, info.libraryDirName ?? path.basename(info.root));
          } catch (err) {
            this.logger?.error('agent-skills:forget-sync-failed', { agentId, dirName, error: (err as Error).message });
          }
        } else if (placementKey != null) {
          try {
            if (this.placement?.read(agentId)[placementKey] === dirName) {
              this.placement.remove(agentId, placementKey);
            }
          } catch (err) {
            this.logger?.error('agent-skills:forget-placement-failed', { agentId, dirName, error: (err as Error).message });
          }
        }
        this.logger?.info('agent-skills:remove-link', { agentId, dirName, libraryDirName: info.libraryDirName });
        return { status: 'removed', dirName, name, removedType: 'link' };
      }

      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch (err) {
        return {
          status: 'failed',
          dirName,
          name,
          code: 'SKILL_DELETE_FAILED',
          reason: `删除目录失败（可能被其他程序占用）：${(err as Error).message}`,
        };
      }
      // 落点记忆指向刚删掉的这一项时一并清掉；指向同技能的别一份则保留
      if (placementKey != null && this.placement?.read(agentId)[placementKey] === dirName) {
        this.placement.remove(agentId, placementKey);
      }
      this.logger?.info('agent-skills:remove-dir', { agentId, dirName });
      return { status: 'removed', dirName, name, removedType: 'dir' };
    };

    return this.lock ? this.lock.runExclusive('agent-skill-remove', run) : run();
  }

  /** agent 源详情：文件树/哈希/大小与中心库详情同构，额外标注 isManagedLink。 */
  detail(agentId: string, dirName: string): LibraryDetailResult {
    const agent = this.requireAgent(agentId);
    this.assertEntryName(agent, dirName);
    const info = this.inspectEntry(agent, dirName, true);

    if (info.isManagedLink && info.skillId != null) {
      const detail = this.catalog.detail(info.skillId);
      return {
        ...detail,
        origin: 'agent',
        isManagedLink: true,
        agentId,
        agentEntry: dirName,
      };
    }

    const md = readSkillMd(info.root);
    if (md == null) throw new AgentSkillsError('TOOL_OUT_OF_SCOPE', `不是技能目录（缺少 SKILL.md）：${dirName}`);
    const { hash, sizeBytes } = hashAndSizeSkillDir(info.root);
    const frontName = md.meta.name != null ? sanitizeName(md.meta.name).trim() : '';
    const name = frontName.length > 0 ? frontName : direntDisplayName(dirName);
    const mtime = statMtime(info.root);
    return {
      skillId: null,
      dirName,
      // 未入库技能不在库内，按平铺语义占位（行菜单「移动到文件夹」不对它开放）
      relPath: dirName,
      name,
      description: md.meta.description ?? '',
      missingName: frontName.length === 0,
      groups: [],
      source: null,
      updateAvailable: false,
      deployedAgents: [],
      configuredAgents: [],
      configuredNotDeployed: false,
      hasReport: false,
      missing: false,
      updatedAt: mtime,
      contentHash: hash,
      sizeBytes,
      fileTree: buildFileTree(info.root),
      reportPath: null,
      origin: 'agent',
      isManagedLink: info.isManagedLink,
      agentId,
      agentEntry: dirName,
    };
  }

  /** 读取：已入库链接技能读中心库；否则读 Agent 目录中的文件。 */
  readFile(agentId: string, dirName: string, relPath: string): LibraryReadFileResult {
    const info = this.requireEntry(agentId, dirName);
    try {
      if (info.isManagedLink && info.skillId != null) {
        return this.catalog.readFile(info.skillId, relPath);
      }
      return readTextFileInDir(info.root, relPath);
    } catch (err) {
      throw this.normalizePathError(err);
    }
  }

  /** 写入：已入库链接技能写中心库（元数据/事件同步）；未入库写 Agent 原文件。 */
  async writeFile(
    agentId: string,
    dirName: string,
    relPath: string,
    content: string,
  ): Promise<LibraryWriteFileResult> {
    const info = this.requireEntry(agentId, dirName);
    try {
      if (info.isManagedLink && info.skillId != null) {
        return await this.catalog.writeFile(info.skillId, relPath, content);
      }
      const { size, savedAt } = writeTextFileAtomicInDir(info.root, relPath, content);
      this.logger?.info('agent-skills:file-saved', { agentId, dirName, relPath, size });
      return { relPath, size, contentHash: null, savedAt };
    } catch (err) {
      throw this.normalizePathError(err);
    }
  }

  // ────────────────────────── 内部 ──────────────────────────

  private requireAgent(agentId: string): AgentInfo {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      throw new AgentSkillsError('TOOL_OUT_OF_SCOPE', 'agentId 不能为空');
    }
    const agent = this.agents.get(agentId);
    if (!agent) throw new AgentSkillsError('TOOL_OUT_OF_SCOPE', `Agent 不存在：${agentId}`);
    if (!agent.installed) {
      throw new AgentSkillsError('TOOL_OUT_OF_SCOPE', `未检测到 ${agent.name} 的 Skills 目录：${agent.skillsDir}`);
    }
    return agent;
  }

  private requireEntry(agentId: string, dirName: string): EntryInfo {
    const agent = this.requireAgent(agentId);
    this.assertEntryName(agent, dirName);
    return this.inspectEntry(agent, dirName, true);
  }

  /** 只接受该 Agent skills 目录下的直接子目录项名（拒绝路径、..、绝对路径）。 */
  /** 条目名：一层目录名（`a`）或嵌套相对路径（`group/a`），层数与扫描同一上限。 */
  private assertEntryName(agent: AgentInfo, dirName: string): void {
    const rel = validateSkillRelPath(dirName);
    if (rel == null || rel !== dirName) {
      throw new AgentSkillsError('PATH_ESCAPE', `拒绝路径型目录项：${JSON.stringify(dirName)}`);
    }
    const base = path.resolve(agent.skillsDir);
    const full = path.resolve(path.join(base, rel));
    if (full === base || !isPathSafe(base, full)) {
      throw new AgentSkillsError('PATH_ESCAPE', `目录项越出 Agent Skills 目录：${dirName}`);
    }
  }

  /**
   * 判定目录项形态；strict=true 时缺失/非技能目录直接抛结构化错误。
   * 绿/灰灯只在这里判定：链接目标父目录 === 中心库 skills 目录 → 绿灯。
   */
  private inspectEntry(agent: AgentInfo, dirName: string, strict: boolean): EntryInfo {
    const full = path.join(agent.skillsDir, dirName);
    const insp = inspectTarget(full);
    if (!insp.exists) {
      if (strict) throw new AgentSkillsError('TOOL_OUT_OF_SCOPE', `Agent 目录中不存在该项：${dirName}`);
      return { entry: dirName, root: full, kind: 'real-dir', isManagedLink: false, libraryDirName: null, skillId: null, missing: true };
    }

    if (insp.kind === 'link') {
      if (insp.resolvedTarget == null) {
        if (strict) throw new AgentSkillsError('TOOL_OUT_OF_SCOPE', `无法读取链接目标：${dirName}`);
        return { entry: dirName, root: full, kind: 'link-elsewhere', isManagedLink: false, libraryDirName: null, skillId: null, missing: true };
      }
      const root = insp.resolvedTarget;
      const missing = !fs.existsSync(root);
      // 指向中心库内技能（平铺或一层组子目录）：路径在 skills/ 内且剩余段是合法技能 relPath
      const inLibrary =
        isPathSafe(this.library.skillsDir, root) &&
        validateSkillRelPath(path.relative(this.library.skillsDir, root).split(path.sep).join('/')) ===
          path.relative(this.library.skillsDir, root).split(path.sep).join('/');
      if (inLibrary) {
        const libraryDirName = path.basename(root);
        const summary = this.library.listSkills().find((s) => s.dirName === libraryDirName);
        const meta = summary ? null : readSkillMeta(this.library.skillsDir, libraryDirName);
        return {
          entry: dirName,
          root,
          kind: 'link-to-library',
          isManagedLink: true,
          libraryDirName,
          skillId: summary?.skillId ?? meta?.skillId ?? null,
          missing,
        };
      }
      if (strict && !missing && !isSkillDir(root)) {
        throw new AgentSkillsError('TOOL_OUT_OF_SCOPE', `链接目标不是技能目录（缺少 SKILL.md）：${dirName}`);
      }
      return { entry: dirName, root, kind: 'link-elsewhere', isManagedLink: false, libraryDirName: null, skillId: null, missing };
    }

    if (insp.kind === 'dir') {
      const root = full;
      if (strict && !isSkillDir(root)) {
        throw new AgentSkillsError('TOOL_OUT_OF_SCOPE', `不是技能目录（缺少 SKILL.md）：${dirName}`);
      }
      return { entry: dirName, root, kind: 'real-dir', isManagedLink: false, libraryDirName: null, skillId: null, missing: false };
    }

    if (strict) throw new AgentSkillsError('TOOL_OUT_OF_SCOPE', `Agent 目录项不是目录：${dirName}`);
    return { entry: dirName, root: full, kind: 'real-dir', isManagedLink: false, libraryDirName: null, skillId: null, missing: true };
  }

  private toRow(info: EntryInfo, libSkills: ReturnType<SkillLibraryService['listSkills']>): AgentSkillRow {
    const md = readSkillMd(info.root);
    if (info.isManagedLink) {
      const summary = libSkills.find((s) => s.dirName === info.libraryDirName);
      const meta = summary ? null : readSkillMeta(this.library.skillsDir, info.libraryDirName ?? '');
      let sizeBytes: number | undefined;
      try {
        if (!info.missing) sizeBytes = hashAndSizeSkillDir(info.root).sizeBytes;
      } catch {
        sizeBytes = undefined;
      }
      return {
        dirName: info.entry,
        name: summary?.name ?? meta?.name ?? displayName(md, info.entry),
        description: summary?.description ?? meta?.description ?? md?.meta.description ?? '',
        isManagedLink: true,
        linkedSkillId: summary?.skillId ?? meta?.skillId ?? null,
        inLibrary: true,
        inLibrarySameContent: true,
        status: 'synced',
        sizeBytes,
      };
    }

    let hash: string | null = null;
    let sizeBytes: number | undefined;
    try {
      const hashed = hashAndSizeSkillDir(info.root);
      hash = hashed.hash;
      sizeBytes = hashed.sizeBytes;
    } catch {
      hash = null;
      sizeBytes = undefined;
    }
    const cleaned = validateNewDirName(md?.meta.name ?? info.entry);
    const existing = cleaned == null ? undefined : libSkills.find((s) => s.dirName === cleaned);
    let sameContent = false;
    if (existing != null && hash != null) {
      const existingMeta = readSkillMeta(this.library.skillsDir, existing.dirName);
      const existingHash =
        existingMeta?.contentHash ??
        (() => {
          try {
            return hashAndSizeSkillDir(
              skillsDirJoin(this.library.skillsDir, existingMeta?.relPath ?? existing.dirName),
            ).hash;
          } catch {
            return null;
          }
        })();
      sameContent = existingHash != null && existingHash === hash;
    }
    return {
      dirName: info.entry,
      name: displayName(md, info.entry),
      description: md?.meta.description ?? '',
      isManagedLink: false,
      linkedSkillId: null,
      matchingSkillId: existing?.skillId ?? null,
      inLibrary: existing != null,
      inLibrarySameContent: sameContent,
      status:
        existing == null ? 'not-in-library' : sameContent ? 'in-library' : 'conflict',
      sizeBytes,
    };
  }

  private normalizePathError(err: unknown): Error {
    if (err instanceof CatalogError) {
      if (err.code === 'INVALID_PATH') return new AgentSkillsError('PATH_ESCAPE', err.detail);
      if (err.code === 'FILE_NOT_FOUND' || err.code === 'NOT_A_FILE' || err.code === 'SAVE_FAILED') {
        return new AgentSkillsError(err.code, err.detail);
      }
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

function displayName(md: ReturnType<typeof readSkillMd>, entry: string): string {
  const frontName = md?.meta.name != null ? sanitizeName(md.meta.name).trim() : '';
  return frontName.length > 0 ? frontName : direntDisplayName(entry);
}

/** 列表排序口径：忽略大小写，数字按数值（v2 在 v10 之前），中文按本地化顺序。 */
const skillCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/** 条目所属 group：嵌套条目取相对路径首段，扁平条目为空串（排在所有 group 之前）。 */
function groupOfEntry(dirName: string): string {
  const index = dirName.indexOf('/');
  return index < 0 ? '' : dirName.slice(0, index);
}

/** 无 frontmatter name 时的展示名：取路径最后一段（嵌套条目 `group/a` → `a`）。 */
function direntDisplayName(entry: string): string {
  const base = path.basename(entry);
  const cleaned = sanitizeName(base).trim();
  return cleaned.length > 0 ? cleaned : base;
}

function statMtime(dir: string): string {
  try {
    return fs.statSync(dir).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}
