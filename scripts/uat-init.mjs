#!/usr/bin/env node
/**
 * uat_init —— 把人工验收环境重置成「真机镜像」（只手动执行，任何脚本都不会调用它）。
 *
 *   1. 读 backend/.env.uat：两个根（SOFT_DIR / DATA_DIR）与 ADAPTERS（本次生效的 Agent），
 *      其余路径复用 backend/dist/env.js 的 deriveEnvPaths（与主进程同一套规则）
 *   2. 清空 uat 根（仓库根 uat/）：home / appdata / tmp 一并删除
 *   3. 按 ADAPTERS 把真机 <USERPROFILE>/<agent 技能目录> 原样复制进来：
 *      实体目录照抄内容、符号链接/junction 照抄成同目标的链接（悬空链接也照抄）
 *   4. 只重建 HOME_DIR 与各 Agent 的 skills 目录；库 / appdata / tmp 交给应用自己创建
 *
 * 默认是 dry-run，只打印清单不动文件；带 --yes 才真正删除并复制。
 *
 * 隔离纪律：所有写操作只发生在清空范围内（uat/ 下）；真机 Agent 目录只读。
 * 与自动化夹具互不影响：tests/dev、tests/runtime 不归本脚本管。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UAT_ROOT = path.join(ROOT, 'uat');
const ENV_DIST = path.join(ROOT, 'backend', 'dist', 'env.js');
const AGENTS_DIST = path.join(ROOT, 'backend', 'dist', 'domain', 'agents.js');

const args = process.argv.slice(2);
const KNOWN = new Set(['--yes', '-y', '--help', '-h']);

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      '用法：node scripts/uat-init.mjs [--yes]',
      '',
      '  默认 dry-run：只打印将删除 / 将复制的清单，不改动任何文件。',
      '  --yes        真正执行（清空 uat/，再复制真机技能）',
      '',
      '配置来源：backend/.env.uat 的 HOME_DIR 与 ADAPTERS',
    ].join('\n'),
  );
  process.exit(0);
}

const unknown = args.filter((a) => !KNOWN.has(a));
if (unknown.length > 0) {
  console.error(`[错误] 不认识的参数：${unknown.join(' ')}（用 --help 看用法）`);
  process.exit(1);
}

const confirmed = args.includes('--yes') || args.includes('-y');

/** 相对仓库根展示；仓库外的路径原样返回。 */
function shorten(target) {
  if (!target) return '<未配置>';
  const rel = path.relative(ROOT, path.resolve(target));
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : path.resolve(target);
}

function norm(p) {
  return path.resolve(p).toLowerCase().replace(/\\/g, '/');
}

/** child 是否严格位于 parent 之下（不含相等）。 */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 列出目录的直接子项及其项数，用于 dry-run 的删除清单。 */
function inventory(dir) {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => {
    let count = 0;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      try {
        count = readdirSync(path.join(dir, entry.name)).length;
      } catch {
        count = 0;
      }
    }
    return { name: entry.name, isDir: entry.isDirectory(), count };
  });
}

/** 只读探测：把真机 skills 目录的内容分类（不复制）。 */
function inspectEntries(srcDir) {
  const items = [];
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      const raw = readlinkSync(path.join(srcDir, entry.name));
      const target = raw.replace(/^\\\\\?\\/, '');
      const abs = path.isAbsolute(target) ? target : path.resolve(srcDir, target);
      items.push({ name: entry.name, kind: 'link', target, dangling: !existsSync(abs) });
    } else if (entry.isDirectory()) {
      items.push({ name: entry.name, kind: 'dir' });
    } else {
      items.push({ name: entry.name, kind: 'file' });
    }
  }
  return items;
}

