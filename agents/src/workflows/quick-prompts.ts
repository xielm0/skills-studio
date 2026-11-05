/**
 * T07：三个快捷入口的预填提示词与流程文本加载（prd.md §5.4/§5.8/§5.9、tec.md §5.9）。
 *
 * 两条硬规则：
 *  1. 这里只产出**可编辑文本**，绝不启动运行（用户点「发送」后由 workflow.startRun 执行）；
 *  2. 流程约束来自产品自带的 `agents/skills/<name>/SKILL.md`，
 *     不依赖用户本机安装的 Skill，也不读任何用户目录。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readBuiltinSkill } from '../skills/frontmatter';
import { AgentRunError } from '../errors';

export type QuickAction = 'create' | 'improve' | 'evaluate';

/** 快捷项 → 产品自带流程文本目录名（与 agents/skills 下的目录一一对应）。 */
export const FLOW_SKILL_NAMES: Record<QuickAction, string> = {
  create: 'skill-creator',
  improve: 'skill-improve',
  evaluate: 'skill-doctor',
};

export interface QuickPromptContext {
  /** 创建：目标技能目录名（已清洗） */
  targetName?: string | null;
  /** 改进/评测：技能展示名 */
  skillName?: string | null;
  /** 改进/评测：稳定 Skill ID */
  skillId?: string | null;
  /** 改进/评测：库内目录名 */
  dirName?: string | null;
  /** 评测：是否已有当前报告（仅影响提示语，不改变行为） */
  hasReport?: boolean;
  /**
   * 会话授权到 `skills/` 根（聊天页快捷入口）：不指定目标技能，
   * 提示词里也就不出现技能名，由 Agent 在库内自行定位。
   */
  libraryScope?: boolean;
}

const flowCache = new Map<string, string>();

/** 从自身位置向上查找 `agents/skills`（打包与源码两种布局都能命中）。 */
export function resolveAgentSkillsRoot(explicit?: string): string {
  if (explicit) {
    const dir = path.resolve(explicit);
    if (fs.existsSync(dir)) return dir;
    throw new AgentRunError('WORKFLOW_RESOURCE_MISSING', `流程文本目录不存在：${dir}`);
  }
  // 源码布局优先：`agents/skills` 是用户可直接投放新 Skill 的目录，
  // 构建时复制到 `agents/dist/skills` 的副本只作为打包（无源目录）时的兜底。
  for (const candidate of [
    path.resolve(__dirname, '..', '..', 'skills'),
    path.resolve(__dirname, '..', 'skills'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  let current = __dirname;
  for (let i = 0; i < 8; i++) {
    for (const candidate of [path.join(current, 'skills'), path.join(current, 'agents', 'skills')]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new AgentRunError(
    'WORKFLOW_RESOURCE_MISSING',
    '未找到产品自带的流程文本（agents/skills）；请确认应用资源完整。',
  );
}

/** 内置流程 skill（产品自带，作为 Agent 的可用 skill 暴露）。 */
export interface BuiltinSkillRef {
  /** 目录名（如 skill-improve） */
  dirName: string;
  /** frontmatter name */
  name: string;
  description: string;
  /** SKILL.md 绝对路径 */
  file: string;
}

/**
 * 列出产品自带的内置 skill（`agents/skills/<name>/SKILL.md`）。
 * 目录缺失或为空时返回空数组：调用方据此决定要不要给只读授权与清单提示。
 */
export function listBuiltinSkills(resourcesRoot?: string): BuiltinSkillRef[] {
  let root: string;
  try {
    root = resolveAgentSkillsRoot(resourcesRoot);
  } catch {
    return [];
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: BuiltinSkillRef[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const file = path.join(dir, 'SKILL.md');
    const md = readBuiltinSkill(dir);
    if (!md) continue;
    out.push({
      dirName: entry.name,
      name: md.name ?? entry.name,
      description: md.description ?? '',
      file,
    });
  }
  return out;
}

/** 内置 skill 清单的公共根目录（授权用）；没有内置 skill 时返回 null。 */
export function builtinSkillsRoot(skills: readonly BuiltinSkillRef[]): string | null {
  if (skills.length === 0) return null;
  return path.dirname(path.dirname(skills[0].file));
}

/** 读取流程文本正文（去掉 frontmatter；按名称缓存）。 */
export function loadFlowText(action: QuickAction, resourcesRoot?: string): string {
  return loadBuiltinSkillText(FLOW_SKILL_NAMES[action], resourcesRoot);
}

/** 按内部 Skill 名读取流程正文，名称必须属于已扫描清单。 */
export function loadBuiltinSkillText(name: string, resourcesRoot?: string): string {
  const root = resolveAgentSkillsRoot(resourcesRoot);
  const selected = listBuiltinSkills(root).find((skill) => skill.name === name);
  if (!selected) {
    throw new AgentRunError('WORKFLOW_RESOURCE_MISSING', `内部 Skill 不存在：${name}`);
  }
  const file = selected.file;
  const cached = flowCache.get(file);
  if (cached != null) return cached;

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new AgentRunError('WORKFLOW_RESOURCE_MISSING', `缺少流程文本：${name}/SKILL.md`);
  }
  const body = stripFrontmatter(raw).trim();
  if (!body) throw new AgentRunError('WORKFLOW_RESOURCE_MISSING', `流程文本为空：${name}/SKILL.md`);
  flowCache.set(file, body);
  return body;
}

/** 把指定内部 Skill 的流程注入当前会话。 */
export function buildBuiltinSkillSystemPrompt(name: string, resourcesRoot?: string): string {
  return `【本次使用内部 Skill：${name}】\n\n${loadBuiltinSkillText(name, resourcesRoot)}`;
}

/** 注入会话的附加系统提示：流程约束（创建/改进/评测的 SOP）。 */
export function buildFlowSystemPrompt(action: QuickAction, resourcesRoot?: string): string {
  const title =
    action === 'create' ? '技能创建' : action === 'improve' ? '技能优化' : '技能评测（skill-doctor）';
  return `【本次流程：${title}（产品自带流程文本）】\n\n${loadFlowText(action, resourcesRoot)}`;
}

/**
 * 生成快捷项预填提示词（可编辑，纯文本，无副作用）。
 * 参数只用于把目标信息写进提示词，不读写文件系统。
 */
export function buildQuickActionPrompt(action: QuickAction, ctx: QuickPromptContext = {}): string {
  if (action === 'create') {
    const target = (ctx.targetName ?? '').trim() || '[名称]';
    return `请帮我创建一个名叫 ${target} 的 Skill。它的目的是：[用途]。触发条件是：[触发条件]。`;
  }
  const name = (ctx.skillName ?? '').trim() || '[名称]';
  if (action === 'improve') return `请帮我优化名叫 ${name} 的 Skill。`;
  return `请帮我评测名叫 ${name} 的 Skill。`;
}

/** 去掉 SKILL.md 的 YAML frontmatter，只保留正文。 */
function stripFrontmatter(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return raw;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return raw;
  return lines.slice(end + 1).join('\n');
}
