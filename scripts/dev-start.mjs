#!/usr/bin/env node
/**
 * 开发期一键启动（start.bat 的实体）。
 *
 *   1. 比对源码快照，只在前端/后端各自的源码有改动时构建（--force 强制全量）
 *   2. 按 backend/src/config.json 的 CURRENT_ENV 启动 Electron，可临时用 --env 覆盖
 *
 * 快照落在 .cache/dev-start-stamp.json（gitignore），内容为每个源文件的
 * mtime+size；路径集合参与比对，因此删除源文件同样会触发重建。
 *
 * 隔离纪律：开发态的一切路径（库 / 数据 / 临时 / 日志 / Agent 基目录）都由
 * backend/.env.development 决定，默认即隔离；不再靠 --isolated 之类的开关。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentEnv } from '../backend/scripts/env-mode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP_FILE = path.join(ROOT, '.cache', 'dev-start-stamp.json');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

const TARGETS = [
  {
    key: 'frontend',
    label: '前端',
    dir: path.join(ROOT, 'frontend'),
    inputs: ['src', 'public', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json'],
    outputs: ['dist/index.html'],
  },
  {
    key: 'backend',
    label: '后端',
    dir: path.join(ROOT, 'backend'),
    inputs: ['src', '../agents/src', '../agents/skills', '../agents/package.json', '../agents/tsconfig.json', 'tsconfig.json', 'package.json'],
    outputs: ['dist/main.js', '../agents/dist/index.js'],
  },
];

// Node ≥ 22.19 是 Pi 内核的硬约束
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(`[错误] 当前 Node ${process.versions.node}，项目要求 ≥ 22.19`);
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');
/** 环境文件已隔离数据；--isolated 只作兼容保留，不再注入任何东西。 */
const legacyIsolated = args.includes('--isolated');
const defaultMode = currentEnv();
const explicitMode = args.find((a) => a.startsWith('--env='))?.slice(6);
const legacyMode = args.includes('--dev') ? 'development' : args.includes('--uat') ? 'uat' : args.includes('--prod') ? 'production' : undefined;
const envMode = explicitMode ?? legacyMode ?? defaultMode;
if (!['development', 'uat', 'production'].includes(envMode)) throw new Error(`未知运行环境：${envMode}`);
const passthrough = args.filter(
  (a) => a !== '--force' && a !== '-f' && a !== '--isolated' && a !== '--dev' && a !== '--uat' && a !== '--prod' && !a.startsWith('--env='),
);

/** --runtime 是给截图/测试夹具的一次性覆盖（seed 目录），日常开发不需要。 */
const launchArgs = envMode === defaultMode ? passthrough : [`--env=${envMode}`, ...passthrough];
const runtimeDir = path.resolve(
  ROOT,
  (launchArgs.find((a) => a.startsWith('--runtime=')) ?? '--runtime=.').slice('--runtime='.length),
);

/** 读 backend/.env.<mode> 的 KEY=VALUE，仅用于启动时回显当前口径。 */
function readEnvFile(envMode) {
  try {
    const map = {};
    const text = readFileSync(path.join(ROOT, 'backend', `.env.${envMode}`), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const matched = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (matched) map[matched[1]] = matched[2].replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);
    }
    return map;
  } catch {
    return {};
  }
}

function shorten(target) {
  if (!target) return '<未配置>';
  const rel = path.relative(ROOT, path.resolve(target));
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : target;
}

function toKey(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function walk(abs, acc) {
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(abs))) return;
    for (const name of readdirSync(abs)) walk(path.join(abs, name), acc);
    return;
  }
  acc[toKey(abs)] = [Math.round(st.mtimeMs), st.size];
}

function collect(target) {
  const acc = {};
  for (const rel of target.inputs) walk(path.join(target.dir, rel), acc);
  return acc;
}

function diff(prev, next) {
  const added = [];
  const modified = [];
  const removed = [];
  for (const [key, value] of Object.entries(next)) {
    const old = prev[key];
    if (!old) added.push(key);
    else if (old[0] !== value[0] || old[1] !== value[1]) modified.push(key);
  }
  for (const key of Object.keys(prev)) if (!next[key]) removed.push(key);
  return { added, modified, removed };
}

