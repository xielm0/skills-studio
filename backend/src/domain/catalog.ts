/**
 * 中心库列表 / 详情 / 文件读写 / Group 标签（T11：prd.md M1/M3/M4/M6、tec.md §5.1/§5.3/§5.4/§5.6）。
 *
 * 边界：
 *  - 列表与筛选只读索引，不做全量文件哈希；
 *  - 文件读写严格限定在 `skills/<dirName>/` 内（拒绝绝对路径、`..`、软链逃逸），
 *    保存走「同目录临时文件 + fsync + rename」原子替换，失败保留旧内容；
 *  - 保存成功后先写元数据哈希再重扫，保证不产生第二条 content-changed 事件；
 *  - Group 是集合语义（add/remove 幂等），变更不产生近期动态（PRD 5.1 只记录四类）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WriteLock } from '../infra/write-lock';
import { readSkillMeta, skillsDirJoin } from '../infra/fs-meta';
import { hashAndSizeSkillDir } from './content-hash';
import { readSkillMd } from './frontmatter';
import { SkillLibraryService } from './library';
import { isPathSafe, sameOrigin, sanitizeName } from './path-guard';
import type { AgentConfigService, AgentInfo } from './agents';
import type { EvalReportStoreLike } from './agent/workflows/report-store';
import type { SkillSummary } from './types';
import type { SkillSourceInfo } from './types';
import { MAX_GROUP_LENGTH } from './types';
import type {
  LibraryBatchGroupsResult,
  LibraryDetailResult,
  LibraryFacetsResult,
  LibraryFileReason,
  LibraryGroupsResult,
  LibraryListRequest,
  LibraryListResult,
  LibraryReadFileResult,
  LibraryReportResult,
  LibrarySkillRow,
  LibrarySourceView,
  LibraryWriteFileResult,
  SkillFileNode,
} from '../shared/ipc';

/** 在应用内可编辑的文本文件上限（超过只读，避免把大文件搬进渲染层）。 */
export const MAX_EDITABLE_FILE_BYTES = 512 * 1024;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.zip', '.gz', '.7z', '.rar', '.tar', '.pdf', '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.webm', '.wav',
  '.sqlite', '.db', '.pyc', '.class', '.jar', '.wasm',
]);

const SOURCE_LABELS: Record<string, string> = {
  scan: '中心库发现',
  'local-dir': '本地',
  git: 'Git',
  zip: '压缩包',
  'machine-scan': '本机 Agent',
  'agent-dir': 'Agent 目录',
  market: '技能市场',
  conversation: '对话创建',
};

export function sourceLabel(type: string | null | undefined): string {
  if (!type) return '未知';
  return SOURCE_LABELS[type] ?? type;
}

function sourceDisplayLabel(type: string, origin: string | undefined, agents: AgentInfo[]): string {
  if (type === 'scan') return '中心库发现';
  if (type === 'local-dir') return '本地';
  if (type === 'zip') return '压缩包';
  if (type === 'conversation') return '本地开发';
  if (type === 'market') return '技能市场';
  if (type === 'git') return 'Git';
  if (type.startsWith('agent:')) return agents.find((agent) => agent.id === type.slice(6))?.name ?? type.slice(6);
  if (type === 'machine-scan' || type === 'agent-dir') {
    const value = origin?.trim();
    if (!value) return '未知 Agent';
    const matched = agents.find((agent) =>
      agent.name.toLowerCase() === value.toLowerCase() ||
      agent.id.toLowerCase() === value.toLowerCase() ||
      sameOrigin(agent.skillsDir, value),
    );
    return matched?.name ?? (path.isAbsolute(value) ? '本机 Agent' : value);
  }
  return sourceLabel(type);
}

function sourceFacet(source: LibrarySourceView | null): { value: string; label: string } | null {
  if (!source) return null;
  if (source.type === 'scan') return { value: 'scan', label: '中心库发现' };
  if (source.type === 'local-dir') return { value: 'local-dir', label: '本地' };
  if (source.type === 'zip') return { value: 'zip', label: '压缩包' };
  if (source.type === 'conversation') return { value: 'local-development', label: '本地开发' };
  if (source.type === 'market') return { value: 'market', label: '技能市场' };
  if (source.type === 'git') return { value: 'git', label: 'Git' };
  if (source.type.startsWith('agent:')) return { value: source.type, label: source.label };
  if (source.type === 'machine-scan' || source.type === 'agent-dir') {
    return { value: `agent:${source.label.toLowerCase()}`, label: source.label };
  }
  return { value: source.type, label: source.label };
}

