/**
 * 合并结果树校验（tec.md §5.10 三段防御之二，照搬竞品 `merge/validate.rs` 的口径）。
 *
 * 纯检查、无 I/O：合并计划落盘（写工作树 / 建合并提交）之前先整体校验，
 * 任何违规都整体中止且零改动——不允许把「元数据与技能目录对不上」「目录名越界」
 * 的结果写进库，否则下一次合并会在每台机器上重复报错。
 *
 * 另外保留 T01 的「已丢失」语义：元数据可以没有目录（contentTree = null），
 * 但目录绝不允许没有元数据（那才是真正的孤儿）。
 */
import { isSkillId } from '../skill-id';
import { sanitizeName } from '../path-guard';
import type { MergePlan, MergeComponentName } from './types';

export class MergeValidationError extends Error {
  readonly code = 'GIT_MERGE_RESULT_INVALID';
  constructor(readonly reasons: string[]) {
    super(`GIT_MERGE_RESULT_INVALID: 合并结果校验失败：${reasons.join('；')}`);
    this.name = 'MergeValidationError';
  }
}

const OID_RE = /^[0-9a-f]{40,64}$/;
const VALID_COMPONENTS: MergeComponentName[] = ['content', 'metadata', 'report'];

/** 校验合并计划；违规抛 MergeValidationError（调用方不得落盘）。 */
export function validateMergePlan(plan: MergePlan): void {
  const reasons: string[] = [];
  if (!plan || typeof plan !== 'object' || !plan.skills || typeof plan.skills !== 'object') {
    throw new MergeValidationError(['合并计划结构非法']);
  }

  const folded = new Map<string, string>();

  for (const [skillId, skill] of Object.entries(plan.skills)) {
    if (!isSkillId(skillId)) {
      reasons.push(`Skill ID 非法：${skillId}`);
      continue;
    }
    if (!skill || typeof skill !== 'object') {
      reasons.push(`${skillId}：技能条目缺失`);
      continue;
    }
    if (skill.skillId !== skillId) {
      reasons.push(`${skillId}：条目 skillId 与键不一致（${String(skill.skillId)}）`);
    }
    const meta = skill.meta;
    if (!meta || typeof meta !== 'object') {
      // 「技能目录没有元数据」= 技能目录与元数据不一一对应
      reasons.push(`${skillId}：缺少元数据（技能目录与元数据不一一对应）`);
      continue;
    }
    const dirName = meta.dirName;
    if (typeof dirName !== 'string' || !dirName) {
      reasons.push(`${skillId}：目录名为空`);
    } else {
      if (dirName === '.' || dirName === '..' || dirName.includes('/') || dirName.includes('\\')) {
        reasons.push(`${skillId}：目录名越界（${dirName}）`);
      } else if (/^[a-zA-Z]:/.test(dirName) || dirName.startsWith('/') || dirName.startsWith('\\')) {
        reasons.push(`${skillId}：目录名是绝对路径（${dirName}）`);
      } else if (sanitizeName(dirName) !== dirName) {
        reasons.push(`${skillId}：目录名未通过清洗（${dirName} → ${sanitizeName(dirName)}）`);
      }
      const key = dirName.toLowerCase();
      const previous = folded.get(key);
      if (previous != null) {
        reasons.push(`目录名冲突：${previous} 与 ${skillId} 都使用 ${dirName}（大小写不敏感）`);
      } else {
        folded.set(key, skillId);
      }
    }
    if (skill.contentTree != null && !OID_RE.test(skill.contentTree)) {
      reasons.push(`${skillId}：内容树 OID 非法（${String(skill.contentTree)}）`);
    }
    if (skill.reportBlob != null && !OID_RE.test(skill.reportBlob)) {
      reasons.push(`${skillId}：评测报告 blob 非法（${String(skill.reportBlob)}）`);
    }
    if (!Array.isArray(meta.groups) || meta.groups.some((g) => typeof g !== 'string')) {
      reasons.push(`${skillId}：Group 列表非法`);
    }
    if (!meta.sync || !Array.isArray(meta.sync.agents) || meta.sync.agents.some((a) => typeof a !== 'string')) {
      reasons.push(`${skillId}：同步配置非法`);
    }
  }

  for (const conflict of plan.conflicts ?? []) {
    if (!isSkillId(conflict.skillId)) reasons.push(`冲突条目 Skill ID 非法：${conflict.skillId}`);
    if (!Array.isArray(conflict.components)) continue;
    for (const c of conflict.components) {
      if (!VALID_COMPONENTS.includes(c)) reasons.push(`冲突组件未知：${String(c)}`);
    }
  }

  if (reasons.length > 0) throw new MergeValidationError(reasons);
}
