/**
 * T07：技能评测结果存储（prd.md §5.8、tec.md §5.8、用例 C-28）。
 *
 * 位置：中心库 `reports/<技能名>_review_<yyyyMMdd-HHmmss>.md`——不在 `skills/` 下，
 * 因此不会被部署到任何 Agent。
 * 规则：
 *  - 每个技能只保留**一份**当前结果：新报告落盘成功后，清理同技能的旧报告文件；
 *  - 写入用「同目录临时文件 → fsync → 回读校验 → rename」保证原子性：
 *    写入或校验失败时旧文件保持原样，不会出现半成品（此时可能两份并存，读取取最新）；
 *  - 空文本视为无效结果，直接拒绝（EVAL_REPORT_EMPTY），绝不用空文件覆盖旧报告；
 *  - 技能改名后旧报告按新名字找不到 → 视为无报告，下一次评测重建（已知取舍）。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSkillId } from '../../skill-id';
import { AgentRunError } from '../errors';

export interface EvalReportInfo {
  skillId: string;
  /** 报告文件绝对路径 */
  path: string;
  bytes: number;
  updatedAt: string;
}

/** 技能名解析：skillId → 当前技能名（取不到时由调用方返回 null，存储退回用 Skill ID 命名）。 */
export type ReportNameResolver = (skillId: string) => string | null;

/**
 * 从库服务生成报告命名解析器。
 *
 * 报告文件名主体用技能名（`<技能名>_review_<时间戳>.md`），但技能名不保证唯一
 * （导入同名技能、保留两边时会重名），重名时改用目录名，避免两个技能共用一份报告。
 */
export function reportNameResolver(library: {
  getSkillDetail(skillId: string): { name: string; dirName: string } | null;
  listSkills(): { skillId: string; name: string }[];
}): ReportNameResolver {
  return (skillId) => {
    const detail = library.getSkillDetail(skillId);
    if (!detail) return null;
    const duplicated = library
      .listSkills()
      .some((skill) => skill.skillId !== skillId && skill.name === detail.name);
    return duplicated ? detail.dirName : detail.name;
  };
}

/** 评测存储契约（测试可注入失败实现，验证「保存失败保留旧报告」）。 */
export interface EvalReportStoreLike {
  /** 该技能**当前**报告路径；尚无报告时返回按当前时间推出的将用路径（仅供展示） */
  path(skillId: string): string;
  has(skillId: string): boolean;
  read(skillId: string): string | null;
  save(skillId: string, text: string): EvalReportInfo;
  remove(skillId: string): boolean;
}

/** `名称_review_时间戳.md`；时间戳定宽，字典序即时间序。 */
const REPORT_FILE_RE = /^(.+)_review_(\d{8}-\d{6})\.md$/;

/** 解析报告文件名；不符合命名规则（含旧版 `<skillId>.md`）返回 null。 */
export function parseReportFile(file: string): { name: string; stamp: string } | null {
  const matched = REPORT_FILE_RE.exec(file);
  return matched ? { name: matched[1], stamp: matched[2] } : null;
}