export interface SkillCatalogServiceOptions {
  library: SkillLibraryService;
  agents: AgentConfigService;
  /** 评测报告存储（reports/<技能名>_review_<时间戳>.md） */
  reports: EvalReportStoreLike;
  updateState?: (skillId: string, source: SkillSourceInfo | null) =>
    { status: 'available' | 'up-to-date' | 'source-missing' | 'error'; error?: string } | null;
  lock?: WriteLock;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
  /** 测试注入：写入在 rename 前失败（验证「保存失败不丢旧内容」） */
  writeFailPoint?: 'before-rename' | null;
}

export class CatalogError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CatalogError';
  }
}

export class SkillCatalogService {
  private readonly library: SkillLibraryService;
  private readonly agents: AgentConfigService;
  private readonly reports: EvalReportStoreLike;
  private readonly lock: WriteLock | undefined;
  private readonly logger: SkillCatalogServiceOptions['logger'];
  private readonly writeFailPoint: 'before-rename' | null;
  private readonly updateState: NonNullable<SkillCatalogServiceOptions['updateState']>;

  constructor(opts: SkillCatalogServiceOptions) {
    this.library = opts.library;
    this.agents = opts.agents;
    this.reports = opts.reports;
    this.lock = opts.lock;
    this.logger = opts.logger;
    this.writeFailPoint = opts.writeFailPoint ?? null;
    this.updateState = opts.updateState ?? (() => null);
  }

  // ────────────────────────── 列表与筛选 ──────────────────────────

