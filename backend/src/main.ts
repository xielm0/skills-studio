import { app, BrowserWindow, Menu, dialog, shell, type IpcMainInvokeEvent } from 'electron';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadEnv, deriveEnvPaths, selectEnv, type AppEnv } from './env';
import { defaultCliPublishDir, publishCli } from './cli-publish';
import { createLogger } from './logger';
import { registerIpcRouter } from './ipc/router';
import { createIpcHandlers } from './ipc/handlers';
import { AppContext } from './context';
import { selectBuiltinAgents } from './domain/agents';
import { readAppState } from './domain/app-state';
import type { AppInfoResult, AppPingResult, ConversationEvent } from './shared/ipc';
import { CONVERSATION_EVENT_CHANNEL, UPDATE_EVENT_CHANNEL } from './shared/ipc';
import { createAppUpdateService, type AppUpdateControls } from './domain/app-update';

// 发布版按构建时的 CURRENT_ENV 运行；源码可用 --env 临时选择另一套隔离环境。
const mode = selectEnv(app.isPackaged ? undefined : process.argv.find((arg) => arg.startsWith('--env='))?.slice(6));
const smokeTest = process.argv.includes('--smoke-test');
const screenshotArg = process.argv.find((arg) => arg.startsWith('--screenshot='));
const screenshotMode = screenshotArg !== undefined;
const scenarioArg = process.argv.find((arg) => arg.startsWith('--scenario='));
const scenario = scenarioArg ? scenarioArg.slice('--scenario='.length) : 't09';
const runtimeArg = process.argv.find((arg) => arg.startsWith('--runtime='));

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_ROOT = path.resolve(PROJECT_ROOT, 'tests', 'runtime');

/** T12 自动截图夹具（由 scripts/screenshot.mjs 的 seed 生成，全部落在 tests/runtime 内）。 */
const T12_SHOT_ROOT = path.join(RUNTIME_ROOT, 't12-shot');
const T12_LOCAL_DIR = path.join(T12_SHOT_ROOT, 'assets', 'local-src');
const T12_ZIP = path.join(T12_SHOT_ROOT, 'assets', 'skills.zip');
const T12_REPO = path.join(T12_SHOT_ROOT, 'assets', 'repo.git');

/** T15 自动截图：本地模拟 OpenAI 兼容服务（仅 screenshot 场景，零真实网络）。 */
const T15_FAKE_PORT = 18915;

/** 截图/测试夹具：--runtime 覆盖库、数据、临时、日志与 home（必须落在 tests/runtime 内）。 */
function resolveRuntimeOverride(): string | null {
  if (!runtimeArg) return null;
  const dir = path.resolve(PROJECT_ROOT, runtimeArg.slice('--runtime='.length));
  if (!dir.startsWith(RUNTIME_ROOT)) return null;
  return dir;
}

const runtimeOverride = resolveRuntimeOverride();

const selectedEnvFile = app.isPackaged
  ? path.resolve(__dirname, '../.env.selected')
  : path.resolve(__dirname, `../.env.${mode}`);
let env: AppEnv = loadEnv(mode, selectedEnvFile);
if (runtimeOverride) {
  env = {
    ...env,
    LIBRARY_ROOT: path.join(runtimeOverride, 'lib'),
    LIBRARY_DIR: path.join(runtimeOverride, 'lib', 'skills'),
    DATA_DIR: path.join(runtimeOverride, 'data'),
    TEMP_DIR: path.join(runtimeOverride, 'tmp'),
    LOG_DIR: path.join(runtimeOverride, 'logs'),
    // 夹具的 home 与真实机器同构：<runtime>/user/.codebuddy/skills 等
    HOME_DIR: path.join(runtimeOverride, 'user'),
  };
}

const logger = createLogger(env.LOG_DIR);

// 截图模式（T09/T10 自动验证）：逐路由截取真实窗口。GPU 在本机不稳定，
// 与烟测一致走软件渲染，窗口仍真实可见、由 Chromium 正常绘制。
if (smokeTest || screenshotMode) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.disableHardwareAcceleration();
}

// 开发模式下 Electron 自身数据也必须落在隔离区（AGENTS.md 隔离纪律），
// 且避免与默认 userData（%APPDATA%）冲突。须在 app ready 之前设置。
if ((mode === 'development' || mode === 'uat' || runtimeOverride) && env.DATA_DIR) {
  app.setPath('userData', path.join(env.DATA_DIR, 'electron-user-data'));
}

// 隔离纪律（AGENTS.md）：development 只允许 tests/dev（自动化夹具）与 tests/runtime；
// uat 只允许仓库根 uat/（人工验收数据），两者数据互不可见。
const DEV_ROOT = path.join(PROJECT_ROOT, 'tests', 'dev');
const UAT_ROOT = path.join(PROJECT_ROOT, 'uat');
const ALLOWED_ROOTS = mode === 'uat' ? [UAT_ROOT, RUNTIME_ROOT] : [DEV_ROOT, RUNTIME_ROOT];
const isAllowedPath = (value: string): boolean =>
  Boolean(value) && ALLOWED_ROOTS.some((root) => path.resolve(value).startsWith(root));

if (mode === 'development' || mode === 'uat') {
  for (const key of ['LIBRARY_ROOT', 'DATA_DIR', 'TEMP_DIR', 'HOME_DIR'] as const) {
    const value = env[key];
    const isolated = isAllowedPath(value);
    logger.info('env:check', { key, value, isolated });
    if ((smokeTest || runtimeOverride) && !isolated) {
      logger.error('env:check:failed', { key, value, expectedRoots: ALLOWED_ROOTS });
      app.exit(1);
    }
  }
}

/**
 * 生产路径兜底（按真实安装后的形态）：软件根 = 安装目录、home = 真实用户目录、
 * 应用数据 = userData、临时目录 = <软件根>/tmp；库与日志由 deriveEnvPaths 派生。
 */
function resolveProductionPaths(): AppEnv {
  if (mode !== 'production') return env;
  // asar 打包时 app.getAppPath() 指向 app.asar（文件）；SOFT_DIR 取其所在 resources 目录
  // （asar 外的真实目录，frontend/dist 与 agents/skills 都落在这里，且用户级安装可写）。
  const appPath = app.getAppPath();
  const softDir = env.SOFT_DIR || (appPath.endsWith('.asar') ? path.dirname(appPath) : appPath);
  const dataDir = env.DATA_DIR || app.getPath('userData');
  const tempDir = env.TEMP_DIR || path.join(softDir, 'tmp');
  const homeDir = env.HOME_DIR || os.homedir();
  return {
    ...env,
    SOFT_DIR: softDir,
    DATA_DIR: dataDir,
    ...deriveEnvPaths({ homeDir, dataDir, tempDir }),
  };
}

/**
 * 截图路由：与前端 hash 路由一一对应（frontend/src/router.ts）。
 * script：截图前在渲染层执行的交互（例如点击「扫描本机 Skills 开始」）。
 */
interface ScreenshotRoute {
  name: string;
  hash: string;
  size?: [number, number];
  script?: string;
  settleMs?: number;
}

/**
 * T11 截图脚本共用片段：先在主页与中心库之间往返一次，确保每次截图从干净页面状态开始
 * （hash 不变时 React 不会重新挂载，多选/菜单状态会残留）。
 */
const T11_RESET = `
  const T11_WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.location.hash = '#/home';
  await T11_WAIT(250);
  window.location.hash = '#/library';
  await T11_WAIT(800);
`;

/** T12 截图脚本共用片段：主页→安装往返，确保每次截图从干净页面状态开始。 */
const T12_RESET = `
  const T12_WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.location.hash = '#/home';
  await T12_WAIT(250);
  window.location.hash = '#/install';
  await T12_WAIT(1500);
`;

/** T15 截图脚本共用片段：回到空白对话，确保每次截图从干净页面状态开始。 */
const T15_RESET = `
  const T15_WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.location.hash = '#/home';
  await T15_WAIT(200);
  window.location.hash = '#/chat';
  await T15_WAIT(900);
`;

/**
 * T15 文件区共用片段：逐个点击左侧会话，直到找到含 ≥2 个文件卡的会话，
 * 再依次打开两张卡，产出可截图的只读多标签状态。
 *
 * 必须自己选会话：`#/chat` 的 hash 切换会重挂载页面，上一步的临时状态不会保留。
 * 调用方需先声明 `checks`（数组）；本片段追加 `check / wait / cards` 三个局部名。
 */
const T15_OPEN_FILE_TABS = `
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (test, timeout = 8000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (test()) return true;
      await wait(150);
    }
    return false;
  };
  const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
  const cards = () => [...document.querySelectorAll('[data-testid="chat-file-card"]')];

  let fileSession = false;
  for (const item of [...document.querySelectorAll('[data-testid="session-item"]')]) {
    item.click();
    await wait(600);
    if (await waitFor(() => cards().length >= 2, 4000)) {
      fileSession = true;
      break;
    }
  }
  check('左侧会话中存在含 ≥2 个文件卡的会话', fileSession);
  if (!fileSession) return { ok: false, checks };

  cards()[0].click();
  check('点文件卡后右侧文件区打开', await waitFor(() => Boolean(document.querySelector('[data-testid="chat-file-panel"]'))));
  check('第一张卡生成标签', await waitFor(() => document.querySelectorAll('[data-testid="chat-file-tab"]').length >= 1));
  check('第一份文件显示预览', await waitFor(() => Boolean(document.querySelector('[data-testid="chat-file-content"]')?.textContent?.trim())));

  cards()[1].click();
  await wait(300);
  cards()[0].click();
  check('两个文件各有标签（≥2）', await waitFor(() => document.querySelectorAll('[data-testid="chat-file-tab"]').length >= 2));

  check('预览区没有编辑和保存控件', !document.querySelector('[data-testid="chat-file-edit"], [data-testid="chat-file-save"], [data-testid="chat-file-editor"]'));
  const filePanel = document.querySelector('[data-testid="chat-file-panel"]');
  check('DSH 结构：标签栏、路径栏和正文区', Boolean(filePanel?.querySelector('[role="tablist"] [data-testid="chat-file-tab"]'))
    && Boolean(filePanel?.querySelector('[data-path-label]'))
    && Boolean(filePanel?.querySelector('[data-testid="chat-file-content"]')));
  check('DSH 文件区操作：分屏、全屏、收起、查看方式、刷新、显示位置',
    ['chat-file-split', 'chat-file-fullscreen', 'chat-file-close-panel', 'chat-file-viewer-menu',
      'chat-file-refresh', 'chat-file-show-folder'].every((id) => Boolean(filePanel?.querySelector('[data-testid="' + id + '"]'))));

  // 对话区 ↔ 文件区之间的拖拽分隔条
  const panelEl = document.querySelector('[data-testid="chat-file-panel"]');
  const resizerEl = document.querySelector('[data-testid="chat-panel-resizer"]');
  check('文件区带可拖拽分隔条', Boolean(panelEl) && Boolean(resizerEl));
  if (panelEl && resizerEl) {
    const widthBefore = panelEl.getBoundingClientRect().width;
    const box = resizerEl.getBoundingClientRect();
    const pointer = (type, x) => new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: box.top + box.height / 2,
      button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse',
    });
    const startX = box.left + box.width / 2;
    resizerEl.dispatchEvent(pointer('pointerdown', startX));
    resizerEl.dispatchEvent(pointer('pointermove', startX - 80));
    resizerEl.dispatchEvent(pointer('pointerup', startX - 80));
    await wait(250);
    const widthDragged = panelEl.getBoundingClientRect().width;
    check('拖动分隔条改变文件区宽度', widthDragged - widthBefore > 60);
    check('拖拽结束后退出拖拽态', resizerEl.getAttribute('data-resizing') === 'false');
    resizerEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await wait(250);
    check('双击分隔条恢复默认宽度', Math.abs(panelEl.getBoundingClientRect().width - widthDragged) > 2);
  }
`;

