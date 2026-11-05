/**
 * CLI 版本化发布（tec.md §5.14：CLI 随应用分发给用户目录下的固定位置）。
 *
 * 三条约束来自竞品踩坑（tec.md §3.3 / §5.14）：
 *  1. **复制，不建链接**：Windows 建符号链接需要权限，且安装目录可能被整体替换；
 *  2. **带版本戳**：过期二进制比没有二进制更危险（旧版曾因版本滞后误删用户未托管目录），
 *     所以每次发布都覆盖写 + 回读校验哈希 + 写 version.json；
 *  3. 发布是幂等的：重复发布同一版本时刷新时间戳与校验值，不留下半成品。
 *
 * 发布产物是一个可独立运行的目录（`node <target>/cli.js` 即可，无需 Electron）：
 *  - 程序文件：`dist/` 下的 cli.js / env.js / logger.js / cli-publish.js / domain / infra / resources
 *    （dist/cli.js 是 CJS 多文件产物，只复制它自己会在 require('./env') 处崩掉）；
 *  - 运行依赖：从 CLI 产物静态 require 扫描出的闭包（adm-zip / js-yaml 等），
 *    加 @skills-studio/agent（只取 dist/skills 内部技能静态资源，不递归其依赖）。
 *    Pi 及厂商 SDK 是会话内核的依赖，属 agent/GUI 部分——CLI 不带（CLI/Agent/GUI 三部分边界）；
 *  - skills.cmd：node 调同目录 cli.js（PATH 注册留 T17）。
 *
 * 重复发布时若依赖闭包未变（同名同版本），跳过 node_modules 复制以缩短首启时间。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { currentEnv, type AppEnvMode } from './env';

import { realHome } from './env';

export const CLI_PUBLISH_SCHEMA_VERSION = 4;
/** 发布根：home 固定根 `.skills-studio`（恒存在）。中心库默认在其下 `skills-library/`，可整体搬走——bin/ 常驻不随库移动。 */
export const CLI_ROOT_DIR_NAME = '.skills-studio';
/** 发布产物子目录：`<home>/.skills-studio/bin`（SKILL.md 按此固定路径寻址 CLI）。 */
export const CLI_BIN_SUBDIR = 'bin';

/** dist 下不进入 CLI 发布产物的文件（Electron 专用，CLI 永远不 require）。 */
const EXCLUDED_PROGRAM_FILES = new Set(['main.js', 'preload.js', 'placeholder.html']);
/** 需要整棵复制的程序目录 */
const PROGRAM_DIRS = ['domain', 'infra', 'resources'];
/** 目标目录里由本模块管理、可以安全删除的固定文件名 */
const MANAGED_FILES = new Set(['cli.js', 'cli-publish.js', 'env.js', 'logger.js', 'skills.cmd', 'version.json', 'package.json', '.env.selected']);

export interface CliVersionStamp {
  schemaVersion: number;
  mode: AppEnvMode;
  envSha256: string;
  /** CLI 语义版本（与 backend/package.json 一致） */
  version: string;
  publishedAt: string;
  /** 发布后的 cli.js 内容 SHA-256（回读校验值） */
  cliSha256: string;
  /** 发布来源（构建产物绝对路径，仅本机排障用） */
  sourceCli: string;
  /** 入口文件清单（脚本依赖：必须存在且对得上版本戳） */
  files: string[];
  /** 程序文件（上次发布写入的顶层文件名，供下次清理过期文件） */
  programFiles?: string[];
  /** 依赖闭包指纹（name@version 排序后的哈希；用于跳过重复复制） */
  runtimeClosure?: string;
  /** 依赖包数量 */
  dependencyCount?: number;
  /** 安装根（SOFT_DIR）：CLI 借此上报内部技能目录 <installDir>/agents/skills */
  installDir?: string;
}

