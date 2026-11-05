/**
 * 库扫描（2026-11-02 起支持一层分组子目录，口径与 Agent 目录嵌套扫描一致：
 * `skills/<技能名>/` 与 `skills/<组>/<技能名>/`；父目录自带 SKILL.md 即视为技能、不下钻；
 * 相对 skills 根 ≤2 层）。技能判定 = 目录含 SKILL.md/skill.md。
 * 点开头目录（.meta/.git 等）不参与判定——.meta 收元数据，.git 是备份仓库。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readSkillMd } from './frontmatter';
import { SKILL_META_DIRNAME } from '../infra/fs-meta';
import { sanitizeName } from './path-guard';
import type { SkillNameSource } from './types';

export interface ScannedSkillDir {
  /** 技能目录末段名（元数据 json 文件名与关联键） */
  dirName: string;
  /** 相对 skills 根的路径（'/' 分隔，1-2 段；平铺 = dirName） */
  relPath: string;
  path: string;
  skillMdFile: 'SKILL.md' | 'skill.md';
  /** 展示名：frontmatter name（清洗后）或目录名 */
  name: string;
  nameSource: SkillNameSource;
  description: string;
}

export interface ScanResult {
  skills: ScannedSkillDir[];
}

function isInternalDirName(name: string): boolean {
  return name.startsWith('.') || name === SKILL_META_DIRNAME;
}

/** 扫描 <库>/skills/：顶层含 SKILL.md 即技能；否则作为组目录下钻一层（命中即停）。 */
export function scanSkillsDir(skillsDir: string): ScanResult {
  const skills: ScannedSkillDir[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return { skills }; // skills/ 不存在视为空库
  }

  const push = (dir: string, relPath: string, dirName: string): void => {
    const skillMd = readSkillMd(dir);
    if (!skillMd) return;
    const frontmatterName =
      skillMd.meta.name != null ? sanitizeName(skillMd.meta.name).trim() : '';
    const useFrontmatter = frontmatterName.length > 0;
    skills.push({
      dirName,
      relPath,
      path: dir,
      skillMdFile: skillMd.fileName,
      name: useFrontmatter ? frontmatterName : dirName,
      nameSource: useFrontmatter ? 'frontmatter' : 'dirname',
      description: skillMd.meta.description ?? '',
    });
  };

  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // 元数据等文件不参与判定
    if (isInternalDirName(entry.name)) continue;

    const dir = path.join(skillsDir, entry.name);
    // 父目录自带 SKILL.md → 本身就是技能，不下钻
    if (readSkillMd(dir) != null) {
      push(dir, entry.name, entry.name);
      continue;
    }

    // 组目录：下钻一层找技能
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || isInternalDirName(child.name)) continue;
      push(path.join(dir, child.name), `${entry.name}/${child.name}`, child.name);
    }
  }

  // 同名两份（如顶层一份 + 组内一份）＝异常：取位置最浅的一份，其余忽略
  const byDirName = new Map<string, ScannedSkillDir>();
  for (const skill of skills) {
    const kept = byDirName.get(skill.dirName);
    if (kept == null) {
      byDirName.set(skill.dirName, skill);
      continue;
    }
    const depth = (p: string) => p.split('/').length;
    if (depth(skill.relPath) < depth(kept.relPath)) byDirName.set(skill.dirName, skill);
  }

  const deduped = [...byDirName.values()];
  deduped.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { skills: deduped };
}

/**
 * 收集 skills/ 下现有技能位置（相对路径集合，扫描口径同 scanSkillsDir）。
 * 供合并落盘的「计划外技能清理」使用。
 */
export function collectLocalSkillRels(skillsDir: string): Set<string> {
  return new Set(scanSkillsDir(skillsDir).skills.map((s) => s.relPath));
}
