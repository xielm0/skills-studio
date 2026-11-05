import { readFileSync } from 'node:fs';

export function currentEnv() {
  const { CURRENT_ENV } = JSON.parse(readFileSync(new URL('../src/config.json', import.meta.url), 'utf8'));
  if (CURRENT_ENV === 'development' || CURRENT_ENV === 'uat' || CURRENT_ENV === 'production') return CURRENT_ENV;
  throw new Error(`未知运行环境：${String(CURRENT_ENV)}`);
}

/** 源码启动脚本可把一次性环境选择传给前后端构建；发版脚本以 CURRENT_ENV 为准。 */
export function buildEnv() {
  const value = process.env.SKILLS_STUDIO_BUILD_ENV ?? currentEnv();
  if (value === 'development' || value === 'uat' || value === 'production') return value;
  throw new Error(`未知构建环境：${value}`);
}