/** T14 自动截图夹具：两套独立 runtime（A：连接→Pull 冲突；B：Push 被拒 + 恢复确认）。 */
const T14_SHOT_ROOT = path.join(RUNTIME_ROOT, 't14-shot');
const T14_REMOTE_A = path.join(T14_SHOT_ROOT, 'a', 'remote.git');
const T14_REMOTE_B = path.join(T14_SHOT_ROOT, 'b', 'remote.git');

/** T13 截图脚本共用片段：主页→Agents 往返，清掉上一张的入库/提示状态。 */
const T13_RESET = `
  const T13_WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.location.hash = '#/home';
  await T13_WAIT(250);
  window.location.hash = '#/agents?agent=claude-code';
  await T13_WAIT(1400);
`;

const SCREENSHOT_SCENARIOS: Record<string, ScreenshotRoute[]> = {
  // T09：外壳与导航（9 张；宽窗口检查内容页居中）
  t09: [
    { name: '01-home', hash: '#/home', size: [1680, 900] },
    { name: '02-library', hash: '#/library' },
    { name: '03-install', hash: '#/install' },
    { name: '04-backup', hash: '#/backup' },
    { name: '05-agents', hash: '#/agents' },
    { name: '06-chat-collapsed', hash: '#/chat' },
    { name: '07-chat-files-open', hash: '#/chat?file=SKILL.md' },
    { name: '08-settings', hash: '#/settings' },
    { name: '09-min-size-chat-files', hash: '#/chat?file=SKILL.md', size: [1080, 680] },
  ],
  // T10-A：首次启动（独立空库种子）
  'first-run': [
    { name: '01-first-run', hash: '#/first-run', settleMs: 900 },
    {
      name: '02-first-run-scan',
      hash: '#/first-run',
      script: `document.querySelector('[data-testid="first-run-start"]').click(); true`,
      settleMs: 1200,
    },
  ],
  // T10-B：主页与设置（预置 5 技能 + 部署 2 个 + 动态）
  main: [
    { name: '03-home-with-data', hash: '#/home', settleMs: 900 },
    {
      // CLI 接入卡片展开态：点「接入」展开勾选 Agent 胶囊
      name: '03b-home-cli-setup-expanded',
      hash: '#/home',
      script: `(async () => {
        document.querySelector('[data-testid="cli-setup-expand"]')?.click();
        await new Promise((r) => setTimeout(r, 300));
        document.querySelector('[data-testid^="cli-setup-agent-"]')?.click();
        return true;
      })()`,
      settleMs: 700,
    },
    { name: '04-settings-agents', hash: '#/settings', settleMs: 900 },
    {
      name: '05-settings-provider-modal',
      hash: '#/settings',
      script: `document.querySelector('[data-testid="add-provider"]').click(); true`,
      settleMs: 700,
    },
    {
      // 模型输入行聚焦后展开自绘候选列表（原生 datalist 的字重不受控，已替换）
      name: '06-settings-provider-model-options',
      hash: '#/settings',
      script: `(async () => {
        if (!document.querySelector('[data-testid="provider-modal"]')) {
          document.querySelector('[data-testid="add-provider"]').click();
          await new Promise((r) => setTimeout(r, 400));
        }
        document.querySelector('[data-testid="form-model-input"]').focus();
        return true;
      })()`,
      settleMs: 700,
    },
  ],
  // T11：中心库列表/网格/多选/行菜单/详情/未保存/差异/删除确认
  t11: [
    { name: '01-library-list', hash: '#/library', settleMs: 900 },
    {
      name: '02-library-grid',
      hash: '#/library',
      script: `(async () => {
        ${T11_RESET}
        document.querySelector('[data-testid="library-view-grid"]').click();
        await T11_WAIT(500);
        return true;
      })()`,
      settleMs: 400,
    },
    {
      name: '04-library-multi',
      hash: '#/library',
      script: `(async () => {
        ${T11_RESET}
        document.querySelector('[data-testid="library-multi-toggle"]').click();
        await T11_WAIT(300);
        const boxes = [...document.querySelectorAll('[data-testid="library-row-checkbox"]')];
        boxes.slice(0, 2).forEach((box) => box.click());
        await T11_WAIT(400);
        return true;
      })()`,
      settleMs: 400,
    },
    {
      name: '05-row-menu-with-report',
      hash: '#/library',
      script: `(async () => {
        ${T11_RESET}
        const row = [...document.querySelectorAll('[data-testid="library-row"]')].find(
          (item) => item.getAttribute('data-skill-name') === 'big-skill',
        );
        row.querySelector('[data-testid="library-row-menu"]').click();
        await T11_WAIT(400);
        return true;
      })()`,
      settleMs: 300,
    },
    {
      name: '06-row-menu-no-report',
      hash: '#/library',
      script: `(async () => {
        ${T11_RESET}
        const row = [...document.querySelectorAll('[data-testid="library-row"]')].find(
          (item) => item.getAttribute('data-skill-name') === 'code-review',
        );
        row.querySelector('[data-testid="library-row-menu"]').click();
        await T11_WAIT(400);
        return true;
      })()`,
      settleMs: 300,
    },
    {
      name: '07-detail-tree-tabs',
      hash: '#/library',
      script: `(async () => {
        ${T11_RESET}
        const row = [...document.querySelectorAll('[data-testid="library-row"]')].find(
          (item) => item.getAttribute('data-skill-name') === 'big-skill',
        );
        row.click();
        await T11_WAIT(1500);
        const file = document.querySelector('[data-rel-path="references/file-01.md"]');
        file?.click();
        await T11_WAIT(500);
        return window.location.hash.startsWith('#/library/');
      })()`,
      settleMs: 400,
    },
    {
      name: '08-detail-unsaved',
      hash: '#/library',
      script: `(async () => {
        ${T11_RESET}
        const row = [...document.querySelectorAll('[data-testid="library-row"]')].find(
          (item) => item.getAttribute('data-skill-name') === 'big-skill',
        );
        row.click();
        await T11_WAIT(1500);
        document.querySelector('[data-rel-path="references/file-01.md"]')?.click();
        await T11_WAIT(500);
        const editor = document.querySelector('[data-testid="skill-editor"]');
        if (!editor) return false;
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value').set;
        setter.call(editor, editor.value + '\\n未保存的修改（截图用）');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await T11_WAIT(400);
        return true;
      })()`,
      settleMs: 400,
    },
    {
      name: '10-delete-confirm',
      hash: '#/library',
      script:       `(async () => {
        ${T11_RESET}
        const row = [...document.querySelectorAll('[data-testid="library-row"]')].find(
          (item) => item.getAttribute('data-skill-name') === 'api-design',
        );
        row.querySelector('[data-testid="library-row-menu"]').click();
        await T11_WAIT(300);
        document.querySelector('[data-testid="menu-delete"]').click();
        await T11_WAIT(800);
        return Boolean(document.querySelector('[data-testid="library-delete-modal"]'));
      })()`,
      settleMs: 400,
    },
  ],
  // T12：安装 Skills（skills.sh 榜单/搜索/逐项安装、Git 预览、本地/压缩包/扫描导入）
  t12: [
    { name: '01-market-leaderboard', hash: '#/install', settleMs: 1800 },
    {
      name: '02-market-search',
      hash: '#/install',
      script: `(async () => {
        ${T12_RESET}
        const input = document.querySelector('[data-testid="install-market-search"]');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
        setter.call(input, 'pdf');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await T12_WAIT(250);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        await T12_WAIT(1200);
        return true;
      })()`,
      settleMs: 400,
    },
    {
      name: '03-git-parsed',
      hash: '#/install',
      script: `(async () => {
        ${T12_RESET}
        const tab = [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent === 'Git 地址');
        tab.click();
        await T12_WAIT(350);
        const input = document.querySelector('[data-testid="install-git-url"]');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
        setter.call(input, ${JSON.stringify(T12_REPO.replace(/\\/g, '/'))});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await T12_WAIT(250);
        document.querySelector('[data-testid="install-git-parse"]').click();
        await T12_WAIT(3000);
        return true;
      })()`,
      settleMs: 400,
    },
    {
      name: '04-local-scanned',
      hash: '#/install',
      script: `(async () => {
        ${T12_RESET}
        const tab = [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent === '本地目录');
        tab.click();
        await T12_WAIT(350);
        document.querySelector('[data-testid="install-local-pick"]').click();
        await T12_WAIT(500);
        document.querySelector('[data-testid="install-local-scan"]').click();
        await T12_WAIT(1200);
        return true;
      })()`,
      settleMs: 400,
    },
    {
      name: '05-archive-read',
      hash: '#/install',
      script: `(async () => {
        ${T12_RESET}
        const tab = [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent === '压缩包');
        tab.click();
        await T12_WAIT(350);
        document.querySelector('[data-testid="install-archive-pick"]').click();
        await T12_WAIT(500);
        document.querySelector('[data-testid="install-archive-read"]').click();
        await T12_WAIT(1200);
        return true;
      })()`,
      settleMs: 400,
    },
    {
      name: '06-agent-scan-imported',
      hash: '#/install',
      script: `(async () => {
        ${T12_RESET}
        const tab = [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent === '扫描本机');
        tab.click();
        await T12_WAIT(350);
        document.querySelector('[data-testid="install-scan-rescan"]').click();
        await T12_WAIT(1500);
        document.querySelector('[data-testid="install-select-all"]').click();
        await T12_WAIT(300);
        document.querySelector('[data-testid="install-import"]').click();
        await T12_WAIT(2500);
        return true;
      })()`,
      settleMs: 500,
    },
    {
      name: '07-market-import-feedback',
      hash: '#/install',
      script: `(async () => {
        ${T12_RESET}
        const row = [...document.querySelectorAll('[data-testid="install-row"]')].find(
          (item) => item.getAttribute('data-item-name') === 'pdf',
        );
        if (!row) return false;
        row.querySelector('[data-testid="install-market-item"]').click();
        await T12_WAIT(1600);
        return !document.querySelector('[data-testid="install-script-modal"]') && Boolean(
          document.querySelector('[role="status"]')
          || document.querySelector('[data-testid="install-import"]')?.disabled
        );
      })()`,
      settleMs: 400,
    },
    {
      name: '08-git-error',
      hash: '#/install',
      script: `(async () => {
        ${T12_RESET}
        const tab = [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent === 'Git 地址');
        tab.click();
        await T12_WAIT(350);
        const input = document.querySelector('[data-testid="install-git-url"]');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
        setter.call(input, 'E:/not-a-real-repo.git');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await T12_WAIT(250);
        document.querySelector('[data-testid="install-git-parse"]').click();
        await T12_WAIT(2500);
        return Boolean(document.querySelector('[data-testid="install-error"]'));
      })()`,
      settleMs: 400,
    },
  ],
  // T15：新对话与只读文件区（空白对话/模型菜单/运行中/文件卡/预览/会话列表/报告）
  t15: [
    {
      name: '01-blank-quick-model',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
        ${T15_RESET}
        document.querySelector('[data-testid="chat-model-button"]').click();
        await T15_WAIT(300);
        check('模型菜单打开', Boolean(document.querySelector('[data-testid="chat-model-menu"]')));
        check('一级含「模型」行', Boolean(document.querySelector('[data-testid="chat-model-row"]')));
        check(
          '按钮显示当前推理强度',
          Boolean(document.querySelector('[data-testid="chat-thinking-badge"]')),
        );
        check(
          '推理强度行随模型能力出现',
          Boolean(document.querySelector('[data-testid="chat-thinking-row"]')) ||
            !document.querySelector('[data-testid="chat-thinking-badge"]'),
        );
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 300,
    },
    {
      name: '02-thinking-levels',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
        ${T15_RESET}
        document.querySelector('[data-testid="chat-model-button"]').click();
        await T15_WAIT(300);
        document.querySelector('[data-testid="chat-thinking-row"]').click();
        await T15_WAIT(250);
        const options = [...document.querySelectorAll('[data-testid="chat-thinking-option"]')];
        check('推理强度列出档位', options.length > 0);
        check('不提供 off 档', !options.some((node) => (node.dataset.level ?? '') === 'off'));
        check('档位不超过三档', options.length <= 3);
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 300,
    },
    {
      name: '03-running-streaming',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
        ${T15_RESET}
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (test, timeout = 12000) => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            if (test()) return true;
            await wait(200);
          }
          return false;
        };
        const input = document.querySelector('[data-testid="chat-input"]');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
        setter.call(input, '演示：慢速流式回复，请边生成边显示。');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await T15_WAIT(250);
        document.querySelector('[data-testid="chat-send"]').click();
        // Agent 启动（首个增量）在软件渲染下可能需要 2s+，按状态轮询而不是死等固定时长
        check('运行中显示停止按钮', await waitFor(() => Boolean(document.querySelector('[data-testid="chat-stop"]'))));
        check(
          '状态为运行中',
          await waitFor(() => document.querySelector('[data-testid="chat-status"]')?.getAttribute('data-status') === 'running'),
        );
        check(
          '已出现逐字增量文本',
          await waitFor(() =>
            (document.querySelector('[data-testid="chat-messages"]')?.textContent ?? '').trim().length > 0,
          ),
        );
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 200,
    },
    {
      name: '04-completed-file-cards',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
        const T15_WAIT = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        // 上一张的运行中会话 → 停止（验证取消后仍保留已收文本）
        const stop = document.querySelector('[data-testid="chat-stop"]');
        if (stop) {
          stop.click();
          await T15_WAIT(900);
        }
        window.location.hash = '#/home';
        await T15_WAIT(200);
        window.location.hash = '#/chat';
        await T15_WAIT(700);
        const input = document.querySelector('[data-testid="chat-input"]');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
        setter.call(input, '演示：生成文件（写入 SKILL.md 与 references/notes.md）。');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await T15_WAIT(250);
        document.querySelector('[data-testid="chat-send"]').click();
        const waitFor = async (test, timeout = 20000) => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            if (test()) return true;
            await T15_WAIT(250);
          }
          return false;
        };
        const cardsReady = await waitFor(
          () => document.querySelectorAll('[data-testid="chat-file-card"]').length >= 2,
        );
        check('完成后出现文件卡（≥2）', cardsReady);
        check(
          '完成后状态为 done',
          await waitFor(
            () => document.querySelector('[data-testid="chat-status"]')?.getAttribute('data-status') === 'done',
          ),
        );
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 400,
    },
    {
      name: '05-file-panel-readonly-tabs',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        ${T15_OPEN_FILE_TABS}
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 400,
    },
    {
      name: '06-readonly-close-tab',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        ${T15_OPEN_FILE_TABS}
        const tab = document.querySelector('[data-testid="chat-file-tab"]');
        check('存在可关闭标签', Boolean(tab));
        if (!tab) return { ok: false, checks };
        const before = document.querySelectorAll('[data-testid="chat-file-tab"]').length;
        tab.querySelector('[data-testid="chat-file-tab-close"]').click();
        check('关闭标签立即生效', await waitFor(() => document.querySelectorAll('[data-testid="chat-file-tab"]').length === before - 1));
        check('关闭时不弹保存确认', !document.querySelector('[data-testid="chat-close-modal"]'));
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 300,
    },
    {
      name: '07-session-list',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (test, timeout = 8000) => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            if (test()) return true;
            await wait(200);
          }
          return false;
        };
        const historyReady = await waitFor(() =>
          Boolean([...document.querySelectorAll('[data-testid="session-item"]')].find((el) => el.textContent.includes('评测 Skill'))),
        );
        if (!historyReady) return { ok: false, checks };
        const history = [...document.querySelectorAll('[data-testid="session-item"]')].find((el) => el.textContent.includes('评测 Skill'));
        history.click();
        check(
          '点击后出现当前会话标记',
          await waitFor(() => Boolean(document.querySelector('[data-testid="session-item"][data-active="true"]'))),
        );
        check('会话列表有数据', document.querySelectorAll('[data-testid="session-item"]').length >= 1);
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 400,
    },
    {
      name: '08-report-text',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (test, timeout = 10000) => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            if (test()) return true;
            await wait(200);
          }
          return false;
        };
        // 自己选会话：hash 切换会重挂载页面，上一步的当前会话不会保留
        window.location.hash = '#/home';
        await wait(250);
        window.location.hash = '#/chat';
        await wait(900);
        const historyReady = await waitFor(() =>
          Boolean([...document.querySelectorAll('[data-testid="session-item"]')].find((el) => el.textContent.includes('评测 Skill'))),
        );
        if (!historyReady) return { ok: false, checks };
        const history = [...document.querySelectorAll('[data-testid="session-item"]')].find((el) => el.textContent.includes('评测 Skill'));
        history.click();
        const cardReady = await waitFor(() => Boolean(document.querySelector('[data-testid="chat-report-card"]')));
        check('会话中出现评测结果卡', cardReady);
        if (!cardReady) return { ok: false, checks };
        document.querySelector('[data-testid="chat-report-card"]').click();
        check('点结果卡后右侧文件区打开', await waitFor(() => Boolean(document.querySelector('[data-testid="chat-file-panel"]'))));
        const contentReady = await waitFor(() =>
          Boolean(document.querySelector('[data-testid="chat-file-content"]')?.textContent?.trim()),
        );
        check('报告以 Markdown 预览打开', contentReady && Boolean(document.querySelector('[data-document-markdown]')));
        check('Agent 回复中的 Markdown 标题已排版', Boolean(document.querySelector('[data-testid="chat-message"][data-role="assistant"] h2')));
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 300,
    },
    {
      name: '09-image-pdf-preview',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (test, timeout = 12000) => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            if (test()) return true;
            await wait(200);
          }
          return false;
        };
        const session = [...document.querySelectorAll('[data-testid="session-item"]')].find((item) => item.textContent.includes('预览文件：图片与 PDF'));
        check('找到图片与 PDF 会话', Boolean(session));
        if (!session) return { ok: false, checks };
        session.click();
        check('出现两张文件卡', await waitFor(() => document.querySelectorAll('[data-testid="chat-file-card"]').length >= 2));
        if (!checks.at(-1).ok) return { ok: false, checks };
        const cards = [...document.querySelectorAll('[data-testid="chat-file-card"]')];
        cards.find((item) => item.textContent.includes('preview.png'))?.click();
        check('图片内容在右侧显示', await waitFor(() => Boolean(document.querySelector('[data-testid="chat-file-content"] img[src^="data:image/png"]'))));
        cards.find((item) => item.textContent.includes('preview.pdf'))?.click();
        check('PDF 第一页渲染到画布', await waitFor(() => {
          const canvas = document.querySelector('[data-pdf-preview] canvas');
          return Boolean(canvas && canvas.width > 0 && canvas.height > 0 && !document.querySelector('[data-pdf-preview] [role="alert"]'));
        }));
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 300,
    },
    {
      name: '10-code-preview',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const session = [...document.querySelectorAll('[data-testid="session-item"]')].find((item) => item.textContent.includes('预览文件：图片与 PDF'));
        checks.push({ label: '找到代码预览会话', ok: Boolean(session) });
        if (!session) return { ok: false, checks };
        session.click();
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const started = Date.now();
        while (Date.now() - started < 8000 && ![...document.querySelectorAll('[data-testid="chat-file-card"]')].some((item) => item.textContent.includes('preview.yml'))) await wait(200);
        const card = [...document.querySelectorAll('[data-testid="chat-file-card"]')].find((item) => item.textContent.includes('preview.yml'));
        checks.push({ label: 'YAML 文件卡出现', ok: Boolean(card) });
        if (!card) return { ok: false, checks };
        card.click();
        const rendered = await (async () => {
          const start = Date.now();
          while (Date.now() - start < 8000) {
            const code = document.querySelector('[data-code-preview]');
            if ((code?.textContent ?? '').trim().length > 0) return true;
            await wait(200);
          }
          return false;
        })();
        checks.push({ label: '代码预览显示 YAML 内容', ok: rendered });
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 600,
    },
    {
      name: '11-slash-skill-menu',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (test, timeout = 6000) => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            if (test()) return true;
            await wait(150);
          }
          return false;
        };
        // 回到空白新对话：导航项切到 #/chat（清掉 ?session）
        document.querySelector('[data-testid="nav-chat"]').click();
        await wait(700);
        const input = document.querySelector('[data-testid="chat-input"]');
        if (!input) return { ok: false, checks: [{ label: '输入框存在', ok: false }] };
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
        setter.call(input, '/');
        input.setSelectionRange(1, 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        check('输入 / 打开 Skill 候选层', await waitFor(() => Boolean(document.querySelector('[data-testid="slash-menu"]'))));
        const rows = [...document.querySelectorAll('[data-testid="slash-menu"] [role="option"]')];
        check('候选行来自中心库', rows.length >= 1);
        // 停在这里：截图要拍到展开的候选层
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 300,
    },
    {
      name: '12-slash-pick',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (test, timeout = 6000) => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            if (test()) return true;
            await wait(150);
          }
          return false;
        };
        const input = document.querySelector('[data-testid="chat-input"]');
        if (!input) return { ok: false, checks: [{ label: '输入框存在', ok: false }] };
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
        // 先清空再输入，避免同值不触发 onChange
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(120);
        setter.call(input, '/');
        input.setSelectionRange(1, 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await waitFor(() => Boolean(document.querySelector('[data-testid="slash-menu"]')));
        const rows = [...document.querySelectorAll('[data-testid="slash-menu"] [role="option"]')];
        check('候选层再次打开', rows.length >= 1);
        if (rows.length === 0) return { ok: false, checks };
        const name = rows[0].querySelector('span')?.textContent ?? '';
        rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await wait(300);
        check('选中后插入 /技能名', input.value === '/' + name + ' ');
        check('选中后候选层关闭', !document.querySelector('[data-testid="slash-menu"]'));
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 300,
    },
    {
      name: '13-session-menu',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (test, timeout = 8000) => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            if (test()) return true;
            await wait(150);
          }
          return false;
        };
        const rows = () => [...document.querySelectorAll('[data-testid="session-item"]')];
        await waitFor(() => rows().length >= 2);
        const more = rows().at(-1)?.querySelector('[data-testid="session-more"]');
        check('会话行默认显示时间而不是 ⋯', Boolean(more) && getComputedStyle(more).display === 'none');
        if (!more) return { ok: false, checks };
        more.click();
        check('点 ⋯ 打开会话菜单', await waitFor(() => Boolean(document.querySelector('[data-testid="session-menu"]'))));
        check('菜单项是「归档会话」', (document.querySelector('[data-testid="session-archive"]')?.textContent ?? '').trim() === '归档会话');
        // 停在这里：截图要拍到展开的会话菜单
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 300,
    },
    {
      name: '14-session-archive',
      hash: '#/chat',
      script: `(async () => {
        const checks = [];
        const check = (label, ok) => checks.push({ label, ok: Boolean(ok) });
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (test, timeout = 8000) => {
          const started = Date.now();
          while (Date.now() - started < timeout) {
            if (test()) return true;
            await wait(150);
          }
          return false;
        };
        const rows = () => [...document.querySelectorAll('[data-testid="session-item"]')];
        await waitFor(() => rows().length >= 2);
        const before = rows().length;
        const more = rows().at(-1)?.querySelector('[data-testid="session-more"]');
        if (!more) return { ok: false, checks: [{ label: '存在会话行操作入口', ok: false }] };
        const title = more.getAttribute('aria-label') ?? '';
        more.click();
        await waitFor(() => Boolean(document.querySelector('[data-testid="session-menu"]')));
        document.querySelector('[data-testid="session-archive"]').click();
        check('归档后列表少一项', await waitFor(() => rows().length === before - 1));
        check(
          '被归档的会话不再出现',
          !rows().some((item) => (item.querySelector('[data-testid="session-more"]')?.getAttribute('aria-label') ?? '') === title),
        );
        return { ok: checks.every((item) => item.ok), checks };
      })()`,
      settleMs: 300,
    },
  ],
  // T13：Agents（多 Tab + 绿/灰行 + 灯提示 / 入库成功 / 冲突失败 / agent 源详情 / 空态）
  t13: [
    {
      name: '01-agents-list',
      hash: '#/agents',
      script: `(async () => {
        const dot = document.querySelector('[data-testid="agent-status-dot"][data-managed="true"]');
        dot?.focus();
        return Boolean(dot);
      })()`,
      settleMs: 700,
    },
    {
      name: '02-adopt-success',
      hash: '#/agents',
      script: `(async () => {
        ${T13_RESET}
        const row = [...document.querySelectorAll('[data-testid="agent-skill-row"]')].find(
          (item) => item.getAttribute('data-dir-name') === 'agent-alpha',
        );
        row.querySelector('[data-testid="agent-adopt"]').click();
        await T13_WAIT(2200);
        return row.getAttribute('data-managed') === 'true';
      })()`,
      settleMs: 400,
    },
    {
      name: '03-adopt-conflict',
      hash: '#/agents',
      script: `(async () => {
        ${T13_RESET}
        const row = [...document.querySelectorAll('[data-testid="agent-skill-row"]')].find(
          (item) => item.getAttribute('data-dir-name') === 'conflict-skill',
        );
        row.querySelector('[data-testid="agent-adopt"]').click();
        await T13_WAIT(1800);
        return Boolean(row.querySelector('[data-testid="agent-row-error"]'));
      })()`,
      settleMs: 400,
    },
    {
      name: '04-agent-detail',
      hash: '#/agents',
      script: `(async () => {
        ${T13_RESET}
        const row = [...document.querySelectorAll('[data-testid="agent-skill-row"]')].find(
          (item) => item.getAttribute('data-dir-name') === 'conflict-skill',
        );
        row.querySelector('td:nth-child(1)').click();
        await T13_WAIT(1500);
        document.querySelector('[data-rel-path="references/notes.md"]')?.click();
        await T13_WAIT(400);
        return window.location.hash.startsWith('#/agent/claude-code/conflict-skill');
      })()`,
      settleMs: 400,
    },
    {
      name: '05-empty-state',
      hash: '#/agents',
      script: `(async () => {
        ${T13_RESET}
        const tab = [...document.querySelectorAll('[role="tab"]')].find((button) => button.textContent === 'Cursor');
        tab.click();
        await T13_WAIT(1000);
        return Boolean(document.querySelector('[data-testid="agent-empty"]'));
      })()`,
      settleMs: 400,
    },
  ],
  // T14-A：备份页未连接 → 连接远端 → Pull 遇冲突（错误就地显示，无冲突处理入口）
  t14: [
    { name: '01-disconnected', hash: '#/backup', settleMs: 1000 },
    {
      name: '02-connected',
      hash: '#/backup',
      script: `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const input = document.querySelector('[data-testid="sync-repo-input"]');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
        setter.call(input, ${JSON.stringify(T14_REMOTE_A.replace(/\\/g, '/'))});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(300);
        document.querySelector('[data-testid="sync-connect"]').click();
        const started = Date.now();
        while (Date.now() - started < 20000) {
          if (document.querySelector('[data-testid="sync-change"]')) return true;
          await wait(200);
        }
        return false;
      })()`,
      settleMs: 700,
    },
    {
      name: '03-pull-conflict-error',
      hash: '#/backup',
      script: `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const started = Date.now();
        document.querySelector('[data-testid="sync-pull"]').click();
        while (Date.now() - started < 40000) {
          if (document.querySelector('[data-testid="sync-feedback"][data-tone="error"]')) return true;
          await wait(200);
        }
        return false;
      })()`,
      settleMs: 700,
    },
  ],
  // T14-B：Push 被拒（错误就地显示，无额外交互入口）
  t14b: [
    {
      name: '04-push-rejected',
      hash: '#/backup',
      script: `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const started = Date.now();
        document.querySelector('[data-testid="sync-push"]').click();
        while (Date.now() - started < 40000) {
          if (document.querySelector('[data-testid="sync-feedback"][data-tone="error"]')) return true;
          await wait(200);
        }
        return false;
      })()`,
      settleMs: 700,
    },
  ],
};

