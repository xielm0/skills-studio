/**
 * SKILL.md frontmatter 解析（prd.md 5.1：技能判定 = 目录含 SKILL.md，兼容小写 skill.md；
 * 名称优先 frontmatter name，缺失回退目录名）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

export const SKILL_MD_FILES = ['SKILL.md', 'skill.md'] as const;
export type SkillMdFileName = (typeof SKILL_MD_FILES)[number];

export interface SkillMdMeta {
  name: string | null;
  description: string | null;
}

/** 解析 YAML frontmatter；无 frontmatter 或解析失败时字段为 null。 */
export function parseFrontmatter(content: string): SkillMdMeta {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { name: null, description: null };

  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return { name: null, description: null };

  let parsed: unknown;
  try {
    parsed = yaml.load(lines.slice(1, end).join('\n'));
  } catch {
    return { name: null, description: null };
  }
  if (parsed == null || typeof parsed !== 'object') return { name: null, description: null };

  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === 'string' && obj.name.trim().length > 0 ? obj.name.trim() : null;
  const description =
    typeof obj.description === 'string' && obj.description.trim().length > 0
      ? obj.description.trim()
      : null;
  return { name, description };
}

/** 目录中实际存在的技能标记文件名；两者都有时优先 SKILL.md。 */
export function findSkillMdFile(dir: string): SkillMdFileName | null {
  for (const name of SKILL_MD_FILES) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return name;
    } catch {
      /* 不存在，继续尝试下一个候选 */
    }
  }
  return null;
}

/** 目录是否为技能目录（含 SKILL.md 或 skill.md）。 */
export function isSkillDir(dir: string): boolean {
  return findSkillMdFile(dir) !== null;
}

/** 读取并解析目录中的技能标记文件；不是技能目录时返回 null。 */
export function readSkillMd(dir: string): { fileName: SkillMdFileName; meta: SkillMdMeta } | null {
  const fileName = findSkillMdFile(dir);
  if (!fileName) return null;
  let content: string;
  try {
    content = fs.readFileSync(path.join(dir, fileName), 'utf8');
  } catch {
    return null;
  }
  return { fileName, meta: parseFrontmatter(content) };
}
