/** 工作台 Agent 内置 Skill 的 frontmatter 读取。 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

/** 读取内置 Skill 的名称和描述；无效目录返回 null。 */
export function readBuiltinSkill(dir: string): { name: string | null; description: string | null } | null {
  const file = path.join(dir, 'SKILL.md');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return null;
  let parsed: unknown;
  try {
    parsed = yaml.load(lines.slice(1, end).join('\n'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const meta = parsed as Record<string, unknown>;
  return {
    name: typeof meta.name === 'string' ? meta.name.trim() || null : null,
    description: typeof meta.description === 'string' ? meta.description.trim() || null : null,
  };
}