/**
 * T15 自动截图的本地模拟模型服务（OpenAI 兼容 SSE）。
 *
 * 只在 `--scenario=t15` 的截图进程内启动，监听 127.0.0.1 固定端口；
 * 种子把供应商 Endpoint 指到它，因此截图全程零真实网络与零真实 Key。
 * 三种脚本：慢速流式（验证运行中状态与停止）/ 生成文件（验证文件卡与右侧文件区）/ 收尾文本。
 */
function createT15FakeModel(): http.Server {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const send = (res: http.ServerResponse, payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const skillMd = [
    '---',
    'name: meeting-notes',
    'description: 把会议录音逐字稿整理成带决议与待办的结构化纪要',
    '---',
    '',
    '# meeting-notes',
    '',
    '## 何时使用',
    '当用户需要把会议记录整理成可执行的纪要与待办时使用。',
    '',
    '## 步骤',
    '1. 读取逐字稿，按议题分段。',
    '2. 抽取决议、负责人与截止时间。',
    '3. 输出「决议 / 待办 / 待确认」三节。',
    '',
  ].join('\n');
  const notes = '# 记录约定\n\n- 待办必须包含负责人与截止时间。\n- 未确认事项单独列出。\n';

  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      void (async () => {
        let parsed: { messages?: Array<{ role?: string; content?: unknown }>; model?: string } = {};
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          parsed = {};
        }
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const last = messages[messages.length - 1];
        const lastContent = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
        const base = {
          id: 't15-mock',
          object: 'chat.completion.chunk',
          created: 1,
          model: parsed.model ?? 'mock-model',
        };
        const usage = { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192 };
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

        if (last?.role === 'tool') {
          const text = '已写入 SKILL.md 与 references/notes.md，并按流程补齐了触发描述与执行步骤。';
          const parts = [text.slice(0, 18), text.slice(18, 40), text.slice(40)];
          for (const part of parts) {
            send(res, { ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
            await sleep(280);
          }
          send(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        if (lastContent.includes('生成文件')) {
          send(res, {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: '我先按流程生成 SKILL.md 与一份记录约定。',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_write_skill',
                      type: 'function',
                      function: { name: 'write', arguments: JSON.stringify({ path: 'SKILL.md', content: skillMd }) },
                    },
                    {
                      index: 1,
                      id: 'call_write_notes',
                      type: 'function',
                      function: {
                        name: 'write',
                        arguments: JSON.stringify({ path: 'references/notes.md', content: notes }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          send(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // 慢速流式：用于捕捉「运行中（逐字增量 + 停止）」
        const chunks = [
          '好的，我先确认这个 Skill 的用途：',
          '它要解决什么问题、在什么场景被触发，',
          '以及期望的输入与输出。',
          '确认后我会给出目录结构建议，',
          '再生成 SKILL.md 与必要的引用文件。',
        ];
        for (const chunk of chunks) {
          send(res, { ...base, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
          await sleep(750);
          if (res.writableEnded) return;
        }
        send(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
        res.write('data: [DONE]\n\n');
        res.end();
      })();
    });
  });
}

let t15FakeModel: http.Server | null = null;

async function ensureT15FakeModel(): Promise<void> {
  if (t15FakeModel) return;
  const server = createT15FakeModel();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(T15_FAKE_PORT, '127.0.0.1', () => resolve());
  });
  t15FakeModel = server;
  logger.info('t15:fake-model-listening', { port: T15_FAKE_PORT });
}

const PRODUCT_NAME = 'Skills 工作台';

let win: BrowserWindow | null = null;
let context: AppContext | null = null;

// 单实例锁：应用更新（updates:install）走 NSIS 静默安装，第二个实例会锁住程序文件
// 导致更新失败；锁被占时说明已有实例在跑，直接退出（whenReady 里不再初始化）。
const hasSingleInstanceLock = app.requestSingleInstanceLock();
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!win || win.isDestroyed()) return false;
  if (event.sender !== win.webContents) return false;
  const frame = event.senderFrame;
  return frame !== null && frame === win.webContents.mainFrame;
}

function appInfo(): AppInfoResult {
  const resolved = resolveProductionPaths();
  return {
    productName: PRODUCT_NAME,
    version: app.getVersion(),
    appEnv: resolved.APP_ENV,
    libraryDir: context?.libraryDir ?? resolved.LIBRARY_ROOT,
    dataDir: resolved.DATA_DIR,
    logDir: resolved.LOG_DIR,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
}

function resolveScreenshotDir(): string | null {
  if (!screenshotArg) return null;
  const raw = screenshotArg.slice('--screenshot='.length);
  if (!raw.trim()) return null;
  const dir = path.resolve(PROJECT_ROOT, raw);
  // 隔离纪律：截图只允许写入 tests/runtime/
  if (!dir.startsWith(RUNTIME_ROOT)) {
    logger.error('screenshot:dir-rejected', { dir, expectedRoot: RUNTIME_ROOT });
    return null;
  }
  return dir;
}

async function captureRoutes(dir: string): Promise<void> {
  if (!win) throw new Error('window not created');
  const all = SCREENSHOT_SCENARIOS[scenario];
  if (!all) throw new Error(`未知截图场景：${scenario}`);
  // 调试用：SHOT_ONLY=11,12 只跑名称以这些前缀开头的步骤（默认全跑）
  const only = (process.env.SHOT_ONLY ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const routes = only.length === 0
    ? all
    : all.filter((route) => only.some((prefix) => route.name.startsWith(prefix)));
  fs.mkdirSync(dir, { recursive: true });
  // 等首屏字体与布局稳定，再逐路由切换
  await delay(600);
  for (const route of routes) {
    if (route.size) {
      win.setSize(route.size[0], route.size[1]);
      await delay(300);
    }
    await win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(route.hash)}; true`, true);
    await delay(500);
    if (route.script) {
      const result = await win.webContents.executeJavaScript(route.script, true);
      // T15：截图前自检，逐步打印 check；任何一步失败即终止，绝不落「假通过」截图
      if (scenario === 't15') {
        const detail = (result ?? null) as { ok?: boolean; checks?: Array<{ label: string; ok: boolean }> } | null;
        const checks = Array.isArray(detail?.checks) ? detail.checks : [];
        const ok = detail?.ok === true;
        logger.info('screenshot:step-check', {
          step: route.name,
          ok,
          passed: checks.filter((item) => item.ok).length,
          total: checks.length,
          checks,
        });
        if (!ok) {
          logger.error('screenshot:step-failed', { step: route.name, result });
          throw new Error(
            `截图步骤自检失败：${route.name} ${JSON.stringify(checks.filter((item) => !item.ok))}`,
          );
        }
      }
      await delay(route.settleMs ?? 600);
    } else if (route.settleMs) {
      await delay(route.settleMs);
    }
    // 软件渲染下窗口可能被判定为遮挡而暂停呈现；切换路由后强制刷新，
    // 避免截图仍是上一张画面。窗口被遮挡时 rAF 不会触发，这里带超时兜底，
    // 否则自动化会在某个步骤上永久等待。
    if (scenario === 't09' || scenario === 'main' || scenario === 't12' || scenario === 't13' || scenario === 't14' || scenario === 't14b' || scenario === 't15') {
      win.webContents.invalidate();
      await win.webContents.executeJavaScript(
        `Promise.race([
          new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))),
          new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
        ])`,
        true,
      );
      await delay(120);
    }
    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    const size = image.getSize();
    const file = path.join(dir, `${route.name}.png`);
    fs.writeFileSync(file, png);
    logger.info('screenshot:captured', {
      route: route.hash,
      file,
      width: size.width,
      height: size.height,
      bytes: png.length,
    });
  }
  logger.info('screenshot:done', { count: routes.length, dir, scenario });
  await runInteractionCheck();
}

/**
 * 截图后的真实交互自检（T10）：
 *  - first-run：点击「导入选中项」→ 结果计数 → 点击「进入主页」→ 落到主页；
 *  - main：点击近期动态整行 → 进入 `#/library/<skillId>` 详情路由。
 * 只操作隔离种子，失败即让截图流程 exit 1。
 */
async function runInteractionCheck(): Promise<void> {
  if (!win) throw new Error('window not created');
  if (scenario === 't15') {
    const result = (await win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const setValue = (el, value) => {
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const out = { checks: [] };
        const check = (label, ok) => out.checks.push({ label, ok: Boolean(ok) });

        window.location.hash = '#/home';
        await wait(250);
        window.location.hash = '#/chat';
        await wait(900);

        check('快捷项位于输入框上方', document.querySelectorAll('[data-testid^="chat-quick-"]').length >= 1);
        check('无语音入口', !document.querySelector('[data-testid="chat-voice"]'));
        check('深色圆形发送按钮', Boolean(document.querySelector('[data-testid="chat-send"]')));

        // 快捷项 → 把提示词插进当前输入框（不建会话、不弹框、不运行）
        const sessionsBefore = document.querySelectorAll('[data-testid="session-item"]').length;
        document.querySelector('[data-testid="chat-quick-create"]').click();
        await wait(900);
        const input = document.querySelector('[data-testid="chat-input"]');
        check('点快捷项后输入框非空', (input?.value ?? '').length > 0);
        check('此时未开始运行', !document.querySelector('[data-testid="chat-stop"]'));
        check('点快捷项不新建会话', document.querySelectorAll('[data-testid="session-item"]').length === sessionsBefore);
        check('点快捷项不弹框', !document.querySelector('[data-testid="chat-create-modal"]'));

        // 发送（慢速流式）→ 运行状态 → 停止 → 已收文本保留
        setValue(input, '演示：慢速流式回复，先给我一个开头。');
        await wait(250);
        document.querySelector('[data-testid="chat-send"]').click();
        await wait(2200);
        check(
          '发送后出现运行状态',
          document.querySelector('[data-testid="chat-status"]')?.getAttribute('data-status') === 'running',
        );
        check('运行中显示停止', Boolean(document.querySelector('[data-testid="chat-stop"]')));
        out.runningText = (document.querySelector('[data-testid="chat-messages"]')?.textContent ?? '').length;
        document.querySelector('[data-testid="chat-stop"]')?.click();
        await wait(1600);
        check(
          '停止后状态为 cancelled',
          document.querySelector('[data-testid="chat-status"]')?.getAttribute('data-status') === 'cancelled',
        );
        check(
          '取消后已收文本保留',
          (document.querySelector('[data-testid="chat-messages"]')?.textContent ?? '').length > 0,
        );

        // 继续发送（生成文件）→ 完成 → 文件卡
        setValue(input, '演示：生成文件（写入 SKILL.md 与 references/notes.md）。');
        await wait(250);
        document.querySelector('[data-testid="chat-send"]').click();
        await wait(7000);
        out.cards = document.querySelectorAll('[data-testid="chat-file-card"]').length;
        check('完成后出现文件卡', out.cards >= 1);
        out.statusAfter = document.querySelector('[data-testid="chat-status"]')?.getAttribute('data-status');
        check('完成后状态为 done', out.statusAfter === 'done');

        const card = document.querySelector('[data-testid="chat-file-card"]');
        card?.click();
        await wait(700);
        check('点文件卡展开右侧文件区', Boolean(document.querySelector('[data-testid="chat-file-panel"]')));
        check('文件区有标签', document.querySelectorAll('[data-testid="chat-file-tab"]').length >= 1);
        check('预览显示文件内容', (document.querySelector('[data-testid="chat-file-content"]')?.textContent ?? '').length > 0);

        out.ok = out.checks.every((item) => item.ok);
        out.failed = out.checks.filter((item) => !item.ok);
        return out;
      })()`,
      true,
    )) as Record<string, unknown>;
    logger.info('screenshot:interaction', { scenario, result });
    if (result.ok !== true) {
      throw new Error(`新对话/文件区交互自检失败：${JSON.stringify(result.failed ?? result)}`);
    }
    return;
  }
  if (scenario === 't11') {
    const result = (await win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const rows = () => [...document.querySelectorAll('[data-testid="library-row"]')];
        const rowByName = (name) => rows().find((item) => item.getAttribute('data-skill-name') === name);
        const hashNow = () => window.location.hash;
        const out = { checks: [] };
        const check = (label, ok) => out.checks.push({ label, ok: Boolean(ok) });

        window.location.hash = '#/library';
        await wait(900);
        check('列表有数据', rows().length >= 1);
        check('行内有 Group 标签', document.querySelectorAll('[data-testid="library-group-trigger"]').length > 0);
        check('行内有 Agent', document.querySelectorAll('[data-testid="library-agent-trigger"]').length > 0);
        check('行内有 ⋯ 菜单入口', document.querySelectorAll('[data-testid="library-row-menu"]').length > 0);

        const before = hashNow();
        document.querySelector('[data-testid="library-group-trigger"]').click();
        await wait(300);
        check('点 Group 标签不跳转', hashNow() === before);
        check('Group 浮层打开', Boolean(document.querySelector('[data-testid="library-group-popover"]')));
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await wait(200);

        document.querySelector('[data-testid="library-agent-trigger"]').click();
        await wait(300);
        check('点 Agent 不跳转', hashNow() === before);
        check('Agent 浮层打开', Boolean(document.querySelector('[data-testid="library-agent-popover"]')));
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await wait(200);

        rowByName('big-skill').querySelector('[data-testid="library-row-menu"]').click();
        await wait(250);
        check('点 ⋯ 不跳转', hashNow() === before);
        check('有报告时显示「评测查看」', Boolean(document.querySelector('[data-testid="menu-report"]')));
        rowByName('big-skill').querySelector('[data-testid="library-row-menu"]').click();
        await wait(200);
        rowByName('code-review').querySelector('[data-testid="library-row-menu"]').click();
        await wait(250);
        check('无报告时不显示「评测查看」', !document.querySelector('[data-testid="menu-report"]'));
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await wait(200);

        // 搜索（名称/描述）
        const search = document.querySelector('[data-testid="library-search"]');
        const setValue = (el, value) => {
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const totalBeforeSearch = rows().length;
        setValue(search, 'doc');
        await wait(700);
        out.searchRows = rows().map((item) => item.getAttribute('data-skill-name'));
        check('搜索按名称/描述过滤', out.searchRows.length > 0 && out.searchRows.length < totalBeforeSearch);
        setValue(search, '');
        await wait(700);

        // Group 勾选立即生效（不依赖具体 Group 名）
        const rowTextBefore = (rowByName('code-review')?.textContent ?? '').replace(/\\s+/g, ' ');
        rowByName('code-review').querySelector('[data-testid="library-group-trigger"]').click();
        await wait(300);
        const groupBox = document.querySelector('[data-testid="library-group-popover"] input[type="checkbox"]');
        groupBox.click();
        await wait(900);
        check(
          'Group 勾选立即生效',
          (rowByName('code-review')?.textContent ?? '').replace(/\\s+/g, ' ') !== rowTextBefore,
        );
        const groupBox2 = document.querySelector('[data-testid="library-group-popover"] input[type="checkbox"]');
        groupBox2.click();
        await wait(900);
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await wait(250);

        // Agent 勾选立即同步并在当前行反馈（不依赖具体 Agent 名）
        rowByName('big-skill').querySelector('[data-testid="library-agent-trigger"]').click();
        await wait(300);
        const agentLabel = document.querySelector('[data-testid="library-agent-popover"] label');
        agentLabel.querySelector('input').click();
        await wait(1000);
        out.agentRowText = (rowByName('big-skill')?.textContent ?? '').replace(/\\s+/g, ' ').trim();
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await wait(250);

        document.querySelector('[data-testid="library-multi-toggle"]').click();
        await wait(250);
        const boxes = () => [...document.querySelectorAll('[data-testid="library-row-checkbox"]')];
        boxes()[0].click();
        boxes()[1].click();
        await wait(350);
        out.batchText = (document.querySelector('[data-testid="library-batch-bar"]')?.textContent ?? '').replace(/\\s+/g, ' ').trim();
        const checkedCount = boxes().filter((box) => box.checked).length;
        check('多选模式勾选生效', checkedCount === 2);
        document.querySelector('[data-testid="library-select-all"]').click();
        await wait(350);
        out.batchAll = (document.querySelector('[data-testid="library-batch-bar"]')?.textContent ?? '').replace(/\\s+/g, ' ').trim();
        check('表头复选框全选当前筛选结果', boxes().length > 0 && boxes().every((box) => box.checked));
        document.querySelector('[data-testid="library-multi-toggle"]').click();
        await wait(300);

        // 行普通区域 → 技能详情
        rowByName('big-skill').querySelector('td:nth-child(1)').click();
        await wait(1600);
        out.hashAfterRow = hashNow();
        out.detailTitle = document.querySelector('h1')?.textContent ?? '';
        check('点行普通区域进入详情', out.hashAfterRow.startsWith('#/library/'));

        out.treeFiles = document.querySelectorAll('[data-testid="skill-tree-file"]').length;
        check('文件树可见', out.treeFiles >= 1);
        out.tabsBefore = document.querySelectorAll('[data-testid="skill-tab"]').length;
        check('默认打开 SKILL.md 标签', out.tabsBefore >= 1);
        document.querySelector('[data-rel-path="references/file-01.md"]').click();
        await wait(500);
        out.tabsAfter = document.querySelectorAll('[data-testid="skill-tab"]').length;
        check('点击树中文件打开/激活标签', out.tabsAfter === out.tabsBefore + 1);

        out.previewDefault = Boolean(document.querySelector('[data-testid="skill-preview"]'));
        check('文件默认以预览打开', out.previewDefault);
        out.actionCount = document.querySelectorAll('[data-testid="skill-save"]').length;
        check('文件行只有一个操作按钮', out.actionCount === 1);
        document.querySelector('[data-testid="skill-save"]').click();
        await wait(350);
        out.actionText = (document.querySelector('[data-testid="skill-save"]')?.textContent ?? '').trim();
        check('点编辑后进入编辑态', Boolean(document.querySelector('[data-testid="skill-editor"]')));

        const editor = document.querySelector('[data-testid="skill-editor"]');
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value').set;
        setter.call(editor, editor.value + '\\n未保存内容-自检');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(350);
        out.dirtyCount = document.querySelectorAll('[data-testid="skill-tab"][data-dirty="true"]').length;
        check('编辑后标签显示未保存标记', out.dirtyCount === 1);

        const tabs = [...document.querySelectorAll('[data-testid="skill-tab"]')];
        tabs[0].querySelector('button').click();
        await wait(300);
        tabs[tabs.length - 1].querySelector('button').click();
        await wait(300);
        out.dirtyKept = (document.querySelector('[data-testid="skill-editor"]')?.value ?? '').includes('未保存内容-自检');
        check('切换标签保留未保存内容', out.dirtyKept);
        out.saveVisible = Boolean(document.querySelector('[data-testid="skill-save"]'));
        check('保存按钮位于文件行', out.saveVisible);

        document.querySelector('[data-testid="skill-save"]').click();
        await wait(900);
        out.backToPreview = Boolean(document.querySelector('[data-testid="skill-preview"]'));
        check('保存后回到预览态', out.backToPreview);
        out.feedback = (document.querySelector('[data-testid="skill-feedback"]')?.textContent ?? '').trim();
        out.dirtyAfterSave = document.querySelectorAll('[data-testid="skill-tab"][data-dirty="true"]').length;
        check('保存成功并清除标记', out.dirtyAfterSave === 0);

        // 保存后关闭再重开：显示新内容（C-33）
        document.querySelector('[data-testid="skill-tab"][title="references/file-01.md"] button[aria-label^="关闭"]')?.click();
        await wait(400);
        document.querySelector('[data-rel-path="references/file-01.md"]').click();
        await wait(700);
        out.reopenedContent = (document.querySelector('[data-testid="skill-preview"]')?.textContent ?? '').includes(
          '未保存内容-自检',
        );
        check('保存后重新打开文件显示新内容', out.reopenedContent === true);

        // 关闭有改动的标签 → 保存/放弃/取消
        document.querySelector('[data-testid="skill-save"]').click();
        await wait(300);
        const editorClose = document.querySelector('[data-testid="skill-editor"]');
        const setterClose = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editorClose), 'value').set;
        setterClose.call(editorClose, editorClose.value + '\\n待关闭修改');
        editorClose.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(300);
        document.querySelector('[data-testid="skill-tab"][data-dirty="true"] button[aria-label^="关闭"]')?.click();
        await wait(350);
        check('关闭有改动标签时弹出保存/放弃/取消', Boolean(document.querySelector('[data-testid="skill-close-prompt"]')));
        [...document.querySelectorAll('[data-testid="skill-close-prompt"] button')]
          .find((button) => button.textContent.trim() === '取消')
          ?.click();
        await wait(300);
        check('取消关闭后标签仍在', document.querySelectorAll('[data-testid="skill-tab"]').length === out.tabsAfter);

        const editor2 = document.querySelector('[data-testid="skill-editor"]');
        const setter2 = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor2), 'value').set;
        setter2.call(editor2, editor2.value + '\\n再次修改');
        editor2.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(300);
        document.querySelector('[data-testid="skill-back"]').click();
        await wait(400);
        check('离开页面前提示保存/放弃/取消', Boolean(document.querySelector('[data-testid="skill-leave-prompt"]')));
        const discard = [...document.querySelectorAll('[data-testid="skill-leave-prompt"] button')].find((button) =>
          button.textContent.includes('放弃'),
        );
        discard?.click();
        await wait(700);
        out.hashAfterLeave = hashNow();
        check('放弃修改后回到中心库', out.hashAfterLeave === '#/library');

        // 行菜单「编辑」→ 预填会话并跳转新对话（不自动运行）
        await wait(400);
        rowByName('big-skill').querySelector('[data-testid="library-row-menu"]').click();
        await wait(300);
        document.querySelector('[data-testid="menu-edit"]').click();
        await wait(1000);
        out.hashAfterPrefill = hashNow();
        check('「编辑」预填会话并跳转新对话', out.hashAfterPrefill.startsWith('#/chat?session='));

        out.ok = out.checks.every((item) => item.ok);
        out.failed = out.checks.filter((item) => !item.ok);
        return out;
      })()`,
      true,
    )) as Record<string, unknown>;
    logger.info('screenshot:interaction', { scenario, result });
    if (result.ok !== true) {
      throw new Error(`中心库/详情交互自检失败：${JSON.stringify(result.failed ?? result)}`);
    }
    return;
  }

  if (scenario === 't12') {
    const result = (await win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const rows = () => [...document.querySelectorAll('[data-testid="install-row"]')];
        const tab = (label) => [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent === label);
        const setValue = (el, value) => {
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const out = { checks: [] };
        const check = (label, ok) => out.checks.push({ label, ok: Boolean(ok) });

        window.location.hash = '#/home';
        await wait(250);
        window.location.hash = '#/install';
        await wait(1800);

        check('存在来源 Tab', document.querySelectorAll('[role="tab"]').length >= 1);
        check('默认显示技能市场榜单', rows().length > 0 && Boolean(document.querySelector('[data-testid="install-list"]')));

        // Tab 状态保留：Git 输入 / 本地结果互不干扰
        tab('Git 地址').click();
        await wait(300);
        const gitInput = document.querySelector('[data-testid="install-git-url"]');
        setValue(gitInput, 'E:/tmp/keep-me.git');
        await wait(250);
        tab('本地目录').click();
        await wait(300);
        document.querySelector('[data-testid="install-local-pick"]').click();
        await wait(400);
        document.querySelector('[data-testid="install-local-scan"]').click();
        await wait(1200);
        const localCount = rows().length;
        check('本地目录扫描出 Skills（含无效项）', localCount >= 1);
        check('无效目录有原因', Boolean(document.querySelector('[data-testid="install-invalid-badge"]')));

        tab('Git 地址').click();
        await wait(300);
        check('切回 Git 保留输入', document.querySelector('[data-testid="install-git-url"]').value === 'E:/tmp/keep-me.git');
        check('Git Tab 不显示本地结果', rows().length === 0);
        tab('本地目录').click();
        await wait(300);
        check('切回本地保留结果与路径', rows().length === localCount && Boolean(document.querySelector('[data-testid="install-local-path"]')));

        // 全选 / 取消
        document.querySelector('[data-testid="install-select-all"]').click();
        await wait(300);
        out.selectedAll = (document.querySelector('[data-testid="install-selected-count"]')?.textContent ?? '').trim();
        const selectable = rows().filter((row) => {
          const box = row.querySelector('[data-testid="install-row-checkbox"]');
          return box && !box.disabled;
        }).length;
        const checkedAll = rows().filter((row) => row.querySelector('[data-testid="install-row-checkbox"]')?.checked).length;
        check('全选选中全部有效项', selectable > 0 && checkedAll === selectable);
        document.querySelector('[data-testid="install-select-all"]').click();
        await wait(300);
        out.selectedNone = (document.querySelector('[data-testid="install-selected-count"]')?.textContent ?? '').trim();
        check('再次点击取消全选', rows().every((row) => !row.querySelector('[data-testid="install-row-checkbox"]')?.checked));

        // 本地导入：计数 + 失败原因
        document.querySelector('[data-testid="install-select-all"]').click();
        await wait(200);
        document.querySelector('[data-testid="install-import"]').click();
        await wait(2200);
        out.resultText = (document.querySelector('[data-testid="install-result"]')?.textContent ?? '').replace(/\\s+/g, ' ').trim();
        check('导入结果计数出现', Boolean(document.querySelector('[data-testid="install-result"]')));
        out.rowText = (rows().find((row) => row.getAttribute('data-item-name') === 'local-alpha')?.textContent ?? '').replace(/\\s+/g, ' ');
        check('已入库项不再提供详情入口', !document.querySelector('[data-testid="install-detail-link"]'));

        // 扫描本机：结果带来源 Agent
        tab('扫描本机').click();
        await wait(300);
        document.querySelector('[data-testid="install-scan-rescan"]').click();
        await wait(1500);
        out.agentRows = rows().length;
        out.agentText = rows().map((row) => row.textContent).join(' ');
        check('扫描本机列出 Agent 来源', out.agentRows >= 1);

        // 市场导入不需要额外确认
        window.location.hash = '#/home';
        await wait(250);
        window.location.hash = '#/install';
        await wait(1800);
        const pdfRow = rows().find((row) => row.getAttribute('data-item-name') === 'pdf');
        pdfRow.querySelector('[data-testid="install-row-checkbox"]').click();
        await wait(250);
        document.querySelector('[data-testid="install-import"]').click();
        await wait(1600);
        const marketFeedback = document.querySelector('[data-testid="install-result"]')
          || document.querySelector('[data-testid="install-error"]')
          || document.querySelector('[data-testid="install-import"]')?.textContent?.includes('正在导入');
        check('市场导入直接执行并显示状态', !document.querySelector('[data-testid="install-script-modal"]') && Boolean(marketFeedback));
        await wait(250);

        out.ok = out.checks.every((item) => item.ok);
        out.failed = out.checks.filter((item) => !item.ok);
        return out;
      })()`,
      true,
    )) as Record<string, unknown>;
    logger.info('screenshot:interaction', { scenario, result });
    if (result.ok !== true) {
      throw new Error(`安装 Skills 交互自检失败：${JSON.stringify(result.failed ?? result)}`);
    }
    return;
  }

  if (scenario === 't13') {
    const result = (await win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const rows = () => [...document.querySelectorAll('[data-testid="agent-skill-row"]')];
        const row = (dir) => rows().find((item) => item.getAttribute('data-dir-name') === dir);
        const tab = (label) => [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent === label);
        const out = { checks: [] };
        const check = (label, ok) => out.checks.push({ label, ok: Boolean(ok) });

        window.location.hash = '#/home';
        await wait(250);
        window.location.hash = '#/agents?agent=claude-code';
        await wait(1700);

        out.tabCount = document.querySelectorAll('[role="tab"]').length;
        out.title = document.querySelector('h1')?.textContent ?? '';
        check('顶部有 Agent Tab 且无概览 Tab', out.tabCount >= 1 && !tab('概览'));

        const green = rows().filter((item) => item.getAttribute('data-managed') === 'true').length;
        const gray = rows().filter((item) => item.getAttribute('data-managed') === 'false').length;
        const adoptButtons = document.querySelectorAll('[data-testid="agent-adopt"]').length;
        out.green = green;
        out.gray = gray;
        check('同时存在绿灯与灰灯行', green >= 1 && gray >= 1);
        check('入库按钮只出现在灰灯行', adoptButtons === gray);

        const dot = row('code-review')?.querySelector('[data-testid="agent-status-dot"]');
        dot?.focus();
        await wait(250);
        out.tip = (document.querySelector('[data-testid="agent-status-tip"]')?.textContent ?? '').trim();
        check('状态灯悬停/聚焦显示含义', Boolean(document.querySelector('[data-testid="agent-status-tip"]')));
        const hashBefore = window.location.hash;
        dot?.click();
        await wait(200);
        check('点击状态灯不触发行跳转', window.location.hash === hashBefore);

        check('截图阶段入库的 agent-alpha 已变绿', row('agent-alpha')?.getAttribute('data-managed') === 'true');
        const lib = await window.skp.invoke('library:list', { query: 'agent-alpha' });
        out.librarySource = lib.ok ? lib.data.items[0]?.source ?? null : null;
        check(
          '库中可见 Agent 来源（agent-dir + Agent 标签）',
          lib.ok && out.librarySource?.type === 'agent-dir' && Boolean(out.librarySource?.origin),
        );

        row('conflict-skill').querySelector('[data-testid="agent-adopt"]').click();
        await wait(1800);
        out.conflictError = (row('conflict-skill')?.querySelector('[data-testid="agent-row-error"]')?.textContent ?? '').trim();
        check('点击入库不触发行跳转', window.location.hash.startsWith('#/agents?agent='));
        check('同名异内容行内显示原因', Boolean(row('conflict-skill')?.querySelector('[data-testid="agent-row-error"]')));
        check('入库失败仍保持灰灯', row('conflict-skill')?.getAttribute('data-managed') === 'false');

        tab('Codex').click();
        await wait(1500);
        check('切换 Agent Tab 显示该 Agent 的 Skills', Boolean(row('agent-beta')) && Boolean(row('doc-writer')));
        row('agent-beta').querySelector('[data-testid="agent-adopt"]').click();
        await wait(2200);
        check(
          'Codex 灰灯入库成功后变绿且按钮消失',
          row('agent-beta')?.getAttribute('data-managed') === 'true' &&
            !row('agent-beta')?.querySelector('[data-testid="agent-adopt"]'),
        );

        tab('Claude Code').click();
        await wait(1100);
        check('切换 Tab 保留各自扫描结果', row('agent-alpha')?.getAttribute('data-managed') === 'true');

        row('agent-alpha').querySelector('td:nth-child(1)').click();
        await wait(1600);
        out.detailHash = window.location.hash;
        out.hint = (document.querySelector('[data-testid="agent-source-hint"]')?.textContent ?? '').trim();
        out.treeFiles = document.querySelectorAll('[data-testid="skill-tree-file"]').length;
        check('点击整行进入 Agent 源详情', out.detailHash.startsWith('#/agent/'));
        check('已入库技能显示来源提示', Boolean(document.querySelector('[data-testid="agent-source-hint"]')));
        check('详情复用真实文件树', out.treeFiles >= 1);

        document.querySelector('[data-testid="skill-back"]').click();
        await wait(1200);
        out.backHash = window.location.hash;
        check('返回回到进入前的 Agent Tab', out.backHash.startsWith('#/agents?agent='));

        tab('Cursor').click();
        await wait(1200);
        check('空目录显示空态', Boolean(document.querySelector('[data-testid="agent-empty"]')));

        const beforeRescan = rows().length;
        document.querySelector('[data-testid="agents-rescan"]').click();
        await wait(1400);
        check('重新扫描可用且不改变空态结论', rows().length === beforeRescan);

        out.ok = out.checks.every((item) => item.ok);
        out.failed = out.checks.filter((item) => !item.ok);
        return out;
      })()`,
      true,
    )) as Record<string, unknown>;
    logger.info('screenshot:interaction', { scenario, result });
    if (result.ok !== true) {
      throw new Error(`Agents 交互自检失败：${JSON.stringify(result.failed ?? result)}`);
    }
    return;
  }

  if (scenario === 't14') {
    const result = (await win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (fn, timeout = 20000) => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeout) {
            if (fn()) return true;
            await wait(150);
          }
          return false;
        };
        const out = { checks: [] };
        const check = (label, ok) => out.checks.push({ label, ok: Boolean(ok) });
        const text = (selector) => (document.querySelector(selector)?.textContent ?? '').replace(/\\s+/g, ' ').trim();

        window.location.hash = '#/home';
        await wait(250);
        window.location.hash = '#/backup';
        await wait(600);
        await waitFor(() => !document.querySelector('[data-testid="sync-loading"]'));
        await wait(200);

        check('显示已连接状态', Boolean(document.querySelector('[data-testid="sync-change"]')));
        check(
          '本地备份显示最近备份信息',
          Boolean((document.querySelector('[data-testid="sync-last-commit"]')?.textContent ?? '').trim()),
        );
        check('页面不再有版本历史表', !document.querySelector('[data-testid="sync-history-row"]'));
        check('页面不再有冲突处理区', !document.querySelector('[data-testid="sync-conflict-card"]'));

        // 本地备份：点一下即产生提交（种子库有未提交变更）或报告无变更
        document.querySelector('[data-testid="sync-commit"]').click();
        await waitFor(() => Boolean(document.querySelector('[data-testid="sync-commit-feedback"]')), 30000);
        check('本地备份就地反馈', Boolean(document.querySelector('[data-testid="sync-commit-feedback"]')));

        // Pull 遇冲突：整次失败，错误就地显示，不出现冲突选择界面
        await waitFor(() => !document.querySelector('[data-testid="sync-pull"]').disabled, 20000);
        document.querySelector('[data-testid="sync-pull"]').click();
        await waitFor(
          () => Boolean(document.querySelector('[data-testid="sync-feedback"][data-tone="error"]')),
          40000,
        );
        check(
          'Pull 错误就地显示',
          Boolean(document.querySelector('[data-testid="sync-feedback"][data-tone="error"]')),
        );
        check('不出现冲突选择与「应用选择」', !document.querySelector('[data-testid="sync-apply"]'));

        out.diag = {
          lastCommit: (document.querySelector('[data-testid="sync-last-commit"]')?.textContent ?? '').trim(),
          feedback: text('[data-testid="sync-feedback"]'),
          lastPull: text('[data-testid="sync-last-pull"]'),
          pullDisabled: Boolean(document.querySelector('[data-testid="sync-pull"]')?.disabled),
          hasLoading: Boolean(document.querySelector('[data-testid="sync-loading"]')),
        };

        out.ok = out.checks.every((item) => item.ok);
        out.failed = out.checks.filter((item) => !item.ok);
        return out;
      })()`,
      true,
    )) as Record<string, unknown>;
    logger.info('screenshot:interaction', { scenario, result });
    if (result.ok !== true) {
      throw new Error(`备份页 Pull/冲突交互自检失败：${JSON.stringify({ failed: result.failed, diag: result.diag })}`);
    }
    return;
  }

  if (scenario === 't14b') {
    const result = (await win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (fn, timeout = 20000) => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeout) {
            if (fn()) return true;
            await wait(150);
          }
          return false;
        };
        const out = { checks: [] };
        const check = (label, ok) => out.checks.push({ label, ok: Boolean(ok) });
        const text = (selector) => (document.querySelector(selector)?.textContent ?? '').replace(/\\s+/g, ' ').trim();

        window.location.hash = '#/home';
        await wait(250);
        window.location.hash = '#/backup';
        await wait(600);
        await waitFor(() => !document.querySelector('[data-testid="sync-loading"]'));
        await wait(200);

        check('最近 Push 行存在', Boolean(document.querySelector('[data-testid="sync-last-push"]')));
        check('页面不再有版本历史表', !document.querySelector('[data-testid="sync-history-row"]'));
        check('页面不再有恢复入口', !document.querySelector('[data-testid="sync-restore"]'));

        // Push 被拒：错误就地显示，不提供额外操作入口
        await waitFor(() => !document.querySelector('[data-testid="sync-push"]').disabled, 20000);
        document.querySelector('[data-testid="sync-push"]').click();
        await waitFor(
          () => Boolean(document.querySelector('[data-testid="sync-feedback"][data-tone="error"]')),
          40000,
        );
        check(
          'Push 被拒就地反馈',
          Boolean(document.querySelector('[data-testid="sync-feedback"][data-tone="error"]')),
        );
        check('不提供 Pull 快捷入口', !document.querySelector('[data-testid="sync-pull-shortcut"]'));

        out.ok = out.checks.every((item) => item.ok);
        out.failed = out.checks.filter((item) => !item.ok);
        return out;
      })()`,
      true,
    )) as Record<string, unknown>;
    logger.info('screenshot:interaction', { scenario, result });
    if (result.ok !== true) {
      throw new Error(`备份页 Push 被拒/恢复交互自检失败：${JSON.stringify(result.failed ?? result)}`);
    }
    return;
  }
  if (scenario === 'first-run') {
    const result = (await win.webContents.executeJavaScript(
      `(async () => {
        const importBtn = document.querySelector('[data-testid="first-run-import"]');
        if (!importBtn) return { ok: false, reason: 'import button missing' };
        importBtn.click();
        await new Promise((r) => setTimeout(r, 1600));
        const summary = document.querySelector('[data-testid="first-run-result"]')?.textContent ?? '';
        const finish = document.querySelector('[data-testid="first-run-finish"]');
        finish?.click();
        await new Promise((r) => setTimeout(r, 900));
        return {
          ok: true,
          summary: summary.replace(/\\s+/g, ' ').trim(),
          hash: window.location.hash,
          title: document.querySelector('h1')?.textContent ?? null,
          skillCount: document.querySelector('[data-testid="home-skill-count"]')?.textContent ?? null,
        };
      })()`,
      true,
    )) as Record<string, unknown>;
    logger.info('screenshot:interaction', { scenario, result });
    if (result.ok !== true || result.hash !== '#/home' || result.title !== '主页') {
      throw new Error(`首启导入交互校验失败：${JSON.stringify(result)}`);
    }
    return;
  }

  if (scenario === 'main') {
    const result = (await win.webContents.executeJavaScript(
      `(async () => {
        window.location.hash = '#/home';
        await new Promise((r) => setTimeout(r, 600));
        const row = document.querySelector('[data-testid="home-activity"] button');
        if (!row) return { ok: false, reason: 'activity row missing' };
        row.click();
        await new Promise((r) => setTimeout(r, 500));
        return { ok: true, hash: window.location.hash, title: document.querySelector('h1')?.textContent ?? null };
      })()`,
      true,
    )) as Record<string, unknown>;
    logger.info('screenshot:interaction', { scenario, result });
    if (result.ok !== true || !String(result.hash ?? '').startsWith('#/library/')) {
      throw new Error(`主页动态整行跳转校验失败：${JSON.stringify(result)}`);
    }
  }
}