export interface PublishCliOptions {
  /** 与主进程相同的环境选择和环境文件。 */
  mode?: AppEnvMode;
  envFile?: string;
  /** 目标目录；缺省 `<homeDir>/.skills-studio/bin`（homeDir 缺省时取真实用户目录） */
  targetDir?: string;
  /** 源 cli.js；缺省 <dist>/cli.js（本模块编译后与 cli.js 同级） */
  sourceCli?: string;
  /** 覆盖版本号（测试用）；缺省读 backend/package.json */
  version?: string;
  /** 覆盖时间戳（测试用） */
  now?: () => Date;
  /** 强制重新复制依赖（默认按指纹跳过） */
  force?: boolean;
  /** 安装根（SOFT_DIR）：写入版本戳，CLI version 借此上报内部技能目录；缺省不写 */
  installRoot?: string;
}

export interface PublishCliResult {
  version: string;
  targetDir: string;
  cliPath: string;
  cmdPath: string;
  versionPath: string;
  cliSha256: string;
  dependencyCount: number;
  /** 覆盖前的版本戳（没有则为 null） */
  previousVersion: string | null;
  publishedAt: string;
  /** 本次发布是否改变了目标内容（版本/内容/依赖有变化） */
  changed: boolean;
  /** 是否重新复制了 node_modules（命中指纹时跳过） */
  dependenciesCopied: boolean;
}

/**
 * 默认发布目录：`<homeDir>/.skills-studio/bin`。
 * homeDir 由调用方显式传入（主进程传 env.HOME_DIR，开发/uat 即隔离夹具，不写真实主目录）；
 * 缺省才落到真实用户目录（生产语义）。
 */