/** 一条链接照抄成链接；建符号链接无权限时退回 junction（Node 同判为链接）。 */
function copyLink(item, srcDir, to, report) {
  try {
    symlinkSync(item.target, to, 'dir');
    return true;
  } catch (err) {
    // 相对链接的兜底：按源侧位置解析成绝对路径，再建 junction
    const absolute = path.isAbsolute(item.target) ? item.target : path.resolve(srcDir, item.target);
    try {
      symlinkSync(absolute, to, 'junction');
      report.junctionFallback.push(item.name);
      return true;
    } catch (err2) {
      report.failed.push(`${item.name}（链接：${err2.code ?? err.message}）`);
      return false;
    }
  }
}

function copyEntries(srcDir, dstDir, items) {
  const report = { dirs: [], links: [], files: [], dangling: [], junctionFallback: [], failed: [] };
  for (const item of items) {
    const to = path.join(dstDir, item.name);
    if (item.kind === 'link') {
      if (copyLink(item, srcDir, to, report)) report.links.push(item.name);
      if (item.dangling) report.dangling.push(item.name);
      continue;
    }
    try {
      if (item.kind === 'dir') {
        // dereference:false + verbatimSymlinks:true —— 技能内部的链接也照抄成链接
        cpSync(path.join(srcDir, item.name), to, {
          recursive: true,
          force: true,
          dereference: false,
          verbatimSymlinks: true,
        });
        report.dirs.push(item.name);
      } else {
        cpSync(path.join(srcDir, item.name), to, { force: true, dereference: false, verbatimSymlinks: true });
        report.files.push(item.name);
      }
    } catch (err) {
      report.failed.push(`${item.name}（${err.code ?? err.message}）`);
    }
  }
  return report;
}

// ---------- 1. 配置（唯一真相：backend/dist/env.js 的 loadEnv('uat')） ----------
const requireDist = createRequire(import.meta.url);
let env;
try {
  env = requireDist(ENV_DIST).loadEnv('uat');
} catch (err) {
  console.error(`[错误] 读不到 ${shorten(ENV_DIST)} 或 .env.uat：${err.message}；先执行 cd backend && npm run build`);
  process.exit(1);
}

const CLEAR_ROOT = path.dirname(path.resolve(env.HOME_DIR)); // uat 根：home / appdata / tmp 都在它下面
const HOME_DIR = path.resolve(env.HOME_DIR);
const ADAPTERS = env.ADAPTERS || 'ALL';

// ---------- 2. 安全校验：只清仓库内的数据根 ----------
if (!isInside(ROOT, CLEAR_ROOT) || norm(CLEAR_ROOT) === norm(ROOT)) {
  console.error(`[错误] 数据根必须严格位于仓库内且不能是仓库根，当前是 ${CLEAR_ROOT}`);
  process.exit(1);
}
if (norm(CLEAR_ROOT) !== norm(UAT_ROOT)) {
  console.error(`[错误] .env.uat 的 DATA_DIR 必须指向仓库根 uat/，当前是 ${CLEAR_ROOT}`);
  process.exit(1);
}
if (!isInside(CLEAR_ROOT, HOME_DIR)) {
  console.error(`[错误] HOME_DIR 必须位于数据根之下，当前是 ${HOME_DIR}`);
  process.exit(1);
}


// ---------- 3. Agent 清单（唯一真相：backend/dist 的 BUILTIN_AGENTS） ----------
if (!existsSync(AGENTS_DIST)) {
  console.error(`[错误] ${shorten(AGENTS_DIST)} 不存在，无法确定各 Agent 的技能目录\n       先执行：cd backend && npm run build`);
  process.exit(1);
}
let agents;
try {
  agents = requireDist(AGENTS_DIST).selectBuiltinAgents(ADAPTERS);
} catch (err) {
  console.error(`[错误] ADAPTERS（${ADAPTERS}）解析失败：${err.message}`);
  process.exit(1);
}

const REAL_HOME = process.env.USERPROFILE || os.homedir();

// ---------- 4. 出计划（dry-run 与执行共用） ----------
const plan = agents.map((def) => {
  const src = path.join(REAL_HOME, def.skillsDirRel);
  const dst = path.join(HOME_DIR, def.skillsDirRel);
  const exists = existsSync(src);
  return { id: def.id, src, dst, exists, items: exists ? inspectEntries(src) : [] };
});