/**
 * 真实窗口内的 IPC 权限自检（T09 / T10 自动验证）：
 * 渲染层无 Node、未白名单通道被 preload 拒绝、占位通道返回 NOT_IMPLEMENTED、参数非法被主进程拒绝。
 * requireShell=true 时额外校验整体导航骨架（首启场景没有侧栏，故跳过）。
 */
async function runIpcSelfCheck(requireShell: boolean): Promise<boolean> {
  if (!win) return false;
  const script = `(async () => {
    const out = {
      requireType: typeof window.require,
      processType: typeof window.process,
      skpType: typeof window.skp,
      channelCount: window.skp ? window.skp.channels.length : 0,
    };
    const info = await window.skp.info();
    out.infoOk = info.ok === true;
    out.version = info.ok ? info.data.version : null;
    out.libraryDir = info.ok ? info.data.libraryDir : null;
    const ping = await window.skp.ping();
    out.pingOk = ping.ok === true && ping.data.ok === true;
    const state = await window.skp.invoke('app:getInitialState');
    out.initialStateOk = state.ok === true;
    out.firstRunCompleted = state.ok ? state.data.firstRunCompleted : null;
    const bad = await window.skp.invoke('app:ping', { unexpected: 1 });
    out.badRequestCode = bad.ok === false ? bad.error.code : 'NO_ERROR';
    const placeholder = await window.skp.invoke('market:leaderboard');
    out.placeholderCode = placeholder.ok === false ? placeholder.error.code : 'NO_ERROR';
    try {
      await window.skp.invoke('fs:read', { path: 'C:/' });
      out.unknownChannel = 'ALLOWED';
    } catch (err) {
      out.unknownChannel = String(err && err.message).includes('IPC_CHANNEL_NOT_ALLOWED') ? 'BLOCKED' : 'UNEXPECTED';
    }
    out.rootChildren = (document.getElementById('root') || {}).childElementCount || 0;
    out.navItems = document.querySelectorAll('aside nav button').length;
    out.hasPageTitle = Boolean(document.querySelector('h1'));
    out.pageTitle = out.hasPageTitle ? document.querySelector('h1').textContent : null;
    return out;
  })()`;

  const result = (await win.webContents.executeJavaScript(script, true)) as Record<string, unknown>;
  const failures: string[] = [];
  if (result.requireType !== 'undefined') failures.push('renderer 暴露了 require');
  if (result.processType !== 'undefined') failures.push('renderer 暴露了 process');
  if (result.skpType !== 'object') failures.push('preload 未注入 window.skp');
  if (result.infoOk !== true) failures.push('app:info 调用失败');
  if (result.pingOk !== true) failures.push('app:ping 调用失败');
  if (result.initialStateOk !== true) failures.push('app:getInitialState 调用失败');
  if (result.badRequestCode !== 'BAD_REQUEST') failures.push(`参数校验未生效：${String(result.badRequestCode)}`);
  if (result.placeholderCode !== 'NOT_IMPLEMENTED') failures.push(`占位通道未拒绝：${String(result.placeholderCode)}`);
  if (result.unknownChannel !== 'BLOCKED') failures.push(`未知通道未被拦截：${String(result.unknownChannel)}`);
  if (Number(result.rootChildren) < 1) failures.push('渲染层未挂载');
  if (result.hasPageTitle !== true) failures.push('页面标题未渲染');
  if (requireShell) {
    if (Number(result.navItems) < 5) failures.push(`侧栏导航项不足：${String(result.navItems)}`);
  }

  logger.info('ipc:check', { result, failures, requireShell });
  if (failures.length > 0) {
    logger.error('ipc:check:failed', { failures });
    return false;
  }
  return true;
}

