// 打包：前端构建 → 后端构建 → 复制选中的环境文件 → electron-builder → 产物摘要。
// 产物：release/skills-studio-Setup-<版本>-x64.exe（NSIS 用户级，向导式）。
// 镜像与缓存按 AGENTS.md：npmmirror 下载、缓存放仓库 .cache/（不污染全局）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentEnv } from './env-mode.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '..');
const repoRoot = path.resolve(backendDir, '..');
const selectedMode = currentEnv();
if (process.argv.includes('--release') && selectedMode !== 'production') {
  throw new Error(`GitHub Release 必须使用 production，当前 CURRENT_ENV=${selectedMode}`);
}

// Electron zip 与 electron-builder 工具链（NSIS 等）都走 npmmirror，缓存收进仓库 .cache/
const env = {
  ...process.env,
  SKILLS_STUDIO_BUILD_ENV: selectedMode,
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  ELECTRON_CACHE: path.join(repoRoot, '.cache', 'electron'),
  ELECTRON_BUILDER_CACHE: path.join(repoRoot, '.cache', 'electron-builder'),
};

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: backendDir,
    env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1) 前端构建（渲染层静态资源 → frontend/dist）
run('npm', ['run', 'build', '--prefix', path.join(repoRoot, 'frontend')]);

// 2) 后端构建（agents + tsc + placeholder → backend/dist）
run('npm', ['run', 'build']);

// 3) 只把 CURRENT_ENV 选中的一份环境文件带入安装包。
//    production 缺文件时使用运行时默认值；development/uat 必须有本地隔离配置。
const selectedEnvPath = path.join(backendDir, `.env.${selectedMode}`);
if (!existsSync(selectedEnvPath) && selectedMode !== 'production') {
  throw new Error(`缺少环境文件：${selectedEnvPath}`);
}
const selectedEnv = existsSync(selectedEnvPath)
  ? readFileSync(selectedEnvPath, 'utf8')
  : 'SOFT_DIR=\r\nHOME_DIR=\r\nDATA_DIR=\r\nTEMP_DIR=\r\nADAPTERS=ALL\r\n';
writeFileSync(path.join(backendDir, '.env.selected'), selectedEnv, 'utf8');
console.log(`package environment: ${selectedMode} (${selectedEnvPath})`);

// 4) 应用图标：branding 源 → build/icon.ico（electron-builder 默认约定路径，exe/卸载器/快捷方式共用）
const iconSource = path.join(repoRoot, 'assets', 'branding', 'skills-studio-icon.ico');
if (!existsSync(iconSource)) {
  console.error(`package: 应用图标缺失 ${iconSource}`);
  process.exit(1);
}
mkdirSync(path.join(backendDir, 'build'), { recursive: true });
copyFileSync(iconSource, path.join(backendDir, 'build', 'icon.ico'));

// 5) electron-builder 打包（配置：backend/electron-builder.yml，暂存输出到 .cache/pkg）
run('npx', ['electron-builder', '--win', '--x64']);

// 6) 最终产物拷贝到约定位置 backend/release/（单文件写入，不受暂存目录的锁干扰）
const { version } = createRequire(path.join(backendDir, 'package.json'))('./package.json');
const stagedExe = path.join(repoRoot, '.cache', 'pkg', `skills-studio-Setup-${version}-x64.exe`);
if (!existsSync(stagedExe)) {
  console.error(`package: 打包完成但未找到产物 ${stagedExe}（查看上方 electron-builder 输出定位失败原因）`);
  process.exit(1);
}
mkdirSync(path.join(backendDir, 'release'), { recursive: true });
const artifact = path.join(backendDir, 'release', `skills-studio-Setup-${version}-x64.exe`);
copyFileSync(stagedExe, artifact);

// 6b) 更新清单（electron-builder publish 配置生成）：与安装包一起构成发版产物，
//     发版时两个文件都上传 GitHub Release（specs/guide.md「发布新版本」）。
//     blockmap 不发版：NSIS+LZMA 压缩下差量下载基本失效，electron-updater 对缺少
//     blockmap 的 Release 自动退回全量下载 + latest.yml 整体 sha512 校验，功能不变。
//     未配置 publish 时 latest.yml 不存在，安静跳过（安装包内「检查更新」为不可用）。
const stagedLatest = path.join(repoRoot, '.cache', 'pkg', 'latest.yml');
if (existsSync(stagedLatest)) {
  copyFileSync(stagedLatest, path.join(backendDir, 'release', 'latest.yml'));
}

// 7) 产物摘要：路径、大小、SHA-256
const sizeMb = statSync(artifact).size / 1024 / 1024;
const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
console.log('');
console.log(`安装包: ${artifact}`);
console.log(`大小:   ${sizeMb.toFixed(1)} MB`);
console.log(`SHA256: ${sha256}`);
