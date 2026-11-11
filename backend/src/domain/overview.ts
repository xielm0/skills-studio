/**
 * 主页概览与近期动态（T10：ui.md「主页」、prd.md M1、tec.md §5.1）。
 *
 * 只读聚合，不写任何状态：
 *  - 概览：库中技能数、同步覆盖（至少一条实测链接的技能 / 技能总数）、已接入 Agent 数；
 *  - 近期动态：每技能取最新一条事件（ActivityStore 聚合），翻译成行内文案 + 相对时间，
 *    按发生时间倒序。查看与评测不产生事件（事件只在入库/内容变更/部署状态变化时写入）。
 */
import type { AgentConfigService } from './agents';
import type { SkillLibraryService } from './library';
import type { ActivityEvent, SkillSummary } from './types';
import type { LibraryOverview, RecentActivityItem, RecentActivityResult } from '../shared/ipc';

export interface OverviewServiceOptions {
  library: SkillLibraryService;
  agents: AgentConfigService;
  /** 动态条数上限（主页列表可滚动，默认 30） */
  limit?: number;
  /** 相对时间的参照时刻（测试可注入） */
  now?: () => Date;
}

export class OverviewService {
  private readonly library: SkillLibraryService;
  private readonly agents: AgentConfigService;
  private readonly limit: number;
  private readonly now: () => Date;

  constructor(opts: OverviewServiceOptions) {
    this.library = opts.library;
    this.agents = opts.agents;
    this.limit = opts.limit ?? 30;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * 概览（异步）：列表走批量异步探针（listSkillsWithDeployStatus），
   * 首屏 IPC 不再在主进程逐技能同步 stat。
   */
  async overview(): Promise<LibraryOverview> {
    const skills = await this.library.listSkillsWithDeployStatus();
    const skillCount = skills.filter((s) => !s.missing).length;
    const deployed = skills.filter((s) => !s.missing && s.deployedAgents.length > 0).length;
    const connected = this.agents.list().filter((a) => a.enabled && a.installed).length;
    return {
      skillCount,
      syncCoverage: { deployed, total: skillCount },
      agentsConnected: connected,
    };
  }

  /** 近期动态（异步）：同上，技能摘要走批量异步探针。 */
  async recentActivity(): Promise<RecentActivityResult> {
    const skills = new Map((await this.library.listSkillsWithDeployStatus()).map((s) => [s.skillId, s]));
    const agentNames = new Map(this.agents.list().map((a) => [a.id, a.name]));
    const now = this.now();
    const items: RecentActivityItem[] = [];

    for (const event of this.library.getRecentActivity()) {
      const skill = skills.get(event.skillId);
      if (!skill) continue; // 技能已被删除：动态不再展示（事件本身保留在 JSONL）
      items.push({
        skillId: skill.skillId,
        dirName: skill.dirName,
        name: skill.name,
        text: describeEvent(event, skill, agentNames),
        occurredAt: event.occurredAt,
        relativeTime: relativeTime(event.occurredAt, now),
        missing: skill.missing,
      });
      if (items.length >= this.limit) break;
    }
    return { items };
  }
}

/** 事件 → 行内文案（ui.md：已同步至 X / 内容已变更 / 新入库 · 尚未同步）。 */
function describeEvent(
  event: ActivityEvent,
  skill: SkillSummary,
  agentNames: Map<string, string>,
): string {
  const deployedNames = skill.deployedAgents.map((id) => agentNames.get(id) ?? id);
  const pendingNames = (skill.configuredNotDeployed ? skill.configuredAgents ?? [] : [])
    .filter((id) => !skill.deployedAgents.includes(id))
    .map((id) => agentNames.get(id) ?? id);

  switch (event.type) {
    case 'imported':
    case 'created': {
      const head = event.type === 'imported' ? '新入库' : '新建';
      if (deployedNames.length === 0) return `${head} · 尚未同步`;
      return `${head} · 已同步至 ${deployedNames.join('、')}`;
    }
    case 'content-changed': {
      let text = '内容已变更';
      if (pendingNames.length > 0) text += ` · ${pendingNames.join('、')} 待同步`;
      else if (deployedNames.length === 0) text += ' · 尚未同步';
      return text;
    }
    case 'deploy-status': {
      if (deployedNames.length > 0) return `已同步至 ${deployedNames.join('、')}`;
      // 撤下后没有实测链接：沿用事件本身的描述（如「已从 Claude Code 撤下」）
      return event.detail.includes('撤下') ? event.detail : '已撤下';
    }
    default:
      return event.detail;
  }
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / 前天 / N 天前 / M月D日。 */
export function relativeTime(iso: string, now: Date): string {
  const at = new Date(iso);
  const ms = now.getTime() - at.getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms < 0) return '刚刚';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && isSameDay(at, now)) return `${hours} 小时前`;
  const days = calendarDayDiff(at, now);
  if (days <= 0) return `${Math.max(1, hours)} 小时前`;
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days < 7) return `${days} 天前`;
  const sameYear = at.getFullYear() === now.getFullYear();
  return sameYear ? `${at.getMonth() + 1} 月 ${at.getDate()} 日` : `${at.getFullYear()} 年 ${at.getMonth() + 1} 月 ${at.getDate()} 日`;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

function calendarDayDiff(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}
