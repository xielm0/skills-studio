/**
 * 对象级三方合并决策（纯函数，tec.md §5.10）。
 *
 * 输入 = 三份库快照（base / local / remote）+ 待决 pin 的技能 ID 集合；
 * 输出 = 合并计划。全程无 I/O、无时间戳、无「新者胜」，因此同样的三方输入
 * 在任何一台机器上必然算出同样的计划（两端不会互相覆盖）。
 *
 * 技能粒度规则：
 *  - 只有一边变化 → 取该边；
 *  - 两边都变化且结果相同 → 取任意一边（内容一致）；
 *  - 两边变化且结果不同 → 整技能判冲突：保留本机版本，记录 plan.conflicts；
 *  - 删除与修改相对 → 冲突（不静默复活、不静默删除）。
 * 组件粒度：内容树 / 元数据（Group 与同步 Agent 按集合比较）/ 评测报告各自判定，
 * 任一组件双边分叉即整技能冲突。
 */
import type {
  LibrarySnapshot,
  MergeComponentName,
  MergePlan,
  PlannedConflict,
  PlannedSkill,
  PortableSkillMeta,
  SkillSnapshot,
} from './types';

export interface PlanMergeInput {
  base: LibrarySnapshot;
  local: LibrarySnapshot;
  remote: LibrarySnapshot;
  /** 冲突待决 pin：这些技能固定为本机版本，只推进远端指针 */
  pinnedSkillIds?: string[];
}

/** 元数据的可比较视图：Group / 同步 Agent 按集合，忽略导入时间与派生字段。 */
export function metaComparableKey(meta: PortableSkillMeta | null | undefined): string {
  if (!meta) return '';
  return JSON.stringify({
    schemaVersion: meta.schemaVersion,
    dirName: meta.dirName,
    name: meta.name,
    nameSource: meta.nameSource,
    description: meta.description,
    groups: [...new Set(meta.groups)].sort(),
    source: meta.source
      ? {
          type: meta.source.type,
          origin: meta.source.origin ?? '',
          sourceRelPath: meta.source.sourceRelPath ?? '',
          sourceHash: meta.source.sourceHash ?? '',
          sourceBranch: meta.source.sourceBranch ?? '',
          sourceRevision: meta.source.sourceRevision ?? '',
        }
      : null,
    agents: [...new Set(meta.sync?.agents ?? [])].sort(),
  });
}

function sameMeta(a: PortableSkillMeta | null | undefined, b: PortableSkillMeta | null | undefined): boolean {
  return metaComparableKey(a) === metaComparableKey(b);
}

