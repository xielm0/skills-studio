import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { buildEnv } from './env-mode.mjs';

console.log(`backend build environment: ${buildEnv()}`);

const agent = spawnSync('npm', ['run', 'build', '--prefix', '../agents'], { stdio: 'inherit', shell: true });
if (agent.status !== 0) process.exit(agent.status ?? 1);

const tsc = spawnSync('tsc', ['-p', '.'], { stdio: 'inherit', shell: true });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

// 旧构建可能留有迁移前的内置 Skill 副本；当前唯一来源是 agents/dist/skills。
rmSync('dist/resources/agent-skills', { recursive: true, force: true });

// tsc 不搬运非 TS 资源，占位页需要手动复制
// （skills-studio 管理 skill 源在 agents/skills/，随 agents 构建进 dist/skills，此处不再单独复制）
cpSync('src/placeholder.html', 'dist/placeholder.html');
console.log('backend build ok -> dist/main.js');