console.log(`[配置] home ${shorten(HOME_DIR)} · adapter ${agents.map((a) => a.id).join(', ')}（backend/.env.uat）`);

if (existsSync(CLEAR_ROOT)) {
  const children = inventory(CLEAR_ROOT);
  const listing = children.map((c) => `${c.name}/${c.isDir ? `(${c.count} 项)` : ''}`).join('、');
  console.log(`[清空] ${shorten(CLEAR_ROOT)} → ${listing || '（空目录）'}`);
  const libSkills = path.join(CLEAR_ROOT, '.skills-studio', 'skills-library', 'skills');
  if (existsSync(libSkills)) {
    console.log(`[清空] ${shorten(libSkills)} 现有 ${readdirSync(libSkills).length} 个技能，一并删除`);
  }
} else {
  console.log(`[清空] ${shorten(CLEAR_ROOT)} 不存在，跳过`);
}

const totals = { dirs: 0, links: 0, files: 0, dangling: 0 };
for (const item of plan) {
  if (!item.exists) {
    console.log(`[复制] ${item.id.padEnd(10)} 真机无此目录，跳过：${item.src}`);
    continue;
  }
  const count = (kind) => item.items.filter((i) => i.kind === kind).length;
  const dangling = item.items.filter((i) => i.dangling).length;
  totals.dirs += count('dir');
  totals.links += count('link');
  totals.files += count('file');
  totals.dangling += dangling;
  console.log(
    `[复制] ${item.id.padEnd(10)} ← ${shorten(item.src)}  实体 ${count('dir')} · 链接 ${count('link')} · 文件 ${count('file')}` +
      (dangling > 0 ? ` · 悬空 ${dangling}` : ''),
  );
}

if (!confirmed) {
  console.log('');
  console.log(
    `[提示] 这是 dry-run，没有改动任何文件。确认执行：node scripts/uat-init.mjs --yes` +
      `（将删除 ${shorten(CLEAR_ROOT)} 全部内容）`,
  );
  process.exit(0);
}

// ---------- 5. 执行：清空 → 重建 home 与 skills 目录 → 复制 ----------
rmSync(CLEAR_ROOT, { recursive: true, force: true });
mkdirSync(HOME_DIR, { recursive: true });
console.log(`[执行] 已清空并重建 ${shorten(HOME_DIR)}`);

let failed = 0;
for (const item of plan) {
  if (!item.exists) continue;
  mkdirSync(item.dst, { recursive: true });
  const report = copyEntries(item.src, item.dst, item.items);
  failed += report.failed.length;
  const notes = [];
  if (report.junctionFallback.length > 0) notes.push(`junction 兜底 ${report.junctionFallback.length}`);
  if (report.dangling.length > 0) notes.push(`悬空链接 ${report.dangling.join('、')}`);
  if (report.failed.length > 0) notes.push(`失败 ${report.failed.join('、')}`);
  console.log(
    `[完成] ${item.id.padEnd(10)} 实体 ${report.dirs.length} · 链接 ${report.links.length} · 文件 ${report.files.length}` +
      (notes.length > 0 ? `  ${notes.join(' · ')}` : ''),
  );
}

console.log('');
console.log(
  `[汇总] ${plan.filter((p) => p.exists).length}/${plan.length} 个 Agent · 实体 ${totals.dirs} · 链接 ${totals.links} · 文件 ${totals.files}` +
    (totals.dangling > 0 ? ` · 悬空 ${totals.dangling}` : ''),
);
console.log(`[提示] 库 / appdata / tmp 未预建，由应用首次运行时创建；启动：start.bat（PowerShell 下用 cmd /c start.bat）`);

if (failed > 0) {
  console.error(`[错误] 有 ${failed} 项复制失败，见上方明细`);
  process.exit(1);
}
