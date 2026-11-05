/**
 * 首次启动服务（T10：ui.md「首次启动」、prd.md M1、tec.md §5.11）。
 *
 * 两步分离：
 *  1) scan：只读扫描「已启用且目录存在的 Agent」的全局 Skills 目录，返回临时列表
 *     （不形成来源记录、不入库、不部署）；
 *  2) import：对用户选中的条目调用 T02 importSkills（source.type=machine-scan，
 *     origin 记 Agent 标签而不是本机绝对路径），逐项返回 status/reason，导入不自动部署。
 *
 * 安全：导入入参只接受扫描结果里的 key，由服务端缓存解析为真实路径，
 * 渲染层无法通过 IPC 让主进程导入任意磁盘位置。
 */
import { sanitizeName } from './path-guard';
import { skillContentMtime } from './content-hash';
import type { AppStateService } from './app-state';
import type { AgentConfigService } from './agents';
import type { SkillSourceService } from './sources/source-service';
import type { SkillLibraryService } from './library';
import { scanLocalSkills } from './tool-scanner';
import type {
  FirstRunImportItem,
  FirstRunImportResult,
  FirstRunScanAgent,
  FirstRunScanItem,
  FirstRunScanResult,
} from '../shared/ipc';

export interface FirstRunServiceOptions {
  library: SkillLibraryService;
  sources: SkillSourceService;
  state: AppStateService;
  agents: AgentConfigService;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
}

interface ScannedEntry {
  item: FirstRunScanItem;
  /** 源技能目录绝对路径（仅服务端持有） */
  sourcePath: string;
  sourceRelPath: string;
  /** 嵌套目录的父目录名（一层直放为 null），导入时写成技能标签 */
  group: string | null;
}

const KEY_SEPARATOR = '::';

export class FirstRunService {
  private readonly library: SkillLibraryService;
  private readonly sources: SkillSourceService;
  private readonly state: AppStateService;
  private readonly agents: AgentConfigService;
  private readonly logger: FirstRunServiceOptions['logger'];
  private scanned = new Map<string, ScannedEntry>();

  constructor(opts: FirstRunServiceOptions) {
    this.library = opts.library;
    this.sources = opts.sources;
    this.state = opts.state;
    this.agents = opts.agents;
    this.logger = opts.logger;
  }

  /** 按适配器清单扫描本机（未登记的 Agent 目录不访问；与「扫描本机」同一链路）。 */
  scan(): FirstRunScanResult {
    const libraryDirNames = new Set(this.library.listSkills().map((s) => s.dirName));
    const items: FirstRunScanItem[] = [];
    const agents: FirstRunScanAgent[] = [];
    this.scanned = new Map();

    const targets = this.agents.list().map((a) => ({ key: a.id, label: a.name, dir: a.skillsDir }));
    const plan = scanLocalSkills({ targets, centralSkillsDir: this.library.skillsDir });

    const counts = new Map<string, number>();
    for (const agent of this.agents.list()) {
      if (!agent.installed) continue;
      agents.push({ id: agent.id, label: agent.name, skillsDir: agent.skillsDir, count: 0 });
    }

    for (const skill of plan.discovered) {
      const key = `${skill.tool}${KEY_SEPARATOR}${skill.relPath}`;
      if (this.scanned.has(key)) continue; // 同名相对路径防御（同一 Agent 内不应出现）
      const item: FirstRunScanItem = {
        key,
        name: skill.name,
        description: skill.description,
        agentId: skill.tool,
        agentLabel: skill.toolLabel,
        path: skill.path,
        inLibrary: libraryDirNames.has(sanitizeName(skill.name)),
        valid: true,
      };
      items.push(item);
      this.scanned.set(key, {
        item,
        sourcePath: skill.path,
        sourceRelPath: skill.relPath,
        group: skill.group,
      });
      counts.set(skill.tool, (counts.get(skill.tool) ?? 0) + 1);
    }

    for (const agent of agents) agent.count = counts.get(agent.id) ?? 0;

    this.logger?.info('first-run:scan', {
      agents: agents.length,
      toolsScanned: plan.toolsScanned,
      items: items.length,
    });
    return { items, agents, agentCount: agents.length };
  }

  /**
   * 导入选中项（source.type=machine-scan，origin=Agent 标签）。
   * 汇总口径：imported / skipped（同名同内容已入库）/ failed。
   */
  async importSelected(keys: string[]): Promise<FirstRunImportResult> {
    const wanted: ScannedEntry[] = [];
    const unknown: string[] = [];
    for (const key of keys) {
      const entry = this.scanned.get(key);
      if (entry) wanted.push(entry);
      else unknown.push(key);
    }
    if (wanted.length === 0) {
      if (unknown.length > 0) {
        throw new Error('扫描结果已过期：请重新扫描后再导入');
      }
      return { items: [], summary: { imported: 0, skipped: 0, failed: 0 } };
    }

    // 与安装页“扫描本机”一致：同名候选先导入文件 mtime 更新的版本；时间相同沿用选择顺序。
    wanted.sort((a, b) => {
      const nameA = sanitizeName(a.item.name);
      const nameB = sanitizeName(b.item.name);
      if (nameA !== nameB) return nameA < nameB ? -1 : 1;
      return (skillContentMtime(b.sourcePath) ?? 0) - (skillContentMtime(a.sourcePath) ?? 0);
    });

    const batch = await this.sources.importSkills(
      wanted.map((entry) => ({
        path: entry.sourcePath,
        source: {
          type: `agent:${entry.item.agentId}` as const,
          origin: this.agents.requireAgent(entry.item.agentId).skillsDir,
          sourceRelPath: entry.sourceRelPath,
        },
        groups: entry.group != null ? [entry.group] : undefined,
      })),
    );

    const results: FirstRunImportItem[] = [];
    for (let i = 0; i < wanted.length; i++) {
      const entry = wanted[i];
      const result = batch.results[i];
      const status =
        result?.status === 'imported'
          ? 'imported'
          : result?.status === 'already-in-library'
            ? 'skipped'
            : 'failed';
      results.push({
        key: entry.item.key,
        name: result?.name ?? entry.item.name,
        agentLabel: entry.item.agentLabel,
        status,
        reason: result?.reason,
      });
    }
    for (const key of unknown) {
      results.push({ key, name: key, agentLabel: '', status: 'failed', reason: '扫描结果中不存在该项，请重新扫描' });
    }

    const summary = { imported: 0, skipped: 0, failed: 0 };
    for (const r of results) summary[r.status] += 1;
    this.logger?.info('first-run:import', { ...summary });
    return { items: results, summary };
  }

  /** 标记首启完成（幂等）；flag 持久在 DATA_DIR/app-state.json。 */
  complete(): { firstRunCompleted: boolean } {
    const state = this.state.markFirstRunCompleted();
    this.logger?.info('first-run:completed', { libraryPath: state.libraryPath });
    return { firstRunCompleted: state.firstRunCompleted };
  }
}
