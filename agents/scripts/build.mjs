import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';

// Agent 的 TypeScript 与内置 Skills 一起构建，供后端作为本地包引用。
const result = spawnSync('tsc', ['-p', '.'], { stdio: 'inherit', shell: true });
if (result.status !== 0) process.exit(result.status ?? 1);
cpSync('skills', 'dist/skills', { recursive: true });
console.log('agents build ok -> dist/index.js');