function describe(d) {
  const total = d.added.length + d.modified.length + d.removed.length;
  const parts = [];
  if (d.modified.length) parts.push(`改 ${d.modified.length}`);
  if (d.added.length) parts.push(`增 ${d.added.length}`);
  if (d.removed.length) parts.push(`删 ${d.removed.length}`);
  const sample = [...d.modified, ...d.added, ...d.removed]
    .slice(0, 3)
    .map((k) => k.replace(/^(frontend|backend)\//, ''))
    .join('、');
  return `${total} 处改动（${parts.join(' / ')}）：${sample}${total > 3 ? ' …' : ''}`;
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(STAMP_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeStamp(stamp) {
  mkdirSync(path.dirname(STAMP_FILE), { recursive: true });
  writeFileSync(STAMP_FILE, JSON.stringify(stamp, null, 2));
}

console.log(`[启动] Skills 工作台 · ${envMode}`);
if (launchArgs.some((a) => a.startsWith('--runtime='))) {
  console.log(
    `[环境] 夹具 · 库 ${shorten(path.join(runtimeDir, 'lib'))}` +
      ` · 数据 ${shorten(path.join(runtimeDir, 'data'))}` +
      ` · home ${shorten(path.join(runtimeDir, 'user'))}`,
  );
} else {
  // 全部口径来自 backend/.env.<mode>，不在脚本里另说一套；
  // production 四键留空由 main.ts 运行时解析，这里按同口径回显兜底值。
  const envFile = readEnvFile(envMode);
  const localRoot = path.join(ROOT, envMode === 'uat' ? 'uat' : path.join('tests', 'dev'));
  const realHome = process.env.USERPROFILE || process.env.HOME || '';
  const homeDir = envFile.HOME_DIR
    || (envMode === 'production' ? realHome : path.join(localRoot, 'home'));
  const dataDir = envFile.DATA_DIR
    || (envMode === 'production'
      ? path.join(process.env.APPDATA || '', 'skills-studio')
      : path.join(localRoot, 'appdata'));
  const tempDir = envFile.TEMP_DIR || (envMode === 'production' ? '<SOFT_DIR>/tmp' : path.join(localRoot, 'tmp'));
  const libraryRoot = path.join(homeDir, '.skills-studio', 'skills-library');
  const label = envMode === 'uat' ? '验收 uat' : envMode === 'production' ? '生产' : '开发夹具';
  console.log(
    `[环境] ${label} · 库根 ${shorten(libraryRoot)}` +
      ` · home ${shorten(homeDir)}` +
      ` · 数据 ${shorten(dataDir)}` +
      ` · 临时 ${shorten(tempDir)}` +
      ` · adapter ${envFile.ADAPTERS || (envMode === 'production' ? 'ALL' : 'codebuddy,cursor')}（backend/.env.${envMode}）`,
  );
}
if (legacyIsolated) {
  console.log('[提示] 开发态已由 backend/.env.development 隔离，--isolated 不再需要');
}

const stamp = readStamp();
const pending = [];

for (const target of TARGETS) {
  const files = collect(target);
  const missing = target.outputs.filter((rel) => !existsSync(path.join(target.dir, rel)));
  if (force) {
    pending.push({ target, files, reason: '--force 强制全量' });
    continue;
  }
  if (missing.length > 0) {
    pending.push({ target, files, reason: `产物缺失（${missing.join(', ')}）` });
    continue;
  }
  if (stamp[target.key]?.mode !== envMode) {
    pending.push({ target, files, reason: `构建环境切换为 ${envMode}` });
    continue;
  }
  const result = diff(stamp[target.key]?.files ?? {}, files);
  if (result.added.length + result.modified.length + result.removed.length > 0) {
    pending.push({ target, files, reason: describe(result) });
  }
}

if (pending.length === 0) {
  console.log('[构建] 前后端源码无改动，跳过构建（需要全量请加 --force）');
}

for (const item of pending) {
  const started = Date.now();
  console.log(`[${item.target.label}] ${item.reason} → 构建中…`);
  const built = spawnSync('npm', ['run', 'build'], {
    cwd: item.target.dir,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, SKILLS_STUDIO_BUILD_ENV: envMode },
  });
  if (built.status !== 0) {
    console.error(`[${item.target.label}] 构建失败（exit ${built.status ?? 1}），已中止启动`);
    process.exit(built.status ?? 1);
  }
  stamp[item.target.key] = { files: item.files, mode: envMode, builtAt: new Date().toISOString() };
  writeStamp(stamp);
  console.log(`[${item.target.label}] 构建完成（${((Date.now() - started) / 1000).toFixed(1)}s）`);
}

// backend/scripts/start.mjs 通过 shell 调 `electron`，依赖 PATH 里有
// backend/node_modules/.bin；该目录平时由 `npm run` 注入，这里手动补齐。
const backendDir = path.join(ROOT, 'backend');
const binDir = path.join(backendDir, 'node_modules', '.bin');
const env = { ...process.env };
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
env[pathKey] = `${binDir}${path.delimiter}${env[pathKey] ?? ''}`;
delete env.ELECTRON_RUN_AS_NODE;

const launched = spawnSync(
  process.execPath,
  [path.join(backendDir, 'scripts', 'start.mjs'), ...launchArgs],
  { cwd: backendDir, stdio: 'inherit', env },
);
process.exit(launched.status ?? 1);
