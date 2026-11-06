/**
 * 应用自更新（GitHub Releases + electron-updater）。
 *
 * 边界与策略：
 *  - 只在「打包后的生产环境」启用；main.ts 按 app.isPackaged && mode === 'production'
 *    且安装包携带 resources/app-update.yml 时才装配，其余环境渲染层拿到 unsupported 快照；
 *  - electron-updater 实例由宿主注入（本模块不 import electron，可被 node:test 直调）；
 *  - 检查到新版本即后台静默下载（autoDownload），下载完成后由用户在设置页确认
 *    「重启并更新」；autoInstallOnAppQuit 兜底——用户不点，退出应用时也会装上；
 *  - 失败只写入状态由界面展示（自动检查失败不打断使用），不弹窗。
 */
import type { AppUpdateState } from '../shared/ipc';

/** electron-updater AutoUpdater 的事件面（结构子集，便于测试构造 fake）。 */
export interface AppUpdateEvents {
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: { version?: string }) => void): unknown;
  on(event: 'update-not-available', listener: (info: { version?: string }) => void): unknown;
  on(event: 'download-progress', listener: (progress: {
    percent?: number; transferred?: number; total?: number; bytesPerSecond?: number;
  }) => void): unknown;
  on(event: 'update-downloaded', listener: (info: { version?: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface AppUpdateDeps {
  events: AppUpdateEvents;
  /** electron-updater 的 checkForUpdates（autoDownload=true：有新版即开始后台下载） */
  checkForUpdates: () => Promise<unknown>;
  /** electron-updater 的 quitAndInstall */
  installNow: () => void;
  currentVersion: string;
  logger?: { info(event: string, data?: unknown): void; error(event: string, data?: unknown): void };
  /** 状态变化回调（main.ts 转发给渲染层） */
  onState: (state: AppUpdateState) => void;
}

export interface AppUpdateControls {
  getState(): AppUpdateState;
  /** 手动检查：检查中/下载中时幂等返回当前状态，不重入。 */
  checkNow(): Promise<AppUpdateState>;
  installNow(): void;
}

/**
 * 取 electron-updater 模块对象（同步；延迟到调用时才加载）。
 *
 * 必须走 CJS require：`autoUpdater` 在 electron-updater 的 exports 上由
 * `Object.defineProperty(exports, 'autoUpdater', { get })` 惰性定义，Node 对 CJS
 * 做命名导出静态分析时识别不到，`await import()` 的命名空间里只暴露 `default`。
 * 解构 `const { autoUpdater } = await import(...)` 得到 undefined，装配随即在
 * `deps.events.on` 处抛错——0.1.0/0.1.1 打包版「设置页没有检查更新」即此原因。
 *
 * 保留函数形式而不用顶层 import，是为了让 dev/uat 不付 electron-updater 的
 * 模块加载开销（实测首次 require 约 138ms）。
 */
export function loadUpdaterModule(): typeof import('electron-updater') {
  return require('electron-updater');
}

/** 未启用更新环境（dev/uat、未打包、安装包无 app-update.yml）的固定快照。 */
export function unsupportedAppUpdateState(currentVersion: string): AppUpdateState {
  return { status: 'unsupported', currentVersion };
}

function initialState(currentVersion: string): AppUpdateState {
  return { status: 'idle', currentVersion };
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // electron-updater 的错误常带调用栈式多行 detail，取首行保证界面可读
  return raw.split('\n')[0]?.slice(0, 300) || '更新失败';
}

export function createAppUpdateService(deps: AppUpdateDeps): AppUpdateControls {
  let state: AppUpdateState = initialState(deps.currentVersion);

  const publish = (next: AppUpdateState): AppUpdateState => {
    state = next;
    deps.logger?.info('update:state', { status: next.status, version: next.availableVersion, error: next.error });
    deps.onState(next);
    return next;
  };

  const patch = (part: Partial<AppUpdateState>): AppUpdateState =>
    publish({ ...state, ...part });

  deps.events.on('checking-for-update', () => {
    patch({ status: 'checking', error: undefined, checkedAt: new Date().toISOString() });
  });

  deps.events.on('update-available', (info) => {
    // autoDownload=true：本事件后紧接 download-progress；状态直接进入下载中
    patch({ status: 'downloading', availableVersion: info.version, error: undefined, progress: undefined });
  });

  deps.events.on('update-not-available', () => {
    patch({ status: 'up-to-date', availableVersion: undefined, progress: undefined });
  });

  deps.events.on('download-progress', (progress) => {
    patch({
      status: 'downloading',
      progress: {
        percent: Number(progress.percent ?? 0),
        transferred: Number(progress.transferred ?? 0),
        total: Number(progress.total ?? 0),
        bytesPerSecond: Number(progress.bytesPerSecond ?? 0),
      },
    });
  });

  deps.events.on('update-downloaded', (info) => {
    patch({ status: 'downloaded', availableVersion: info.version, progress: undefined });
  });

  deps.events.on('error', (err) => {
    // 下载完成后的杂项错误不打翻「已就绪」状态（如退出安装阶段的告警）
    if (state.status === 'downloaded') {
      deps.logger?.error('update:error-ignored', { status: state.status, error: String(err) });
      return;
    }
    patch({ status: 'error', error: errorMessage(err), progress: undefined });
  });

  return {
    getState: () => state,
    checkNow: () => {
      if (state.status === 'checking' || state.status === 'downloading') {
        return Promise.resolve(state);
      }
      return deps
        .checkForUpdates()
        .then(() => state)
        .catch((err: unknown) => {
          // checkForUpdates 的 reject 与 error 事件会同时到达；事件先到时保留事件的 detail
          deps.logger?.error('update:check-failed', { error: String(err) });
          return state.status === 'error' ? state : patch({ status: 'error', error: errorMessage(err), progress: undefined });
        });
    },
    installNow: () => {
      if (state.status !== 'downloaded') return;
      deps.logger?.info('update:install', { version: state.availableVersion });
      deps.installNow();
    },
  };
}
