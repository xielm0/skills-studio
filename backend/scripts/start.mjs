import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

// 宿主环境若是 Electron 应用（WorkBuddy、VS Code 集成终端等），会向子进程泄漏
// ELECTRON_RUN_AS_NODE=1，使 electron.exe 退化为纯 Node 运行（require('electron')
// 变成路径字符串、app 为 undefined）。启动前必须剥离。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// 环境由 src/config.json 的 CURRENT_ENV 选择；源码可传 --env=development|uat|production 临时覆盖。
const r = spawnSync('electron', ['.', ...args], { stdio: 'inherit', shell: true, env });
process.exit(r.status ?? 1);