export function defaultCliPublishDir(homeDir?: string): string {
  const home = homeDir && homeDir.trim() !== '' ? path.resolve(homeDir) : realHome();
  return path.join(home, CLI_ROOT_DIR_NAME, CLI_BIN_SUBDIR);
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 读取已发布目录的版本戳；缺失或损坏返回 null（过期判断由调用方做）。 */
export function readCliVersionStamp(dir: string = defaultCliPublishDir()): CliVersionStamp | null {
  const parsed = readJson<CliVersionStamp>(path.join(dir, 'version.json'));
  if (!parsed || typeof parsed.version !== 'string' || typeof parsed.cliSha256 !== 'string') return null;
  return parsed;
}

interface DependencyClosure {
  /** name@version（排序） */
  entries: string[];
  /** 必需但缺失的包（optional 依赖缺失属正常，例如其他平台的 fsevents） */
  missingRequired: string[];
  fingerprint: string;
}

interface PackageJson {
  name?: string;
  version?: string;
  type?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function resolvePackageDir(appRoot: string, name: string): string | null {
  const dir = path.join(appRoot, 'node_modules', ...name.split('/'));
  return fs.existsSync(path.join(dir, 'package.json')) ? dir : null;
}

/** 扫描根依赖时排除的包：electron 只在 GUI 链路惰性加载，CLI 运行时永远不会走到。 */
const CLOSURE_ROOT_EXCLUDES = new Set(['electron']);
/**
 * 进发布副本但不递归其 dependencies 的包：CLI 只取 @skills-studio/agent 的静态资源
 * （dist/skills 内部技能），从不加载它的运行时代码——Pi 及厂商 SDK 是会话内核的依赖，
 * 属于 agent 部分而非 CLI 部分（CLI/Agent/GUI 三部分边界）。
 */
const CLOSURE_NO_RECURSE = new Set(['@skills-studio/agent']);

/** 扫描 CLI 产物（dist 顶层 + domain/infra/resources）里静态 require 的外部包名。 */
function scanCliExternalRequires(distDir: string): string[] {
  const found = new Set<string>();
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const code = fs.readFileSync(full, 'utf8');
      for (const match of code.matchAll(/require\(\s*["']([^"'./][^"']*)["']\s*\)/g)) {
        const spec = match[1];
        if (spec.startsWith('node:')) continue;
        found.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      }
    }
  };
  visit(distDir);
  return [...found].sort();
}

/**
 * CLI 运行依赖闭包：从 CLI 产物静态 require 的外部包出发，递归各自 dependencies。
 * 不从 backend/package.json 全量 dependencies 出发——那是 GUI/Agent 的依赖面，
 * 混进来会让发布副本多搬 200MB+ 的 Pi 生态，首启发布因此拖到分钟级。
 */
function collectDependencyClosure(appRoot: string, distDir: string): DependencyClosure {
  const roots = scanCliExternalRequires(distDir).filter((name) => !CLOSURE_ROOT_EXCLUDES.has(name));
  if (roots.length === 0) throw new Error(`CLI 产物未扫描到任何外部依赖：${distDir}`);
  const queue = roots.map((name) => ({ name, recurse: !CLOSURE_NO_RECURSE.has(name) }));
  const optional = new Set<string>();
  const seen = new Set<string>();
  const missing: string[] = [];
  const entries: string[] = [];

  while (queue.length > 0) {
    const item = queue.shift() as { name: string; recurse: boolean };
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    const dir = resolvePackageDir(appRoot, item.name);
    if (dir == null) {
      missing.push(item.name);
      continue;
    }
    const pkg = readJson<PackageJson>(path.join(dir, 'package.json'));
    entries.push(`${item.name}@${pkg?.version ?? '0.0.0'}`);
    if (!item.recurse) continue;
    for (const dep of Object.keys(pkg?.dependencies ?? {})) if (!seen.has(dep)) queue.push({ name: dep, recurse: true });
    for (const dep of Object.keys(pkg?.optionalDependencies ?? {})) {
      optional.add(dep);
      if (!seen.has(dep)) queue.push({ name: dep, recurse: true });
    }
  }

  entries.sort();
  return {
    entries,
    missingRequired: missing.filter((name) => !optional.has(name)),
    fingerprint: crypto.createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16),
  };
}

function copyDirFresh(src: string, dst: string): void {
  fs.rmSync(dst, { recursive: true, force: true });
  if (fs.lstatSync(src).isSymbolicLink()) {
    // file:../agents 在 npm 安装后是 junction；发布目录必须带实体文件，不能链接回源码。
    const source = fs.realpathSync(src);
    const pkg = readJson<PackageJson>(path.join(source, 'package.json'));
    if (pkg?.name === '@skills-studio/agent') {
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(path.join(source, 'package.json'), path.join(dst, 'package.json'));
      fs.cpSync(path.join(source, 'dist'), path.join(dst, 'dist'), { recursive: true });
      return;
    }
  }
  fs.cpSync(src, dst, { recursive: true, force: true });
}

/**
 * 副本 node_modules 对账：删除不在当前闭包内的顶层包。
 * 闭包收窄（schemaVersion 3 起）后，旧副本里遗留的 Pi 生态必须清掉——
 * 留着不只占空间，还会让「副本内容 = 版本戳描述」的承诺失真。
 */
function pruneExtraneousPackages(targetDir: string, keep: ReadonlySet<string>): void {
  const nmRoot = path.join(targetDir, 'node_modules');
  if (!fs.existsSync(nmRoot)) return;
  for (const top of fs.readdirSync(nmRoot, { withFileTypes: true })) {
    if (!top.isDirectory()) continue;
    if (top.name.startsWith('@')) {
      const scopeDir = path.join(nmRoot, top.name);
      for (const sub of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        if (!keep.has(`${top.name}/${sub.name}`)) {
          fs.rmSync(path.join(scopeDir, sub.name), { recursive: true, force: true });
        }
      }
      if (fs.readdirSync(scopeDir).length === 0) fs.rmSync(scopeDir, { recursive: true, force: true });
    } else if (!keep.has(top.name)) {
      fs.rmSync(path.join(nmRoot, top.name), { recursive: true, force: true });
    }
  }
}

/**
 * 发布 CLI。失败抛错，且版本戳最后写——版本戳存在即代表程序文件与依赖都已就位。
 */
export function publishCli(opts: PublishCliOptions = {}): PublishCliResult {
  const targetDir = path.resolve(opts.targetDir ?? defaultCliPublishDir());
  const sourceCli = path.resolve(opts.sourceCli ?? path.join(__dirname, 'cli.js'));
  if (!fs.existsSync(sourceCli)) {
    throw new Error(`CLI 构建产物不存在：${sourceCli}（请先 npm run build）`);
  }
  const distDir = path.dirname(sourceCli);
  const appRoot = path.resolve(distDir, '..');
  const mode = opts.mode ?? currentEnv();
  const sourceEnvFile = opts.envFile ?? path.join(appRoot, `.env.${mode}`);
  const envContent = fs.existsSync(sourceEnvFile) ? fs.readFileSync(sourceEnvFile) : Buffer.from('');
  const envSha256 = crypto.createHash('sha256').update(envContent).digest('hex');
  const version = opts.version ?? readBackendVersion(appRoot);
  const now = opts.now?.() ?? new Date();
  const publishedAt = now.toISOString();
  const sourceHash = sha256File(sourceCli);
  const installDir = opts.installRoot ? path.resolve(opts.installRoot) : undefined;

  // 快速路径：版本戳与源一致、程序三件套与依赖在位、安装根未变 → 直接返回。
  // 应用每次启动都会调用本函数，未变更时不得重复复制 dist 与依赖。
  // 磁盘上的 cli.js 必须实测哈希一致：戳可能撒谎（副本被改坏/截断时戳不变），
  // 过期或损坏的副本必须走完整发布覆盖。
  const existing = readCliVersionStamp(targetDir);
  let onDiskOk = false;
  if (
    opts.force !== true &&
    existing &&
    existing.schemaVersion === CLI_PUBLISH_SCHEMA_VERSION &&
    existing.mode === mode &&
    existing.envSha256 === envSha256 &&
    existing.version === version &&
    existing.cliSha256 === sourceHash &&
    existing.installDir === installDir
  ) {
    const diskCli = path.join(targetDir, 'cli.js');
    onDiskOk =
      fs.existsSync(diskCli) &&
      fs.existsSync(path.join(targetDir, 'skills.cmd')) &&
      fs.existsSync(path.join(targetDir, '.env.selected')) &&
      sha256File(path.join(targetDir, '.env.selected')) === envSha256 &&
      fs.existsSync(path.join(targetDir, 'node_modules')) &&
      sha256File(diskCli) === sourceHash;
  }
  if (onDiskOk && existing) {
    return {
      version,
      targetDir,
      cliPath: path.join(targetDir, 'cli.js'),
      cmdPath: path.join(targetDir, 'skills.cmd'),
      versionPath: path.join(targetDir, 'version.json'),
      cliSha256: sourceHash,
      dependencyCount: existing.dependencyCount ?? 0,
      previousVersion: existing.version,
      publishedAt: existing.publishedAt,
      changed: false,
      dependenciesCopied: false,
    };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const cliPath = path.join(targetDir, 'cli.js');
  const cmdPath = path.join(targetDir, 'skills.cmd');
  const versionPath = path.join(targetDir, 'version.json');

  const previous = readJson<CliVersionStamp>(versionPath);
  const previousVersion = typeof previous?.version === 'string' ? previous.version : null;
  const previousOnDisk = fs.existsSync(cliPath) ? sha256File(cliPath) : null;

  // 先撤掉旧的版本戳：发布中途失败时「没有版本戳」比「版本戳说没问题但文件已换」更安全
  fs.rmSync(versionPath, { force: true });

  // 1) 程序文件：先清掉上次发布的程序文件（含已从构建中移除的），再整棵复制
  const programFiles = copyProgramFiles(distDir, targetDir, previous?.programFiles ?? []);
  fs.writeFileSync(path.join(targetDir, '.env.selected'), envContent);
  const copiedHash = sha256File(cliPath);
  if (copiedHash !== sourceHash) {
    throw new Error(`CLI 复制校验失败：源 ${sourceHash.slice(0, 12)} ≠ 目标 ${copiedHash.slice(0, 12)}`);
  }

  // 2) package.json：版本回退与依赖声明（也便于排障时核对来源版本）
  const rootPkg = path.join(appRoot, 'package.json');
  if (fs.existsSync(rootPkg)) fs.copyFileSync(rootPkg, path.join(targetDir, 'package.json'));

  // 3) 运行依赖闭包（CLI 产物静态 require 出发；同名同版本时跳过复制）
  const closure = collectDependencyClosure(appRoot, distDir);
  if (closure.missingRequired.length > 0) {
    throw new Error(`依赖不完整，无法发布可独立运行的 CLI：缺少 ${closure.missingRequired.join(', ')}`);
  }
  // 对账清理：删除副本中不在当前闭包内的顶层包（闭包收窄后清历史残留）
  pruneExtraneousPackages(
    targetDir,
    new Set(closure.entries.map((entry) => entry.slice(0, entry.lastIndexOf('@')))),
  );
  const canReuseDeps =
    opts.force !== true &&
    previous?.runtimeClosure === closure.fingerprint &&
    fs.existsSync(path.join(targetDir, 'node_modules'));
  if (!canReuseDeps) {
    for (const entry of closure.entries) {
      const name = entry.slice(0, entry.lastIndexOf('@'));
      const src = resolvePackageDir(appRoot, name);
      if (src == null) throw new Error(`依赖目录不存在：${name}`);
      copyDirFresh(src, path.join(targetDir, 'node_modules', ...name.split('/')));
    }
  } else {
    // 内部 Skill 文本可在版本号不变时更新；复用第三方依赖时仍刷新本地 Agent 包。
    const agentSrc = resolvePackageDir(appRoot, '@skills-studio/agent');
    if (agentSrc) copyDirFresh(agentSrc, path.join(targetDir, 'node_modules', '@skills-studio', 'agent'));
  }

  // 4) skills.cmd：只用 node 调用同目录 cli.js（不写死绝对路径，目录可整体移动）
  const cmd = [
    '@echo off',
    'setlocal',
    'node "%~dp0cli.js" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  fs.writeFileSync(cmdPath, cmd, 'utf8');

  // 5) 版本戳：最后写，作为「发布完成」的唯一标记
  const stamp: CliVersionStamp = {
    schemaVersion: CLI_PUBLISH_SCHEMA_VERSION,
    mode,
    envSha256,
    version,
    publishedAt,
    cliSha256: copiedHash,
    sourceCli,
    files: ['cli.js', 'skills.cmd', '.env.selected', 'version.json'],
    programFiles,
    runtimeClosure: closure.fingerprint,
    dependencyCount: closure.entries.length,
    installDir,
  };
  const tmpVersion = `${versionPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpVersion, JSON.stringify(stamp, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpVersion, versionPath);

  // 6) 回读校验：版本戳与文件必须对得上，否则报错（不允许静默发布一个坏副本）
  const written = readCliVersionStamp(targetDir);
  if (!written || written.cliSha256 !== sha256File(cliPath)) {
    throw new Error(`CLI 发布校验失败：版本戳与 cli.js 不一致（${targetDir}）`);
  }

  const changed =
    previousVersion !== version || previous?.cliSha256 !== sourceHash || previousOnDisk !== sourceHash || !canReuseDeps;

  return {
    version,
    targetDir,
    cliPath,
    cmdPath,
    versionPath,
    cliSha256: copiedHash,
    dependencyCount: closure.entries.length,
    previousVersion,
    publishedAt,
    changed,
    dependenciesCopied: !canReuseDeps,
  };
}

/**
 * 复制程序文件：顶层 .js（排除 Electron 专用）与 domain/infra/resources 目录。
 * 只删除「上次发布记录的顶层文件 + 本模块管理的固定文件」，绝不清理用户目录里的其他内容。
 */
function copyProgramFiles(distDir: string, targetDir: string, previousProgramFiles: string[]): string[] {
  const topLevel = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((e) => e.isFile() && !EXCLUDED_PROGRAM_FILES.has(e.name))
    .map((e) => e.name);

  // 清理上次发布留下、本次构建已不存在的顶层程序文件
  const current = new Set(topLevel);
  for (const name of previousProgramFiles) {
    if (current.has(name)) continue;
    if (MANAGED_FILES.has(name)) continue;
    if (PROGRAM_DIRS.includes(name)) continue;
    const stale = path.join(targetDir, name);
    if (fs.existsSync(stale) && fs.statSync(stale).isFile()) fs.rmSync(stale, { force: true });
  }

  for (const name of topLevel) {
    const from = path.join(distDir, name);
    const to = path.join(targetDir, name);
    fs.copyFileSync(from, to);
  }
  for (const dir of PROGRAM_DIRS) {
    const from = path.join(distDir, dir);
    if (!fs.existsSync(from)) continue;
    copyDirFresh(from, path.join(targetDir, dir));
  }
  return topLevel;
}

function readBackendVersion(appRoot: string): string {
  const pkg = readJson<{ version?: string }>(path.join(appRoot, 'package.json'));
  return pkg?.version ?? '0.0.0';
}