/** 创建业务上下文：库路径取本机配置优先，其次环境默认值。 */
function createAppContext(): AppContext {
  const resolved = resolveProductionPaths();
  // home 与 adapter 清单都来自 .env.<mode>：home 决定目录树根，ADAPTERS 决定本次加载哪几个 adapter
  const homeDir = resolved.HOME_DIR || os.homedir();
  const adapters = selectBuiltinAgents(resolved.ADAPTERS);
  const stored = readAppState(path.join(resolved.DATA_DIR, 'app-state.json'));
  const libraryDir = stored.libraryPath ?? resolved.LIBRARY_ROOT;
  const ctx = AppContext.create({
    libraryDir,
    dataDir: resolved.DATA_DIR,
    tempDir: resolved.TEMP_DIR,
    homeDir,
    softDir: resolved.SOFT_DIR,
    adapters,
    appEnv: resolved.APP_ENV,
    version: app.getVersion(),
    logger,
  });
  ctx.startWatching();
  return ctx;
}

app.whenReady().then(async () => {
  // 单实例锁被占（second instance）：app.quit() 已在途，不再初始化任何服务
  if (!hasSingleInstanceLock) return;

  // CLI 随应用发布到 home 固定根 <HOME_DIR>/.skills-studio/bin（tec.md §5.14）：
  // agent 与脚本按该固定路径寻址（skills-studio skill 的 BRIDGE_BROKEN 分支引导用户重开应用重发）。
  // 同版本快速跳过；发布失败仅记日志，不阻断 GUI。
  const resolvedForCli = resolveProductionPaths();
  const cliTarget = defaultCliPublishDir(resolvedForCli.HOME_DIR);
  try {
    const published = publishCli({ targetDir: cliTarget, installRoot: resolvedForCli.SOFT_DIR, mode, envFile: selectedEnvFile });
    logger.info('cli:publish', {
      targetDir: published.targetDir,
      version: published.version,
      changed: published.changed,
    });
  } catch (err) {
    logger.info('cli:publish-failed', { targetDir: cliTarget, error: String(err) });
  }

  // T15 截图：先起本地假模型服务，种子里的供应商 Endpoint 指向它
  if (screenshotMode && scenario === 't15') {
    try {
      await ensureT15FakeModel();
    } catch (err) {
      logger.error('t15:fake-model-failed', { error: String(err) });
      app.exit(1);
      return;
    }
  }
  try {
    context = createAppContext();
    logger.info('context:ready', {
      libraryDir: context.libraryDir,
      dataDir: context.dataDir,
      homeDir: resolveProductionPaths().HOME_DIR || '<home>',
      adapters: selectBuiltinAgents(resolveProductionPaths().ADAPTERS).map((def) => def.id),
      firstRunCompleted: context.state.firstRunCompleted,
    });
  } catch (err) {
    logger.error('context:init-failed', { error: String(err) });
    app.exit(1);
    return;
  }

  // 应用自更新：只在打包后的生产环境且安装包携带更新配置（resources/app-update.yml，
  // 由 electron-builder 的 publish 配置生成）时启用；其余环境渲染层拿到 unsupported
  // 快照，不提供检查入口。状态变化经 update:event 推给渲染层。
  let updates: AppUpdateControls | undefined;
  const updateConfigYml = path.join(process.resourcesPath, 'app-update.yml');
  if (app.isPackaged && mode === 'production' && fs.existsSync(updateConfigYml)) {
    try {
      const { autoUpdater } = await import('electron-updater');
      updates = createAppUpdateService({
        events: autoUpdater,
        checkForUpdates: () => autoUpdater.checkForUpdates(),
        installNow: () => autoUpdater.quitAndInstall(),
        currentVersion: app.getVersion(),
        logger,
        onState: (state) => {
          if (win && !win.isDestroyed()) win.webContents.send(UPDATE_EVENT_CHANNEL, state);
        },
      });
      logger.info('update:init', { currentVersion: app.getVersion() });
    } catch (err) {
      logger.error('update:init-failed', { error: String(err) });
    }
  }

  // 受控 IPC：白名单契约 + 参数校验 + 来源校验（backend/src/ipc/router.ts）
  registerIpcRouter({    logger,
    isTrustedSender,
    handlers: createIpcHandlers({
      context,
      appInfo,
      version: app.getVersion(),
      mode: env.APP_ENV,
      updates,
      pickDirectory: async (opts) => {
        if (!win) return null;
        // T12 自动截图：系统对话框无法脚本化，按固定夹具回放（仅 screenshot 场景）
        if (screenshotMode && scenario === 't12') return T12_LOCAL_DIR;
        const result = await dialog.showOpenDialog(win, {
          title: opts.title ?? '选择目录',
          defaultPath: opts.defaultPath,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
      },
      pickFile: async (opts) => {
        if (!win) return null;
        // T12 自动截图：同上，返回预置 zip
        if (screenshotMode && scenario === 't12') return T12_ZIP;
        const result = await dialog.showOpenDialog(win, {
          title: opts.title ?? '选择压缩包',
          defaultPath: opts.defaultPath,
          properties: ['openFile'],
          filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
      },
      installAllowedPaths:
        screenshotMode && scenario === 't12' ? [T12_LOCAL_DIR, T12_ZIP] : undefined,
      openPath: (target) => shell.openPath(target),
      // T09 外壳截图需要侧栏：只影响 getInitialState 的返回值，不写状态
      firstRunOverride: screenshotMode && scenario === 't09' ? true : undefined,
      logger,
    }),
  });

  // T15：对话事件桥（主进程 → 渲染层单向推送）。
  // 只转发 AgentEvent 的既有类型；preload 再做一次白名单过滤。
  context.conversations.subscribeAll((event) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(CONVERSATION_EVENT_CHANNEL, event as ConversationEvent);
  });
  // 改进运行产生的 content-changed 也通知一次（渲染层据此刷新文件与库状态）
  context.workflows.subscribe((event) => {
    if (!win || win.isDestroyed()) return;
    logger.info('workflow:event', event);
  });

  // 隐藏默认菜单（T09：桌面工作台不暴露 Electron 默认菜单）
  Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    // 烟测/截图均为自动验证路径：烟测隐藏；截图需真实可见才能 capturePage
    show: false,
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    title: PRODUCT_NAME,
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // preload 通过 CommonJS require 引用共享契约模块（单一来源），
      // 渲染层仍无 Node 能力；沙箱关闭仅影响 preload 自身。
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.on('closed', () => {
    win = null;
  });

  const frontendIndex = path.join(PROJECT_ROOT, 'frontend', 'dist', 'index.html');
  const frontendBuilt = fs.existsSync(frontendIndex);
  const target = frontendBuilt ? frontendIndex : path.join(__dirname, 'placeholder.html');
  logger.info('window:load', { target, frontendBuilt, mode, smokeTest, screenshotMode, scenario });

  // 烟测兜底：30 秒未完成加载即失败退出，避免悬挂
  const guard = setTimeout(() => {
    logger.error('smoke:timeout', { code: 1 });
    app.exit(1);
  }, 30_000);
  if (!smokeTest) clearTimeout(guard);

  win
    .loadFile(target)
    .then(async () => {
      clearTimeout(guard);
      logger.info('window:did-finish-load', { url: win!.webContents.getURL() });

      if (smokeTest) {
        // 给渲染层 IPC 一点时间，随后正常退出
        setTimeout(() => {
          logger.info('smoke:exit', { code: 0, mode });
          app.exit(0);
        }, 1500);
        return;
      }

      win!.show();
      const [contentWidth, contentHeight] = win!.getContentSize();
      const [minWidth, minHeight] = win!.getMinimumSize();
      logger.info('window:shown', {
        width: contentWidth,
        height: contentHeight,
        minWidth,
        minHeight,
        title: win!.getTitle(),
        menuVisible: win!.isMenuBarVisible(),
      });

      if (screenshotMode) {
        const dir = resolveScreenshotDir();
        if (!dir) {
          app.exit(1);
          return;
        }
        try {
          const ipcOk = await runIpcSelfCheck(scenario === 't09');
          if (!ipcOk) {
            app.exit(1);
            return;
          }
          await captureRoutes(dir);
          app.exit(0);
        } catch (err) {
          logger.error('screenshot:failed', { error: String(err) });
          app.exit(1);
        }
      }
    })
    .catch((err) => {
      clearTimeout(guard);
      logger.error('window:load-failed', { error: String(err) });
      app.exit(1);
    });
});

app.on('window-all-closed', () => {
  context?.dispose();
  context = null;
  if (t15FakeModel) {
    t15FakeModel.close();
    t15FakeModel = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

// 未捕获异常统一记录，避免主进程静默消失
process.on('uncaughtException', (err) => {
  logger.error('process:uncaught-exception', { error: String(err) });
});