/** 本地时间 `yyyyMMdd-HHmmss`。 */
export function reportStamp(date: Date = new Date()): string {  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * 文件名安全化：替换 Windows 非法字符与控制字符，去掉首尾空白和结尾句点，
 * 并限制长度（超长文件名在 Windows 上会直接失败）。全部剥空时退回 fallback。
 */
export function safeReportName(raw: string, fallback: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return [...(cleaned.length > 0 ? cleaned : fallback)].slice(0, 80).join('');
}

export class EvalReportStore implements EvalReportStoreLike {
  /** <中心库>/reports */
  readonly reportsDir: string;
  private readonly resolveName: ReportNameResolver | undefined;

  constructor(reportsDir: string, resolveName?: ReportNameResolver) {
    this.reportsDir = path.resolve(reportsDir);
    this.resolveName = resolveName;
  }

  /** 技能当前名（已安全化）；解析不到时退回 Skill ID。 */
  private nameOf(skillId: string): string {
    if (!isSkillId(skillId)) {
      throw new AgentRunError('EVAL_SAVE_FAILED', `评测报告路径非法：Skill ID ${skillId}`);
    }
    return safeReportName(this.resolveName?.(skillId) ?? '', skillId);
  }

  /** 该技能已存在的报告文件名，按时间从旧到新排序。 */
  private filesOf(name: string): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.reportsDir);
    } catch {
      return [];
    }
    return entries
      .filter((file) => REPORT_FILE_RE.exec(file)?.[1] === name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** 报告文件路径（当前最新一份；没有则给出按当前时间推出的路径）。 */
  path(skillId: string): string {
    const name = this.nameOf(skillId);
    const latest = this.filesOf(name).at(-1);
    return path.join(this.reportsDir, latest ?? `${name}_review_${reportStamp()}.md`);
  }

  /** 是否存在「可用」的当前报告（文件存在且非空）。 */
  has(skillId: string): boolean {
    const name = this.nameOf(skillId);
    const latest = this.filesOf(name).at(-1);
    if (!latest) return false;
    try {
      const stat = fs.statSync(path.join(this.reportsDir, latest));
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  read(skillId: string): string | null {
    const name = this.nameOf(skillId);
    const latest = this.filesOf(name).at(-1);
    if (!latest) return null;
    try {
      return fs.readFileSync(path.join(this.reportsDir, latest), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * 原子写入新报告并清理同技能旧报告。仅当新文件完整落盘并回读一致后才删除旧文件；
   * 失败抛 EVAL_SAVE_FAILED；空文本抛 EVAL_REPORT_EMPTY。
   */
  save(skillId: string, text: string): EvalReportInfo {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new AgentRunError('EVAL_REPORT_EMPTY', '本次评测没有产生任何报告文本，已保留旧报告。');
    }
    const name = this.nameOf(skillId);
    const previous = this.filesOf(name);
    const fileName = `${name}_review_${reportStamp()}.md`;
    const target = path.join(this.reportsDir, fileName);
    let tmp = '';
    try {
      fs.mkdirSync(this.reportsDir, { recursive: true });
      tmp = path.join(
        this.reportsDir,
        `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
      );
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, text, 'utf8');
        fs.fsyncSync(fd); // 先落盘，避免 rename 后内容仍在内核缓冲
      } finally {
        fs.closeSync(fd);
      }
      const written = fs.readFileSync(tmp, 'utf8');
      if (written !== text) {
        throw new AgentRunError('EVAL_SAVE_FAILED', '评测报告写入校验失败（内容不完整），已保留旧报告。');
      }
      fs.renameSync(tmp, target); // 同目录 rename：Windows 上原子覆盖
      tmp = '';
    } catch (err) {
      if (tmp) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* 清理临时文件失败不改变结果 */
        }
      }
      if (err instanceof AgentRunError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new AgentRunError('EVAL_SAVE_FAILED', `评测报告保存失败：${message.slice(0, 300)}`);
    }
    // 新报告已安全落盘，再清理旧报告；删不掉只会多留一份，读取仍取最新
    for (const file of previous) {
      if (file === fileName) continue; // 同一秒内再次保存：目标文件就是自己，不能删
      try {
        fs.rmSync(path.join(this.reportsDir, file), { force: true });
      } catch {
        /* 旧报告清理失败不改变保存结果 */
      }
    }
    const stat = fs.statSync(target);
    return {
      skillId,
      path: target,
      bytes: stat.size,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    };
  }

  /** 删除该技能的全部报告（技能删除时清理；没有任何报告返回 false）。 */
  remove(skillId: string): boolean {
    const name = this.nameOf(skillId);
    const files = this.filesOf(name);
    if (files.length === 0) return false;
    let removed = false;
    for (const file of files) {
      try {
        fs.rmSync(path.join(this.reportsDir, file), { force: true });
        removed = true;
      } catch {
        /* 单个文件删不掉不改变其它文件的处理 */
      }
    }
    return removed;
  }
}