function sameNullable(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

/** 两个快照条目是否完全一致（元数据 + 内容树 + 报告）。 */
export function sameSkill(a?: SkillSnapshot, b?: SkillSnapshot): boolean {
  if (!a || !b) return false;
  return sameMeta(a.meta, b.meta) && sameNullable(a.contentTree, b.contentTree) && sameNullable(a.reportBlob, b.reportBlob);
}

type ComponentPick<T> = { value: T; from: 'local' | 'remote' | 'both' } | 'conflict';

/** 单组件三方取值的统一规则。 */
function pickComponent<T>(
  base: T,
  local: T,
  remote: T,
  equals: (x: T, y: T) => boolean,
): ComponentPick<T> {
  if (equals(local, remote)) return { value: local, from: 'both' };
  if (equals(local, base)) return { value: remote, from: 'remote' };
  if (equals(remote, base)) return { value: local, from: 'local' };
  return 'conflict';
}

function plannedFrom(skill: SkillSnapshot, from: 'local' | 'remote'): PlannedSkill {
  return {
    skillId: skill.skillId,
    meta: skill.meta,
    contentTree: skill.contentTree,
    reportBlob: skill.reportBlob,
    reportFile: skill.reportFile,
    from,
    renamedForCollision: false,
  };
}

/**
 * 生成合并计划。`pinnedSkillIds` 中的技能保持本机版本并计入 stillPending
 * （远端再变也只会推进 pin 记录的远端指针，不会重复生成新冲突）。
 */
export function planMerge(input: PlanMergeInput): MergePlan {
  const pinned = new Set(input.pinnedSkillIds ?? []);
  const plan: MergePlan = {
    skills: {},
    conflicts: [],
    stillPending: [],
    adoptedFromRemote: [],
    removed: [],
    keptLocal: [],
  };

  const ids = [
    ...new Set([
      ...Object.keys(input.base.skills),
      ...Object.keys(input.local.skills),
      ...Object.keys(input.remote.skills),
    ]),
  ].sort();

  for (const skillId of ids) {
    const b = input.base.skills[skillId];
    const l = input.local.skills[skillId];
    const r = input.remote.skills[skillId];

    // ── 待决 pin：固定本机版本（本机已没有该技能时保住远端版本，避免数据丢失） ──
    if (pinned.has(skillId)) {
      plan.stillPending.push(skillId);
      if (l) plan.skills[skillId] = plannedFrom(l, 'local');
      else if (r) plan.skills[skillId] = plannedFrom(r, 'remote');
      continue;
    }

    // 两边都没有：无需出现在结果里
    if (!l && !r) {
      if (b) plan.removed.push(skillId);
      continue;
    }

    // ── base 不存在 ──
    if (!b) {
      if (l && !r) {
        plan.skills[skillId] = plannedFrom(l, 'local');
        continue;
      }
      if (!l && r) {
        plan.skills[skillId] = plannedFrom(r, 'remote');
        plan.adoptedFromRemote.push(skillId);
        continue;
      }
      // 双新增
      if (sameSkill(l, r)) {
        plan.skills[skillId] = plannedFrom(l!, 'local');
      } else {
        plan.skills[skillId] = plannedFrom(l!, 'local');
        plan.conflicts.push(conflict(skillId, 'both-added', [], l!, r!));
        plan.keptLocal.push(skillId);
      }
      continue;
    }

    // ── 单边删除 ──
    if (l && !r) {
      if (sameSkill(l, b)) {
        plan.removed.push(skillId); // 对端删除生效
      } else {
        plan.skills[skillId] = plannedFrom(l, 'local');
        plan.conflicts.push(conflict(skillId, 'deleted-remotely', [], l, undefined, b));
        plan.keptLocal.push(skillId);
      }
      continue;
    }
    if (!l && r) {
      if (sameSkill(r, b)) {
        plan.removed.push(skillId); // 本机删除生效
      } else {
        // 本机删除 vs 远端修改：保留本机（删除），冲突待人工决定
        plan.conflicts.push(conflict(skillId, 'deleted-locally', [], undefined, r, b));
      }
      continue;
    }

    // ── 三边都在：先看整体是否一致，再按组件判定 ──
    if (sameSkill(l, r)) {
      plan.skills[skillId] = plannedFrom(l!, 'local');
      continue;
    }

    const baseContent = b!.contentTree;
    const baseReport = b!.reportBlob;
    const content = pickComponent(baseContent, l!.contentTree, r!.contentTree, sameNullable);
    const report = pickComponent(baseReport, l!.reportBlob, r!.reportBlob, sameNullable);
    const meta = pickComponent(b!.meta, l!.meta, r!.meta, (x, y) => sameMeta(x, y));

    const conflicted: MergeComponentName[] = [];
    if (content === 'conflict') conflicted.push('content');
    if (meta === 'conflict') conflicted.push('metadata');
    if (report === 'conflict') conflicted.push('report');

    if (conflicted.length > 0) {
      plan.skills[skillId] = plannedFrom(l!, 'local');
      plan.conflicts.push(conflict(skillId, 'component', conflicted, l!, r!, b));
      plan.keptLocal.push(skillId);
      continue;
    }

    const contentPick = content as { value: string | null; from: 'local' | 'remote' | 'both' };
    const metaPick = meta as { value: PortableSkillMeta; from: 'local' | 'remote' | 'both' };
    const reportPick = report as { value: string | null; from: 'local' | 'remote' | 'both' };
    const fromRemote = [contentPick.from, metaPick.from, reportPick.from].some((f) => f === 'remote');

    plan.skills[skillId] = {
      skillId,
      meta: metaPick.value,
      contentTree: contentPick.value,
      reportBlob: reportPick.value,
      // 报告内容与文件名同源：采纳远端就用远端文件名，否则保留本机文件名
      reportFile:
        reportPick.value == null
          ? null
          : reportPick.from === 'remote'
            ? (r!.reportFile ?? l!.reportFile)
            : (l!.reportFile ?? r!.reportFile),
      from: fromRemote ? 'merged' : 'local',
      renamedForCollision: false,
    };
  }

  resolveDirNameCollisions(plan, input.base, pinned);
  return plan;
}

function conflict(
  skillId: string,
  kind: PlannedConflict['kind'],
  components: PlannedConflict['components'],
  local?: SkillSnapshot,
  remote?: SkillSnapshot,
  base?: SkillSnapshot,
): PlannedConflict {
  return {
    skillId,
    kind,
    components: [...components].sort(),
    localDirName: local?.meta.dirName ?? null,
    remoteDirName: remote?.meta.dirName ?? base?.meta.dirName ?? null,
  };
}

/**
 * 目录名冲突（扁平库布局下两个不同 Skill 争同一目录名）的确定性处理：
 * 优先 pin 的技能，其次 base 中占用该名字的技能，最后最小 Skill ID；
 * 其余按 `名字 (2)`、`名字 (3)` 顺延。两端计算结果一致。
 */
function resolveDirNameCollisions(
  plan: MergePlan,
  base: LibrarySnapshot,
  pinned: Set<string>,
): void {
  const groups = new Map<string, string[]>();
  for (const skillId of Object.keys(plan.skills).sort()) {
    const key = plan.skills[skillId].meta.dirName.toLowerCase();
    const list = groups.get(key);
    if (list) list.push(skillId);
    else groups.set(key, [skillId]);
  }

  const taken = new Set(groups.keys());
  const baseHolders = new Map<string, string>();
  for (const skill of Object.values(base.skills)) {
    const key = skill.meta.dirName.toLowerCase();
    if (!baseHolders.has(key)) baseHolders.set(key, skill.skillId);
  }

  for (const [key, ids] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (ids.length < 2) continue;
    ids.sort();
    const placeholder =
      ids.find((id) => pinned.has(id)) ?? ids.find((id) => baseHolders.get(key) === id) ?? ids[0];
    for (const id of ids) {
      if (id === placeholder) continue;
      const skill = plan.skills[id];
      let n = 2;
      let candidate = '';
      for (;;) {
        candidate = `${skill.meta.dirName} (${n})`;
        if (!taken.has(candidate.toLowerCase())) break;
        n++;
      }
      taken.add(candidate.toLowerCase());
      skill.meta = { ...skill.meta, dirName: candidate };
      skill.renamedForCollision = true;
    }
  }
}
