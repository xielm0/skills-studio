import type { SkillStatus } from '../../../backend/src/shared/ipc';
import s from './SkillStatusTag.module.css';

const LABEL: Record<SkillStatus, string> = {
  'not-in-library': '未入库',
  'in-library': '已入库',
  synced: '已同步',
  conflict: '有冲突',
};

const TONE: Record<SkillStatus, string> = {
  'not-in-library': s.notInLibrary,
  'in-library': s.inLibrary,
  synced: s.synced,
  conflict: s.conflict,
};

/** 本机技能四态标签（安装 Skills 扫描结果与 Agents 页共用同一口径）。 */
export function SkillStatusTag({ status }: { status: SkillStatus }) {
  return (
    <span
      className={`${s.tag} ${TONE[status]}`}
      data-testid="skill-status"
      data-status={status}
    >
      {LABEL[status]}
    </span>
  );
}
