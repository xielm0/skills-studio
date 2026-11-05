import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import config from './config.json';

export type AppEnvMode = 'development' | 'production' | 'uat';

/** 唯一默认环境选择；源码构建与发布产物都携带此配置。 */
export function currentEnv(): AppEnvMode {
  const value: unknown = config.CURRENT_ENV;
  if (value === 'development' || value === 'uat' || value === 'production') return value;
  throw new Error(`未知运行环境：${String(value)}`);
}

/** 源码启动可临时覆盖；安装包始终使用打包时选定的环境。 */
export function selectEnv(override?: string): AppEnvMode {
  const value = override ?? currentEnv();
  if (value === 'development' || value === 'uat' || value === 'production') return value;
  throw new Error(`未知运行环境：${value}`);
}

/**
 * 配置按「真实安装后的物理位置」倒推，一共四个位置 + adapter：
 *  - `SOFT_DIR`     软件根（只读资源；生产 = 安装目录）
 *  - `HOME_DIR`     用户主目录（生产 = %USERPROFILE%；dev/uat = 仓库内的虚拟 home）
 *  - `DATA_DIR`     应用私有数据（index.db / 会话 / 缓存；生产 = app.getPath('userData')）
 *  - `TEMP_DIR`     临时目录（生产 = <SOFT_DIR>/tmp，用户级安装可写）
 * 库不单独配置：库根默认 = `<HOME_DIR>/.skills-studio/skills-library`（`.skills-studio` 是 home 固定根，`bin/` 为 CLI 发布产物；
 * 库根可整体搬走，搬走后固定根下仅剩 bin/），技能目录 = 库根下 `skills/`。
 */
export interface AppEnv {
  APP_ENV: AppEnvMode;
  SOFT_DIR: string;
  HOME_DIR: string;
  DATA_DIR: string;
  TEMP_DIR: string;
  /** 库根：默认 `<HOME_DIR>/.skills-studio/skills-library`（含 library.json / skills / sync / reports / .git，可整体搬走） */
  LIBRARY_ROOT: string;
  /** 技能目录：`<LIBRARY_ROOT>/skills`（用户口径里的「中心技能库路径」） */
  LIBRARY_DIR: string;
  /** 日志：`<DATA_DIR>/logs`（跟应用数据走，不写安装目录） */
  LOG_DIR: string;
  ADAPTERS: string;
}

/** 真实用户目录：生产 home 的默认值。 */
export function realHome(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/**
 * 由四个位置派生库与日志（唯一真相，主进程 / CLI 共用）。
 * 库恒在 home 下，与真实安装后的形态一致。
 */
export function deriveEnvPaths(input: {
  homeDir: string;
  dataDir: string;
  tempDir: string;
}): Pick<AppEnv, 'HOME_DIR' | 'LIBRARY_ROOT' | 'LIBRARY_DIR' | 'TEMP_DIR' | 'LOG_DIR'> {
  const home = input.homeDir ? path.resolve(input.homeDir) : realHome();
  const libraryRoot = path.join(home, '.skills-studio', 'skills-library');
  return {
    HOME_DIR: home,
    LIBRARY_ROOT: libraryRoot,
    LIBRARY_DIR: path.join(libraryRoot, 'skills'),
    TEMP_DIR: input.tempDir ? path.resolve(input.tempDir) : '',
    LOG_DIR: input.dataDir ? path.join(path.resolve(input.dataDir), 'logs') : '',
  };
}

/** 展开 Windows 环境变量（`%USERPROFILE%` 等）；未知变量保留原样，不猜测。 */
function expandWinVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = expandWinVars(m[2].trim());
  }
  return out;
}

/**
 * tec.md §4：三份环境文件按用途分开，互不交叉加载
 * （development = 自动化夹具，uat = 人工验收，production = 生产）。
 *
 * 文件里写的是「真实环境的四个物理位置」，`LIBRARY_ROOT` / `LIBRARY_DIR` / `LOG_DIR` 一律派生。
 * 生产允许 SOFT_DIR / HOME_DIR / DATA_DIR / TEMP_DIR 留空：由 main.ts 按 app.getAppPath()、
 * os.homedir()、app.getPath('userData')、<SOFT_DIR>/tmp 补齐。
 */
export function loadEnv(mode: AppEnvMode, envFile = path.resolve(__dirname, `../.env.${mode}`)): AppEnv {
  const parsed = parseEnvFile(envFile);
  const projectRoot = path.resolve(__dirname, '..', '..');
  const localRoot = path.join(projectRoot, mode === 'uat' ? 'uat' : path.join('tests', 'dev'));

  // 文件缺键时的兜底；开发/uat 的兜底必须落在仓库内，绝不指向真实用户目录。
  // 生产四键留空 = ''（运行时由 main.ts 按安装形态补齐），不得解析成仓库根。
  const softDir = parsed.SOFT_DIR
    ? path.resolve(projectRoot, parsed.SOFT_DIR)
    : mode === 'production'
      ? ''
      : path.resolve(projectRoot, '.');
  const homeDir = parsed.HOME_DIR
    ? path.resolve(projectRoot, parsed.HOME_DIR)
    : mode === 'production'
      ? ''
      : path.join(localRoot, 'home');
  const dataDir = parsed.DATA_DIR
    ? path.resolve(projectRoot, parsed.DATA_DIR)
    : mode === 'production'
      ? ''
      : path.join(localRoot, 'appdata');
  const tempDir = parsed.TEMP_DIR
    ? path.resolve(projectRoot, parsed.TEMP_DIR)
    : mode === 'production'
      ? ''
      : path.join(localRoot, 'tmp');

  return {
    APP_ENV: mode,
    SOFT_DIR: softDir,
    ...deriveEnvPaths({ homeDir, dataDir, tempDir }),
    DATA_DIR: dataDir,
    ADAPTERS: parsed.ADAPTERS || (mode === 'production' ? 'ALL' : 'codebuddy,cursor'),
  };
}