  /** 组合筛选：query（名称/描述）+ group + sourceType + agentId。 */
  list(filter: LibraryListRequest = {}): LibraryListResult {
    const rows = this.rows();
    const query = (filter.query ?? '').trim().toLowerCase();
    const group = (filter.group ?? '').trim();
    const sourceType = (filter.sourceType ?? '').trim();
    const origin = (filter.origin ?? '').trim();
    const agentId = (filter.agentId ?? '').trim();

    const items = rows.filter((row) => {
      if (query.length > 0) {
        const haystack = `${row.name}\n${row.description}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (group.length > 0 && !row.groups.includes(group)) return false;
      if (sourceType.length > 0 && row.source?.type !== sourceType && sourceFacet(row.source)?.value !== sourceType) {
        return false;
      }
      if (origin.length > 0 && !sameOrigin(row.source?.origin, origin)) return false;
      if (agentId.length > 0) {
        const related = new Set([...row.deployedAgents, ...row.configuredAgents]);
        if (!related.has(agentId)) return false;
      }
      return true;
    });
    return { items, total: items.length };
  }

  /** 筛选可选值：Group / 来源 / 启用中的 Agent（计数按全库，不受当前筛选影响）。 */
  facets(): LibraryFacetsResult {
    const rows = this.rows();
    const groups = new Map<string, number>();
    const sources = new Map<string, { label: string; count: number }>();
    const agents = new Map<string, number>();

    for (const row of rows) {
      for (const g of row.groups) groups.set(g, (groups.get(g) ?? 0) + 1);
      const source = sourceFacet(row.source);
      if (source) {
        const current = sources.get(source.value);
        sources.set(source.value, { label: source.label, count: (current?.count ?? 0) + 1 });
      }
      for (const id of new Set([...row.deployedAgents, ...row.configuredAgents])) {
        agents.set(id, (agents.get(id) ?? 0) + 1);
      }
    }

    return {
      total: rows.length,
      groups: [...groups.entries()]
        .map(([value, count]) => ({ value, label: value, count }))
        .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)),
      sources: [...sources.entries()]
        .map(([value, { label, count }]) => ({ value, label, count }))
        .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
      agents: this.agents
        .syncTargets()
        .map((a) => ({ value: a.id, label: a.name, count: agents.get(a.id) ?? 0 })),
    };
  }

  /** 详情：摘要 + 真实文件树（按需构建，不预读文件内容）。 */
  detail(skillId: string): LibraryDetailResult {
    const detail = this.requireDetail(skillId);
    const row = this.toRow(detail, this.agents.list());
    return {
      ...row,
      contentHash: detail.contentHash,
      sizeBytes: detail.sizeBytes,
      fileTree: detail.fileTree as SkillFileNode | null,
      reportPath: this.reportPath(skillId),
      origin: 'library',
      isManagedLink: false,
    };
  }

  // ────────────────────────── 文件读写 ──────────────────────────

  /** 读取文件内容；二进制/超限只返回元信息与原因，不把内容送入渲染层。 */
  readFile(skillId: string, relPath: string): LibraryReadFileResult {
    const skill = this.requireDetail(skillId);
    if (skill.missing) throw new CatalogError('SKILL_MISSING', `技能目录已丢失：${skill.dirName}`);
    return readTextFileInDir(skillsDirJoin(this.library.skillsDir, skill.relPath), relPath);
  }

  /** 原子保存：临时文件 + fsync + rename；失败保留旧内容并抛错。 */
  async writeFile(skillId: string, relPath: string, content: string): Promise<LibraryWriteFileResult> {
    if (typeof content !== 'string') {
      throw new CatalogError('BAD_REQUEST', 'content 必须是字符串');
    }
    const run = () => this.doWrite(skillId, relPath, content);
    return this.lock ? this.lock.runExclusive('edit-file', run) : run();
  }

  private async doWrite(skillId: string, relPath: string, content: string): Promise<LibraryWriteFileResult> {
    const skill = this.requireDetail(skillId);
    const skillDir = skillsDirJoin(this.library.skillsDir, skill.relPath);
    const { savedAt } = writeTextFileAtomicInDir(skillDir, relPath, content, this.writeFailPoint);

    const { hash, sizeBytes } = hashAndSizeSkillDir(skillDir);
    const meta = readSkillMeta(this.library.skillsDir, skill.dirName);
    if (!meta) throw new CatalogError('META_MISSING', `技能元数据缺失：${skill.dirName}`);
    const changed = meta.contentHash !== hash;
    // SKILL.md 可能改了 name/description：先同步到元数据，避免重扫再产生一条事件
    const md = readSkillMd(skillDir);
    if (md) {
      const frontName = md.meta.name != null ? sanitizeName(md.meta.name).trim() : '';
      meta.name = frontName.length > 0 ? frontName : skill.dirName;
      meta.nameSource = frontName.length > 0 ? 'frontmatter' : 'dirname';
      meta.description = md.meta.description ?? '';
    }
    meta.contentHash = hash;
    meta.contentHashAt = savedAt;
    meta.sizeBytes = sizeBytes;
    meta.updatedAt = savedAt;
    this.library.writeExternalMeta(meta);

    if (changed) {
      this.library.appendEvent(skillId, 'content-changed', `编辑保存：${skill.dirName}/${relPath}`);
    }
    await this.library.rescan();
    this.logger?.info('catalog:file-saved', { skillId, relPath, changed, sizeBytes });
    return { relPath, size: Buffer.byteLength(content, 'utf8'), contentHash: hash, savedAt };
  }

  // ────────────────────────── Group ──────────────────────────

  async setGroups(skillId: string, change: { add?: string[]; remove?: string[] }): Promise<LibraryGroupsResult> {
    const add = normalizeGroupList(change.add);
    const remove = normalizeGroupList(change.remove);
    const run = async (): Promise<LibraryGroupsResult> => {
      const groups = this.applyGroups(skillId, add, remove);
      await this.library.rescan();
      return { skillId, groups };
    };
    return this.lock ? this.lock.runExclusive('set-groups', run) : run();
  }

  /** 批量只作用于传入的 skillIds；单项失败不影响其他项。 */
  async batchGroups(
    skillIds: string[],
    change: { add?: string[]; remove?: string[] },
  ): Promise<LibraryBatchGroupsResult> {
    const add = normalizeGroupList(change.add);
    const remove = normalizeGroupList(change.remove);
    const run = async (): Promise<LibraryBatchGroupsResult> => {
      const items: LibraryBatchGroupsResult['items'] = [];
      for (const skillId of skillIds) {
        try {
          items.push({ skillId, groups: this.applyGroups(skillId, add, remove) });
        } catch (err) {
          items.push({ skillId, groups: [], error: (err as Error).message });
        }
      }
      await this.library.rescan();
      return { items };
    };
    return this.lock ? this.lock.runExclusive('batch-groups', run) : run();
  }

  private applyGroups(skillId: string, add: string[], remove: string[]): string[] {
    const skill = this.library.getSkillDetail(skillId);
    if (!skill) throw new CatalogError('SKILL_NOT_FOUND', `技能不存在：${skillId}`);
    const meta = readSkillMeta(this.library.skillsDir, skill.dirName);
    if (!meta) throw new CatalogError('META_MISSING', `技能元数据缺失：${skill.dirName}`);
    const next = new Set(meta.groups);
    for (const g of add) next.add(g);
    for (const g of remove) next.delete(g);
    const groups = [...next].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (groups.join('\u0000') !== meta.groups.join('\u0000')) {
      meta.groups = groups;
      // Group 变更不改变内容与名称，不动 updatedAt（语义见 T01）
      this.library.writeExternalMeta(meta);
      this.logger?.info('catalog:groups-changed', { skillId, groups });
    }
    return groups;
  }

  // ────────────────────────── 报告 ──────────────────────────

  report(skillId: string): LibraryReportResult {
    try {
      if (!this.reports.has(skillId)) {
        return { exists: false, path: this.reportPath(skillId) };
      }
      const text = this.reports.read(skillId);
      if (text == null) return { exists: false, path: this.reportPath(skillId) };
      return { exists: true, text, path: this.reportPath(skillId) };
    } catch (err) {
      throw new CatalogError('REPORT_READ_FAILED', `读取评测报告失败：${(err as Error).message}`);
    }
  }

  reportPath(skillId: string): string {
    return this.reports.path(skillId);
  }

  hasReport(skillId: string): boolean {
    try {
      return this.reports.has(skillId);
    } catch {
      return false;
    }
  }

  // ────────────────────────── 内部 ──────────────────────────

  private rows(): LibrarySkillRow[] {
    const agents = this.agents.list();
    return this.library.listSkills().map((s) => this.toRow(s, agents));
  }

  private toRow(skill: SkillSummary, agents: AgentInfo[]): LibrarySkillRow {
    const update = this.updateState(skill.skillId, skill.source);
    const source = skill.source
      ? ({
          type: skill.source.type,
          label: sourceDisplayLabel(skill.source.type, skill.source.origin, agents),
          origin: skill.source.origin,
          detail: skill.source.type === 'scan'
            ? `中心库发现：skills/${skill.dirName}（原始来处未记录）`
            : `value：${skill.source.origin ?? '未记录'}\npath：${skill.source.sourceRelPath ?? '未记录'}`,
        } satisfies LibrarySourceView)
      : null;
    return {
      skillId: skill.skillId,
      dirName: skill.dirName,
      name: skill.name,
      description: skill.description,
      missingName: skill.missingName,
      groups: skill.groups,
      source,
      updateAvailable: update?.status === 'available',
      ...(update?.status === 'source-missing' || update?.status === 'error'
        ? { updateCheckStatus: update.status, updateCheckError: update.error } : {}),
      deployedAgents: skill.deployedAgents,
      configuredAgents: skill.configuredAgents ?? [],
      configuredNotDeployed: skill.configuredNotDeployed === true,
      hasReport: this.hasReport(skill.skillId),
      missing: skill.missing,
      updatedAt: skill.updatedAt,
    };
  }

  private requireDetail(skillId: string) {
    const detail = this.library.getSkillDetail(skillId);
    if (!detail) throw new CatalogError('SKILL_NOT_FOUND', `技能不存在：${skillId}`);
    return detail;
  }

  /**
   * 把渲染层给的相对路径解析到技能目录内（T11 中心库技能）。
   */
  private resolveInsideSkill(skillId: string, relPath: string): string {
    const skill = this.requireDetail(skillId);
    if (skill.missing) {
      throw new CatalogError('SKILL_MISSING', `技能目录已丢失：${skill.dirName}`);
    }
    return resolvePathInsideRoot(skillsDirJoin(this.library.skillsDir, skill.relPath), relPath);
  }
}

/**
 * 把渲染层给的相对路径解析到任意技能根目录内（中心库技能 / Agent 源技能共用）：
 * 拒绝绝对路径 / 盘符 / `..` / 空白，规范化后必须仍在根目录内；
 * 已存在的文件还要过 realpath（防软链逃逸到根目录之外）。
 */
export function resolvePathInsideRoot(rootDir: string, relPath: string): string {
  const root = path.resolve(rootDir);
  const raw = typeof relPath === 'string' ? relPath.trim() : '';
  if (raw.length === 0) throw new CatalogError('INVALID_PATH', 'relPath 不能为空');
  if (raw.includes('\u0000')) throw new CatalogError('INVALID_PATH', 'relPath 含非法字符');
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')) {
    throw new CatalogError('INVALID_PATH', `拒绝绝对路径：${raw}`);
  }
  const segments = raw.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) {
    throw new CatalogError('INVALID_PATH', `拒绝越界路径：${raw}`);
  }
  const abs = path.resolve(root, segments.filter((s) => s.length > 0 && s !== '.').join(path.sep));
  if (!isPathSafe(root, abs) || abs === root) {
    throw new CatalogError('INVALID_PATH', `路径越出技能目录：${raw}`);
  }
  if (fs.existsSync(abs)) {
    let real: string;
    let realRoot: string;
    try {
      real = fs.realpathSync(abs);
      realRoot = fs.realpathSync(root);
    } catch {
      throw new CatalogError('INVALID_PATH', `无法解析路径：${raw}`);
    }
    if (!isPathSafe(realRoot, real)) {
      throw new CatalogError('INVALID_PATH', `路径经链接逃出技能目录：${raw}`);
    }
  } else {
    // 不存在的路径不允许成为写入目标（本任务只编辑已有文件）
    throw new CatalogError('FILE_NOT_FOUND', `文件不存在：${raw}`);
  }
  return abs;
}

/** 读取任意技能根目录内的文件（中心库与 Agent 源共用同一套只读/二进制判定）。 */
export function readTextFileInDir(rootDir: string, relPath: string): LibraryReadFileResult {
  const abs = resolvePathInsideRoot(rootDir, relPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    throw new CatalogError('FILE_NOT_FOUND', `文件不存在：${relPath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { relPath, content: null, size: stat.size, editable: false, reason: 'NOT_A_FILE' };
  }
  if (stat.size > MAX_EDITABLE_FILE_BYTES) {
    return { relPath, content: null, size: stat.size, editable: false, reason: 'TOO_LARGE' };
  }
  const buffer = fs.readFileSync(abs);
  if (isBinaryBuffer(buffer) || BINARY_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
    return {
      relPath,
      content: null,
      size: stat.size,
      editable: false,
      reason: 'BINARY' as LibraryFileReason,
    };
  }
  return { relPath, content: buffer.toString('utf8'), size: stat.size, editable: true, reason: null };
}

/** 原子写入任意技能根目录内的文件（临时文件 + fsync + rename；失败保留旧内容）。 */
export function writeTextFileAtomicInDir(
  rootDir: string,
  relPath: string,
  content: string,
  failPoint: 'before-rename' | null = null,
): { size: number; savedAt: string } {
  if (typeof content !== 'string') {
    throw new CatalogError('BAD_REQUEST', 'content 必须是字符串');
  }
  const abs = resolvePathInsideRoot(rootDir, relPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    throw new CatalogError('FILE_NOT_FOUND', `文件不存在：${relPath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CatalogError('NOT_A_FILE', `不是可写文件：${relPath}`);
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_EDITABLE_FILE_BYTES) {
    throw new CatalogError('FILE_TOO_LARGE', `内容超过 ${MAX_EDITABLE_FILE_BYTES} 字节上限`);
  }

  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${Date.now().toString(36)}`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (failPoint === 'before-rename') {
      throw new Error('注入失败（before-rename）：保存中止');
    }
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清理失败不改变结论：旧内容仍在 */
    }
    throw new CatalogError('SAVE_FAILED', `保存失败，已保留原内容：${(err as Error).message}`);
  }
  return { size: Buffer.byteLength(content, 'utf8'), savedAt: new Date().toISOString() };
}

function normalizeGroupList(input: string[] | undefined): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new CatalogError('BAD_REQUEST', 'Group 列表必须是字符串数组');
  }
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') throw new CatalogError('BAD_REQUEST', 'Group 必须是字符串');
    const name = raw.trim();
    if (name.length === 0) throw new CatalogError('BAD_REQUEST', 'Group 名不能为空');
    if (name.length > MAX_GROUP_LENGTH) {
      throw new CatalogError('BAD_REQUEST', `Group 名过长（最多 ${MAX_GROUP_LENGTH} 字符）：${name}`);
    }
    if (/[\u0000-\u001f\u007f]/.test(name)) {
      throw new CatalogError('BAD_REQUEST', `Group 名含控制字符：${JSON.stringify(name)}`);
    }
    out.add(name);
  }
  return [...out];
}

/** 二进制判定：采样前 8KB 是否含 NUL 字节（文本文件不会出现）。 */
function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}
