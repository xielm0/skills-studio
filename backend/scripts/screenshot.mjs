/**
 * 自动验证截图（真实 Electron 窗口 capturePage）。
 *
 * 用法（在 backend/ 下）：
 *   node scripts/screenshot.mjs                      # T09 外壳 9 张（默认行为不变）
 *   node scripts/screenshot.mjs --scenario=t10       # T10 首启/主页/设置 5 张（独立种子）
 *   node scripts/screenshot.mjs --scenario=t11       # T11 中心库/详情 10 张（独立种子）
 *
 * 前置：cd frontend && npm run build；cd backend && npm run build
 * 产物：PNG 落在 tests/runtime 内（隔离纪律），主进程日志打印每张路径/尺寸/字节数。
 *
 * T10 种子方案：
 *  - tests/runtime/t10-shot/first-run：空库 + app-state.firstRunCompleted=false
 *    + 模拟 Agent 目录中的本机技能（供首启扫描）；
 *  - tests/runtime/t10-shot/main：5 个技能（其中 2 个已部署到模拟 Agent）+ 动态时间错开
 *    + 2 个供应商（视觉状态），firstRunCompleted=true。
 * 两次 Electron 进程分别用 --runtime/--scenario 指向各自种子，互不污染 dev 库。
 */
import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME_ROOT = path.join(PROJECT_ROOT, 'tests', 'runtime');
/** 开发环境目录（t09 只读复制成 tests/runtime/t09-shot 快照后运行，不写 dev） */
const DEV_ROOT = path.join(PROJECT_ROOT, 'tests', 'dev');

/** adapter 清单与后端同源（种子目录、部署目标都按它推导） */
const { selectBuiltinAgents } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'agents.js')).href
);

const scenarioArg = process.argv.find((arg) => arg.startsWith('--scenario='));
const scenario = scenarioArg ? scenarioArg.slice('--scenario='.length) : 't09';
const outArg = process.argv.find((arg) => arg.startsWith('--out='));
const defaultOut =
  scenario === 't10'
    ? path.join('tests', 'runtime', 'screenshots', 't10')
    : scenario === 't11'
      ? path.join('tests', 'runtime', 'screenshots', 't11')
      : scenario === 't12'
        ? path.join('tests', 'runtime', 'screenshots', 't12')
        : scenario === 't13'
          ? path.join('tests', 'runtime', 'screenshots', 't13')
          : scenario === 't14'
            ? path.join('tests', 'runtime', 'screenshots', 't14')
            : scenario === 't15'
              ? path.join('tests', 'runtime', 'screenshots', 't15')
              : path.join('tests', 'runtime', 'screenshots', 't09');
const outDir = path.resolve(PROJECT_ROOT, outArg ? outArg.slice('--out='.length) : defaultOut);

if (!outDir.startsWith(RUNTIME_ROOT)) {
  console.error(`[screenshot] 拒绝写入 tests/runtime 之外的目录: ${outDir}`);
  process.exit(1);
}

const mainJs = path.join(BACKEND, 'dist', 'main.js');
const preloadJs = path.join(BACKEND, 'dist', 'preload.js');
const sharedJs = path.join(BACKEND, 'dist', 'shared', 'ipc.js');
const frontendIndex = path.join(PROJECT_ROOT, 'frontend', 'dist', 'index.html');

const missing = [mainJs, preloadJs, sharedJs, frontendIndex].filter((file) => !fs.existsSync(file));
if (missing.length > 0) {
  console.error('[screenshot] 缺少构建产物，请先执行 frontend/backend 构建：');
  for (const file of missing) console.error(`  - ${file}`);
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 宿主若为 Electron 应用会泄漏 ELECTRON_RUN_AS_NODE=1，必须剥离，否则 electron.exe 退化为 Node
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const electronBin = require('electron');

/** 跑一次 Electron 截图场景。 */
function runElectron(extraArgs) {
  const args = ['.', '--env=development', ...extraArgs];
  console.log(`[screenshot] ${electronBin} ${args.join(' ')}`);
  const started = Date.now();
  const r = spawnSync(electronBin, args, {
    cwd: BACKEND,
    stdio: 'inherit',
    shell: false,
    env: childEnv,
  });
  console.log(`[screenshot] pass exit=${r.status ?? 1} elapsed=${Date.now() - started}ms`);
  return r.status ?? 1;
}

// ────────────────────────── T10 种子 ──────────────────────────

const SHOT_ROOT = path.join(RUNTIME_ROOT, 't10-shot');

function writeSkill(dir, name, description, body = '') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  );
}

/**
 * 种子里的 Agent 名 → 相对 home 的目录。与后端清单同源（selectBuiltinAgents 取出后按 id 找），
 * 避免截图脚本里再写一份目录口径。
 */
const SEED_ADAPTERS = selectBuiltinAgents('claude_code,codex,cursor,codebuddy,windsurf,cline');
const seedAgentSkills = (home, id) => {
  const rel = { claude: 'claude_code', codex: 'codex', cursor: 'cursor', codebuddy: 'codebuddy', windsurf: 'windsurf', cline: 'cline' }[id] ?? id;
  const def = SEED_ADAPTERS.find((d) => d.id === rel);
  if (!def) throw new Error(`种子里的 Agent 不在清单内：${id}`);
  return path.join(home, def.skillsDirRel);
};

function freshRuntime(name, shotRoot = SHOT_ROOT) {
  const root = path.join(shotRoot, name);
  fs.rmSync(root, { recursive: true, force: true });
  const dirs = {
    root,
    lib: path.join(root, 'lib'),
    data: path.join(root, 'data'),
    tmp: path.join(root, 'tmp'),
    logs: path.join(root, 'logs'),
    agents: path.join(root, 'user'),
    src: path.join(root, 'seed-src'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

/** 首启种子：空库 + 模拟 Agent（3 个里面有本机技能，其余目录不存在）。 */
function seedFirstRun() {
  const dirs = freshRuntime('first-run');
  fs.writeFileSync(
    path.join(dirs.data, 'app-state.json'),
    `${JSON.stringify({ schemaVersion: 1, firstRunCompleted: false, libraryPath: null }, null, 2)}\n`,
    'utf8',
  );
  const claude = seedAgentSkills(dirs.agents, 'claude');
  const codex = seedAgentSkills(dirs.agents, 'codex');
  const cursor = seedAgentSkills(dirs.agents, 'cursor');
  writeSkill(path.join(claude, 'code-review'), 'code-review', '按清单审查改动并输出结构化评审结论', '审查流程');
  writeSkill(path.join(claude, 'doc-writer'), 'doc-writer', '把需求与实现整理成可维护的技术文档', '文档写作');
  writeSkill(path.join(codex, 'git-commit'), 'git-commit', '根据改动生成符合规范的提交信息', '提交信息');
  writeSkill(path.join(codex, 'test-planner'), 'test-planner', '从需求推导测试计划与用例清单', '测试计划');
  writeSkill(path.join(cursor, 'react-patterns'), 'react-patterns', 'React 组件拆分与状态管理约定', 'REACT 约定');
  console.log(`[screenshot] seed first-run -> ${dirs.root}`);
  return dirs;
}

/** 主页/设置种子：5 技能（2 已部署）+ 时间错开的动态 + 2 供应商。 */
async function seedMain() {
  const dirs = freshRuntime('main');
  const { AppContext } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'context.js')).href);
  const { AppStateService } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'app-state.js')).href);

  for (const agent of ['claude', 'codex', 'cursor', 'codebuddy', 'windsurf', 'cline']) {
    fs.mkdirSync(seedAgentSkills(dirs.agents, agent), { recursive: true });
  }

  const skills = [
    { name: 'code-review', description: '按清单审查改动并输出结构化评审结论' },
    { name: 'doc-writer', description: '把需求与实现整理成可维护的技术文档' },
    { name: 'git-commit', description: '根据改动生成符合规范的提交信息' },
    { name: 'react-patterns', description: 'React 组件拆分与状态管理约定' },
    { name: 'api-design', description: '接口命名、错误码与分页约定' },
  ];
  for (const skill of skills) writeSkill(path.join(dirs.src, skill.name), skill.name, skill.description, '示例内容');

  const ctx = AppContext.create({
    libraryDir: dirs.lib,
    dataDir: dirs.data,
    tempDir: dirs.tmp,
    homeDir: dirs.agents,
    adapters: SEED_ADAPTERS,
    appEnv: 'development',
    version: '0.1.0',
  });

  const imported = await ctx.sources.importSkills(ctx.sources.discoverFromLocalDir(dirs.src).items);
  const failed = imported.results.filter((r) => r.status !== 'imported');
  if (failed.length > 0) throw new Error(`种子导入失败：${JSON.stringify(failed)}`);

  const byName = new Map(ctx.library.listSkills().map((s) => [s.dirName, s.skillId]));
  const deployed = await ctx.deploy.syncToAgents(
    [byName.get('code-review'), byName.get('doc-writer')],
    ['claude_code', 'codex'],
  );
  // 2 个技能 × 2 个 Agent = 4 条链接（主页同步覆盖按「技能数」计为 2/5）
  if (deployed.summary.deployed !== 4 || deployed.summary.failed !== 0) {
    throw new Error(`种子部署异常：${JSON.stringify(deployed.summary)}`);
  }

  await ctx.library.rescan();
  const times = {
    'code-review': Date.now() - 6 * 60 * 1000,
    'doc-writer': Date.now() - 3 * 60 * 60 * 1000,
    'git-commit': Date.now() - 26 * 60 * 60 * 1000,
    'react-patterns': Date.now() - 2 * 24 * 60 * 60 * 1000,
    'api-design': Date.now() - 4 * 24 * 60 * 60 * 1000,
  };
  // 动态时间错开（同一技能的事件按顺序 +1s，保证「最新一条」是部署事件）
  const activityFile = path.join(dirs.data, 'activity.jsonl');
  const lines = fs.readFileSync(activityFile, 'utf8').split('\n').filter(Boolean);
  const byId = new Map(ctx.library.listSkills().map((s) => [s.skillId, s.dirName]));
  const counters = new Map();
  const rewritten = lines.map((line) => {
    const event = JSON.parse(line);
    const dirName = byId.get(event.skillId);
    const base = dirName ? times[dirName] : undefined;
    if (base == null) return line;
    const index = counters.get(event.skillId) ?? 0;
    counters.set(event.skillId, index + 1);
    event.occurredAt = new Date(base + index * 1000).toISOString();
    return JSON.stringify(event);
  });
  fs.writeFileSync(activityFile, `${rewritten.join('\n')}\n`, 'utf8');

  // 首启已完成（主页直接可见）
  new AppStateService(dirs.data).markFirstRunCompleted();

  // 两个供应商（单选生效）。为确保截图展示「Key 已配置」状态，
  // 仅在该一次性种子配置里写入 credentialConfigured=true，**不写入任何真实凭据**。
  // 模型清单同样只是种子：openai 挂两个（展示 chips 与生效态），anthropic 留空（展示空态）。
  const now = new Date().toISOString();
  const providerConfig = {
    schemaVersion: 1,
    activeProviderId: 'openai',
    activeModelId: 'gpt-5.4',
    providers: [
      {
        id: 'openai',
        preset: 'openai',
        name: 'OpenAI',
        apiFormat: 'openai-completions',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-5.4', 'gpt-5.4-mini'],
        requiresApiKey: true,
        credentialConfigured: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'anthropic',
        preset: 'anthropic',
        name: 'Anthropic',
        apiFormat: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        models: [],
        requiresApiKey: true,
        credentialConfigured: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  fs.writeFileSync(path.join(dirs.data, 'agent-providers.json'), `${JSON.stringify(providerConfig, null, 2)}\n`, 'utf8');

  ctx.dispose();
  console.log(`[screenshot] seed main -> ${dirs.root} skills=${byName.size} links=${deployed.summary.deployed}`);
  return dirs;
}

// ────────────────────────── T11 种子 ──────────────────────────

const T11_SHOT_ROOT = path.join(RUNTIME_ROOT, 't11-shot');

/** 72 文件技能（SKILL.md + references 40 + scripts 20 + assets 11）。 */
function writeBigSkill(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: big-skill\ndescription: 72 文件规模的浏览/编辑样本，含 references、scripts 与 assets\n---\n\n# Big Skill\n\n用于验证完整文件树与多标签编辑。\n',
    'utf8',
  );
  for (let i = 1; i <= 40; i++) {
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, `references/file-${String(i).padStart(2, '0')}.md`),
      `# reference ${i}\n\n参考内容行 1\n参考内容行 2\n`,
      'utf8',
    );
  }
  for (let i = 1; i <= 20; i++) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, `scripts/file-${String(i).padStart(2, '0')}.py`),
      `# script ${i}\nprint("script ${i}")\n`,
      'utf8',
    );
  }
  for (let i = 1; i <= 11; i++) {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, `assets/file-${String(i).padStart(2, '0')}.txt`), `asset ${i} content\n`, 'utf8');
  }
}

/** 中心库种子：多 Group、多来源、已部署、1 个报告、1 个 72 文件技能、可重新导入的来源改动。 */
async function seedCatalog() {
  const dirs = freshRuntime('main', T11_SHOT_ROOT);
  const { AppContext } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'context.js')).href);
  const { AppStateService } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'app-state.js')).href);

  // plain 目录名与 Agent ID 不同（claude-code → claude），与 defaultSkillsDirFor(..., 'plain') 一致
  for (const agent of ['claude', 'codex', 'cursor', 'windsurf']) {
    fs.mkdirSync(seedAgentSkills(dirs.agents, agent), { recursive: true });
  }

  writeBigSkill(path.join(dirs.src, 'big-skill'));
  const skills = [
    { name: 'api-design', description: '接口命名、错误码与分页约定', body: '接口约定' },
    { name: 'code-review', description: '按清单审查改动并输出结构化评审结论', body: '审查流程' },
    { name: 'doc-writer', description: '把需求与实现整理成可维护的技术文档', body: '文档写作' },
    { name: 'git-commit', description: '根据改动生成符合规范的提交信息', body: '提交信息' },
    { name: 'react-patterns', description: 'React 组件拆分与状态管理约定', body: '组件约定' },
  ];
  for (const skill of skills) writeSkill(path.join(dirs.src, skill.name), skill.name, skill.description, skill.body);

  const ctx = AppContext.create({
    libraryDir: dirs.lib,
    dataDir: dirs.data,
    tempDir: dirs.tmp,
    homeDir: dirs.agents,
    adapters: SEED_ADAPTERS,
    appEnv: 'development',
    version: '0.1.0',
  });

  const imported = await ctx.sources.importSkills(ctx.sources.discoverFromLocalDir(dirs.src).items);
  const failed = imported.results.filter((r) => r.status !== 'imported');
  if (failed.length > 0) throw new Error(`种子导入失败：${JSON.stringify(failed)}`);

  const byName = new Map(ctx.library.listSkills().map((s) => [s.dirName, s.skillId]));

  const groups = {
    'code-review': ['写作', '日常'],
    'doc-writer': ['写作'],
    'git-commit': ['开发'],
    'api-design': ['开发', '常用'],
    'react-patterns': ['前端', '常用'],
  };
  for (const [dirName, list] of Object.entries(groups)) {
    await ctx.catalog.setGroups(byName.get(dirName), { add: list });
  }

  const deployed = await ctx.deploy.syncToAgents(
    [byName.get('code-review'), byName.get('api-design')],
    ['claude_code', 'codex'],
  );
  if (deployed.summary.failed !== 0 || deployed.summary.deployed !== 4) {
    throw new Error(`种子部署异常：${JSON.stringify(deployed.summary)}`);
  }
  const deployedBig = await ctx.deploy.syncToAgents([byName.get('big-skill')], ['cursor']);
  if (deployedBig.summary.deployed !== 1) {
    throw new Error(`种子部署异常（big-skill）：${JSON.stringify(deployedBig.summary)}`);
  }

  // 评测报告：仅 big-skill 有（菜单显示「评测查看」；其余技能不显示）
  fs.mkdirSync(path.join(dirs.lib, 'reports'), { recursive: true });
  fs.writeFileSync(
    path.join(dirs.lib, 'reports', `${byName.get('big-skill')}.md`),
    '# 评测结果 · big-skill\n\n总评：结构完整，触发描述清晰。\n\n## 逐项检查\n- frontmatter：通过\n- 文件组织：references / scripts / assets 分层合理\n- 可执行步骤：需要补充失败回退说明\n\n## 结论\n建议改进：在「执行步骤」中补充异常处理。\n',
    'utf8',
  );

  // 来源侧改动（重新导入差异弹层：changed）
  writeSkill(
    path.join(dirs.src, 'doc-writer'),
    'doc-writer',
    '把需求与实现整理成可维护的技术文档',
    '来源侧新增：文档模板与检查清单',
  );

  // 本地供应商（无需 Key），保证行菜单「编辑 / 评测」可创建预填会话
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dirs.data, 'agent-providers.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        activeProviderId: 'ollama',
        activeModelId: 'llama3:8b',
        providers: [
          {
            id: 'ollama',
            preset: 'ollama',
            name: '本地 Ollama',
            apiFormat: 'openai-completions',
            baseUrl: 'http://127.0.0.1:11434/v1',
            models: ['llama3:8b'],
            requiresApiKey: false,
            credentialConfigured: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  new AppStateService(dirs.data).markFirstRunCompleted();
  ctx.dispose();
  console.log(
    `[screenshot] seed t11 -> ${dirs.root} skills=${byName.size} groups=${Object.keys(groups).length} links=${deployed.summary.deployed + deployedBig.summary.deployed}`,
  );
  return dirs;
}

// ────────────────────────── T12 种子 ──────────────────────────

const T12_SHOT_ROOT = path.join(RUNTIME_ROOT, 't12-shot');

/** 安装页种子：市场缓存（离线）+ 本地/Git/zip 夹具 + 模拟 Agent + 已入库基线。 */
async function seedInstall() {
  const dirs = freshRuntime('main', T12_SHOT_ROOT);
  const assets = path.join(T12_SHOT_ROOT, 'assets');
  fs.rmSync(assets, { recursive: true, force: true });

  const localSrc = path.join(assets, 'local-src');
  const zipSrc = path.join(assets, 'zip-src');
  const repoWork = path.join(assets, 'git-work');
  const repoBare = path.join(assets, 'repo.git');
  const libSeed = path.join(dirs.root, 'seed-src');
  for (const dir of [localSrc, zipSrc, libSeed]) fs.mkdirSync(dir, { recursive: true });

  // ── 模拟 Agent 目录：2 个新技能 + 1 个同名同内容（跳过）+ 1 个同名异内容（失败）──
  writeSkill(path.join(seedAgentSkills(dirs.agents, 'claude'), 'review-helper'), 'review-helper', '按清单审查代码改动，输出结构化评审结论', '审查流程');
  writeSkill(path.join(seedAgentSkills(dirs.agents, 'claude'), 'legacy-skill'), 'legacy-skill', '库内已有同内容技能（应跳过）', 'legacy body');
  writeSkill(path.join(seedAgentSkills(dirs.agents, 'codex'), 'doc-writer'), 'doc-writer', '把需求与实现整理成可维护的技术文档', '文档写作');
  writeSkill(path.join(seedAgentSkills(dirs.agents, 'codex'), 'conflict-skill'), 'conflict-skill', '同名异内容（应失败）', 'agent v2');
  for (const agent of ['cursor', 'codebuddy', 'windsurf', 'cline']) {
    fs.mkdirSync(seedAgentSkills(dirs.agents, agent), { recursive: true });
  }

  // ── 已入库基线：legacy-skill（同内容）/ conflict-skill（异内容）──
  writeSkill(path.join(libSeed, 'legacy-skill'), 'legacy-skill', '库内已有同内容技能（应跳过）', 'legacy body');
  writeSkill(path.join(libSeed, 'conflict-skill'), 'conflict-skill', '同名异内容（应失败）', 'library v1');
  writeSkill(path.join(libSeed, 'local-conflict'), 'local-conflict', '本地目录同名冲突基线', 'library version');

  // ── 本地目录：3 个技能 + 1 个非技能目录（用于展示无效项）──
  writeSkill(path.join(localSrc, 'local-alpha'), 'local-alpha', '本地目录批量导入样本 A（含脚本）', 'alpha body');
  fs.mkdirSync(path.join(localSrc, 'local-alpha', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(localSrc, 'local-alpha', 'scripts', 'run.py'), 'print("alpha")\n', 'utf8');
  writeSkill(path.join(localSrc, 'local-beta'), 'local-beta', '本地目录批量导入样本 B', 'beta body');
  writeSkill(path.join(localSrc, 'local-conflict'), 'local-conflict', '本地目录同名冲突来源', 'source version');
  fs.mkdirSync(path.join(localSrc, 'notes-only'), { recursive: true });
  fs.writeFileSync(path.join(localSrc, 'notes-only', 'README.md'), 'no SKILL.md\n', 'utf8');

  // ── 压缩包：2 个技能 ──
  writeSkill(path.join(zipSrc, 'zip-one'), 'zip-one', '压缩包来源技能 A', 'zip a');
  writeSkill(path.join(zipSrc, 'zip-two'), 'zip-two', '压缩包来源技能 B', 'zip b');
  const zip = new AdmZip();
  zip.addLocalFolder(zipSrc);
  zip.writeZip(path.join(assets, 'skills.zip'));

  // ── Git：隔离 bare 仓库（截图时从地址栏解析）──
  execFileSync('git', ['init', '-b', 'main', repoWork], { stdio: 'pipe' });
  writeSkill(path.join(repoWork, 'git-skill-a'), 'git-skill-a', 'Git 来源技能 A（含脚本）', 'git a');
  fs.mkdirSync(path.join(repoWork, 'git-skill-a', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repoWork, 'git-skill-a', 'scripts', 'build.sh'), 'echo build\n', 'utf8');
  writeSkill(path.join(repoWork, 'git-skill-b'), 'git-skill-b', 'Git 来源技能 B', 'git b');
  execFileSync('git', ['add', '-A'], { cwd: repoWork, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=t12', '-c', 'user.email=t12@test.local', 'commit', '-m', 't12 shot'], {
    cwd: repoWork,
    stdio: 'pipe',
  });
  execFileSync('git', ['init', '--bare', '-b', 'main', repoBare], { stdio: 'pipe' });
  execFileSync('git', ['push', repoBare, 'main'], { cwd: repoWork, stdio: 'pipe' });

  // ── 业务上下文：预置基线技能，写首启完成标记 ──
  const { AppContext } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'context.js')).href);
  const { AppStateService } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'app-state.js')).href);
  const { MarketCache } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href);

  const ctx = AppContext.create({
    libraryDir: dirs.lib,
    dataDir: dirs.data,
    tempDir: dirs.tmp,
    homeDir: dirs.agents,
    adapters: SEED_ADAPTERS,
    appEnv: 'development',
    version: '0.1.0',
  });
  const pre = await ctx.sources.importSkills(ctx.sources.discoverFromLocalDir(libSeed).items);
  const failed = pre.results.filter((r) => r.status !== 'imported');
  if (failed.length > 0) throw new Error(`T12 种子导入失败：${JSON.stringify(failed)}`);
  const seedSkillCount = ctx.library.listSkills().length;
  ctx.dispose();

  // ── 市场缓存：榜单/搜索/详情全部离线（截图不打真实网络）──
  const marketItem = (source, skillId, name, installs, description) => ({
    id: `${source}/${skillId}`,
    source,
    skillId,
    name,
    installs,
    upstreamUrl: `https://www.skills.sh/${source}/${skillId}`,
    description,
  });
  const leaderboard = [
    marketItem('anthropics/skills', 'pdf', 'pdf', 216618, '读写、拆分与填写 PDF：表单识别、图片提取与字段校验'),
    marketItem('vercel-labs/skills', 'find-skills', 'find-skills', 4035993, '从技能市场检索并推荐可用的 Skills'),
    marketItem('anthropics/skills', 'docx', 'docx', 182340, '创建与编辑 Word 文档，保留样式与目录结构'),
    marketItem('anthropics/skills', 'xlsx', 'xlsx', 176512, '生成、清洗和分析电子表格数据'),
    marketItem('anthropics/skills', 'pptx', 'pptx', 131208, '按大纲生成结构清晰的演示文稿'),
    marketItem('anthropics/skills', 'skill-creator', 'skill-creator', 98220, '按规范创建新的 Skill 目录与 SKILL.md'),
  ];
  const searchItems = [
    marketItem('anthropics/skills', 'pdf', 'pdf', 216618, '读写、拆分与填写 PDF：表单识别、图片提取与字段校验'),
    marketItem('acme/pdf-tools', 'pdf-tools', 'pdf-tools', 18200, 'PDF 页面合并、压缩与元数据清理'),
    marketItem('acme/ocr', 'ocr-pdf', 'ocr-pdf', 9600, '扫描件 PDF 的 OCR 文本提取'),
  ];

  const cache = new MarketCache(path.join(dirs.data, 'market-cache'));
  cache.write('leaderboard-all-time', leaderboard);
  cache.write('search-pdf-60', searchItems);

  const files = [
    { path: 'SKILL.md', size: 1620 },
    { path: 'scripts/convert_pdf_to_images.py', size: 4312 },
    { path: 'scripts/check_bounding_boxes.py', size: 2088 },
    { path: 'references/pdf-reference.md', size: 8024 },
    { path: 'LICENSE.txt', size: 1103 },
  ];
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  cache.write('detail-anthropics/skills-pdf', {
    item: leaderboard[0],
    description: leaderboard[0].description,
    skillName: 'pdf',
    files,
    fileCount: files.length,
    totalBytes,
    executableScripts: ['scripts/check_bounding_boxes.py', 'scripts/convert_pdf_to_images.py'],
    repoPath: 'skills/pdf',
    fetchedAt: new Date().toISOString(),
    fromCache: false,
    stale: false,
  });

  new AppStateService(dirs.data).markFirstRunCompleted();
  console.log(`[screenshot] seed t12 -> ${dirs.root} skills=${seedSkillCount} assets=${assets}`);
  return dirs;
}

// ────────────────────────── T13 种子 ──────────────────────────

const T13_SHOT_ROOT = path.join(RUNTIME_ROOT, 't13-shot');

/**
 * Agents 页种子：3 个已检测 Agent（Claude Code / Codex / Cursor）。
 * - claude：code-review 绿灯链接 + agent-alpha 灰灯（可入库）+ conflict-skill 灰灯（同名异内容冲突）
 * - codex：doc-writer 绿灯链接 + agent-beta 灰灯（交互自检入库）
 * - cursor：空目录（空态截图）
 */
async function seedAgents() {
  const dirs = freshRuntime('main', T13_SHOT_ROOT);
  for (const agent of ['claude', 'codex', 'cursor']) {
    fs.mkdirSync(seedAgentSkills(dirs.agents, agent), { recursive: true });
  }

  // 中心库基线
  writeSkill(path.join(dirs.src, 'code-review'), 'code-review', '按清单审查改动并输出结构化评审结论', '审查流程');
  writeSkill(path.join(dirs.src, 'doc-writer'), 'doc-writer', '把需求与实现整理成可维护的技术文档', '文档写作');
  writeSkill(path.join(dirs.src, 'conflict-skill'), 'conflict-skill', '库内版本 v1（同名异内容冲突基线）', 'library v1');

  // Agent 实际目录：灰灯技能（未入库）
  writeSkill(
    path.join(seedAgentSkills(dirs.agents, 'claude'), 'agent-alpha'),
    'agent-alpha',
    'Claude 目录中的未入库技能，点击入库后变绿',
    'agent alpha body',
  );
  fs.mkdirSync(path.join(seedAgentSkills(dirs.agents, 'claude'), 'agent-alpha', 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(seedAgentSkills(dirs.agents, 'claude'), 'agent-alpha', 'references', 'guide.md'),
    '# guide\n\nAgent 原文件参考内容\n',
    'utf8',
  );
  writeSkill(
    path.join(seedAgentSkills(dirs.agents, 'claude'), 'conflict-skill'),
    'conflict-skill',
    'Agent 版本 v2（与库内 v1 内容不同）',
    'agent v2',
  );
  fs.mkdirSync(path.join(seedAgentSkills(dirs.agents, 'claude'), 'conflict-skill', 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(seedAgentSkills(dirs.agents, 'claude'), 'conflict-skill', 'references', 'notes.md'),
    '# notes\n\n冲突技能也能正常浏览文件树\n',
    'utf8',
  );
  fs.writeFileSync(path.join(seedAgentSkills(dirs.agents, 'claude'), 'README.md'), 'not a skill\n', 'utf8');
  writeSkill(
    path.join(seedAgentSkills(dirs.agents, 'codex'), 'agent-beta'),
    'agent-beta',
    'Codex 目录中的未入库技能（交互自检用）',
    'agent beta body',
  );

  const { AppContext } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'context.js')).href);
  const { AppStateService } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'app-state.js')).href);

  const ctx = AppContext.create({
    libraryDir: dirs.lib,
    dataDir: dirs.data,
    tempDir: dirs.tmp,
    homeDir: dirs.agents,
    adapters: SEED_ADAPTERS,
    appEnv: 'development',
    version: '0.1.0',
  });
  const imported = await ctx.sources.importSkills(ctx.sources.discoverFromLocalDir(dirs.src).items);
  const failed = imported.results.filter((r) => r.status !== 'imported');
  if (failed.length > 0) throw new Error(`T13 种子导入失败：${JSON.stringify(failed)}`);
  const byName = new Map(ctx.library.listSkills().map((s) => [s.dirName, s.skillId]));
  const deployed = await ctx.deploy.syncToAgents([byName.get('code-review')], ['claude_code']);
  const deployedCodex = await ctx.deploy.syncToAgents([byName.get('doc-writer')], ['codex']);
  if (deployed.summary.deployed !== 1 || deployedCodex.summary.deployed !== 1) {
    throw new Error(`T13 种子部署异常：${JSON.stringify([deployed.summary, deployedCodex.summary])}`);
  }
  new AppStateService(dirs.data).markFirstRunCompleted();
  ctx.dispose();
  console.log(`[screenshot] seed t13 -> ${dirs.root} skills=${byName.size} links=2`);
  return dirs;
}

// ────────────────────────── T09 快照 / 市场缓存 ──────────────────────────

const T09_SHOT_ROOT = path.join(RUNTIME_ROOT, 't09-shot');

/** 快照内跳过：运行期自建、被占用或复制无意义的路径（相对 tests/dev） */
const T09_SKIP = new Set([
  path.join('appdata', 'electron-user-data'),
  path.join('appdata', 'locks'),
  path.join('appdata', 'index.db-shm'),
  // 库在 home 下，单独复制到快照的 lib/，避免 user/ 里出现第二份
  path.join('home', '.skills-studio', 'skills-library'),
  path.join('tmp'),
]);

/**
 * T09 只认快照：把 tests/dev 的 home / home/.skills-studio/skills-library / appdata 复制到
 * tests/runtime/t09-shot，截图期间的任何写入都落在快照里，开发环境保持只读。
 * 真实形态 = home（库在 home/.skills-studio/skills-library 下）+ appdata（应用私有数据）；快照布局仍是
 * 夹具约定的 user/ + lib/ + data/ 三件套（--runtime 覆盖的就这三个位置）。
 * 链接目标里的 DEV_ROOT 前缀改写成快照根，避免快照里的「已同步」仍指回 dev 库。
 */
function seedDevSnapshot() {
  fs.rmSync(T09_SHOT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(T09_SHOT_ROOT, { recursive: true });
  const DEV_HOME = path.join(DEV_ROOT, 'home');
  const DEV_APP_DATA = path.join(DEV_ROOT, 'appdata');
  const dataEntries = fs.existsSync(DEV_APP_DATA)
    ? fs.readdirSync(DEV_APP_DATA).filter((name) => !name.endsWith('-shm'))
    : [];
  const pairs = [
    [DEV_HOME, path.join(T09_SHOT_ROOT, 'user')],
    [path.join(DEV_HOME, '.skills-studio', 'skills-library'), path.join(T09_SHOT_ROOT, 'lib')],
    ...dataEntries.map((name) => [path.join(DEV_APP_DATA, name), path.join(T09_SHOT_ROOT, 'data', name)]),
  ];
  let files = 0;
  for (const [src, dest] of pairs) {
    if (!fs.existsSync(src)) continue;
    files += copyTree(src, dest, DEV_ROOT, T09_SHOT_ROOT);
  }
  rewriteIndexPath();
  fs.mkdirSync(path.join(T09_SHOT_ROOT, 'tmp'), { recursive: true });
  console.log(`[screenshot] seed dev snapshot -> ${T09_SHOT_ROOT} files=${files}`);
  return { root: T09_SHOT_ROOT };
}

/**
 * 索引库的 meta.library_path 记的是 dev 库绝对路径；不改写的话，
 * 快照启动会判定「换了库」并清空重扫（首屏 0 条，截图全停在空态）。
 * 改写失败（源库正被写导致拷贝不一致）就删掉索引，让快照自己重建。
 */
function rewriteIndexPath() {
  const dbFile = path.join(T09_SHOT_ROOT, 'data', 'index.db');
  if (!fs.existsSync(dbFile)) return;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile);
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      path.resolve(path.join(T09_SHOT_ROOT, 'lib')),
      'library_path',
    );
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (err) {
    console.warn(`[screenshot] 快照索引改写失败，改为重建：${err.code ?? err.message}`);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  }
}

/** 递归复制；符号链接按目标重写后重新创建（目录链接走 junction，免管理员权限）。 */
function copyTree(src, dest, fromRoot, toRoot) {
  const rel = path.relative(fromRoot, src);
  if (T09_SKIP.has(rel)) return 0;
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    const target = path.resolve(path.dirname(src), fs.readlinkSync(src));
    try {
      const isDir = fs.statSync(src).isDirectory();
      const rewritten = target.startsWith(fromRoot)
        ? path.join(toRoot, path.relative(fromRoot, target))
        : target;
      fs.symlinkSync(rewritten, dest, isDir ? 'junction' : 'file');
    } catch (err) {
      console.warn(`[screenshot] 快照跳过失效链接 ${rel}：${err.code ?? err.message}`);
      return 0;
    }
    return 1;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    let count = 0;
    for (const name of fs.readdirSync(src)) {
      count += copyTree(path.join(src, name), path.join(dest, name), fromRoot, toRoot);
    }
    return count;
  }
  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    console.warn(`[screenshot] 快照跳过（复制失败）${rel}：${err.code ?? err.message}`);
    return 0;
  }
  return 1;
}

/**
 * T09 会打开安装页（03-install）：预先写入榜单缓存，截图过程不访问真实网络
 * （否则窗口关闭时请求仍在进行，截图只能停在加载态）。只写快照，不写 dev。
 */
async function seedMarketCache(dataDir) {
  const { MarketCache } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href);
  const make = (source, skillId, name, installs, description) => ({
    id: `${source}/${skillId}`,
    source,
    skillId,
    name,
    installs,
    upstreamUrl: `https://www.skills.sh/${source}/${skillId}`,
    description,
  });
  const cache = new MarketCache(path.join(dataDir, 'market-cache'));
  cache.write('leaderboard-all-time', [
    make('anthropics/skills', 'pdf', 'pdf', 216618, '读写、拆分与填写 PDF：表单识别、图片提取与字段校验'),
    make('vercel-labs/skills', 'find-skills', 'find-skills', 4035993, '从技能市场检索并推荐可用的 Skills'),
    make('anthropics/skills', 'docx', 'docx', 182340, '创建与编辑 Word 文档，保留样式与目录结构'),
    make('anthropics/skills', 'xlsx', 'xlsx', 176512, '生成、清洗和分析电子表格数据'),
    make('anthropics/skills', 'pptx', 'pptx', 131208, '按大纲生成结构清晰的演示文稿'),
    make('anthropics/skills', 'skill-creator', 'skill-creator', 98220, '按规范创建新的 Skill 目录与 SKILL.md'),
  ]);
  console.log(`[screenshot] seed market cache -> ${path.join(dataDir, 'market-cache')}`);
}

// ────────────────────────── T14 种子 ──────────────────────────

const T14_SHOT_ROOT = path.join(RUNTIME_ROOT, 't14-shot');
const T14_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't14-fixture',
  GIT_AUTHOR_EMAIL: 't14@test.local',
  GIT_COMMITTER_NAME: 't14-fixture',
  GIT_COMMITTER_EMAIL: 't14@test.local',
};

/** 只改 SKILL.md 正文，保留 frontmatter（模拟应用内编辑）。 */
function editSkillBody(dir, body) {
  const file = path.join(dir, 'SKILL.md');
  const current = fs.readFileSync(file, 'utf8');
  const end = current.indexOf('\n---', 4);
  const head = end > 0 ? current.slice(0, end + 4) : current.split('\n').slice(0, 4).join('\n');
  fs.writeFileSync(file, `${head}\n\n${body}\n`, 'utf8');
}

function gitRun(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', env: T14_GIT_ENV }).toString().trim();
}

function initBareRemote(remote) {
  fs.rmSync(remote, { recursive: true, force: true });
  fs.mkdirSync(remote, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'pipe' });
}

/** 模拟「另一台机器」：克隆远端 → 改技能 → 提交并推送。 */
function remoteCommitFromOtherMachine(remote, workDir, message, edit) {
  fs.rmSync(workDir, { recursive: true, force: true });
  execFileSync('git', ['clone', remote, workDir], { stdio: 'pipe' });
  edit(workDir);
  gitRun(['add', '-A'], workDir);
  gitRun(['commit', '-m', message], workDir);
  gitRun(['push', 'origin', 'main'], workDir);
}

async function loadBackupDeps() {
  const { SkillLibraryService, SkillSourceService, BackupService } = await import(
    pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href
  );
  const { AppStateService } = await import(
    pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'app-state.js')).href
  );
  const { WriteLock } = await import(
    pathToFileURL(path.join(BACKEND, 'dist', 'infra', 'write-lock.js')).href
  );
  return { SkillLibraryService, SkillSourceService, BackupService, AppStateService, WriteLock };
}

/**
 * 种子专用装配：库、来源与备份共用同一个写锁（与主进程装配一致）。
 * 不能用两个锁实例——BackupService 持锁时会调用 library.rescan()，跨实例会互等超时。
 */
async function seedBackupStack(dirs, remote) {
  const { SkillLibraryService, SkillSourceService, BackupService, WriteLock } = await loadBackupDeps();
  const lock = new WriteLock();
  const library = SkillLibraryService.create({
    libraryDir: dirs.lib,
    dataDir: dirs.data,
    lock,
    logger: { info: () => undefined, error: () => undefined },
  });
  const sources = new SkillSourceService({ library, tempDir: dirs.tmp, lock });
  const backup = new BackupService({
    library,
    dataDir: dirs.data,
    lock,
    logger: { info: () => undefined, error: () => undefined },
  });
  const imported = await sources.importSkills(sources.discoverFromLocalDir(dirs.src).items);
  const failed = imported.results.filter((r) => r.status !== 'imported');
  if (failed.length > 0) throw new Error(`T14 种子导入失败：${JSON.stringify(failed)}`);
  await backup.init({ remoteUrl: remote });
  return { lock, library, sources, backup };
}

/**
 * T14-A 种子：
 *  - 本机库已有 3 个技能，并已在远端留下 2 个版本；
 *  - 连接前删掉远端配置（截图 1 = 未连接态），git 历史仍保留（截图 2 = 连接后看到历史）；
 *  - 远端（另一台机器）与本机同时改了 alpha / beta → 截图 3 的 Pull 冲突。
 */
async function seedBackupSyncA() {
  const dirs = freshRuntime('a', T14_SHOT_ROOT);
  const remote = path.join(T14_SHOT_ROOT, 'a', 'remote.git');
  initBareRemote(remote);

  for (const [name, description] of [
    ['alpha', '把会议记录整理成结构化纪要'],
    ['beta', '根据改动生成发布说明'],
    ['gamma', '检查文案的语气与术语一致性'],
  ]) {
    writeSkill(path.join(dirs.src, name), name, description, `${name} 初始版本`);
  }

  const { library, backup } = await seedBackupStack(dirs, remote);
  const first = await backup.push({ message: '首次备份技能库' });
  if (first.status !== 'pushed') throw new Error(`T14-A 首次 Push 失败：${first.status}`);

  editSkillBody(path.join(dirs.lib, 'skills', 'beta'), 'beta 第二版：补充发布说明模板');
  await library.rescan();
  const second = await backup.push({ message: '更新 beta 的发布说明模板' });
  if (second.status !== 'pushed') throw new Error(`T14-A 第二次 Push 失败：${second.status}`);

  // 另一台机器改了 alpha / beta / gamma 并推送
  remoteCommitFromOtherMachine(
    remote,
    path.join(T14_SHOT_ROOT, 'a', 'work-remote'),
    '另一台机器调整 alpha / beta / gamma',
    (work) => {
      editSkillBody(path.join(work, 'skills', 'alpha'), 'alpha 远端版本：增加待办清单');
      editSkillBody(path.join(work, 'skills', 'beta'), 'beta 远端版本：增加回滚章节');
      editSkillBody(path.join(work, 'skills', 'gamma'), 'gamma 远端版本：补充术语表');
    },
  );

  // 本机也改了 alpha / beta（未提交）→ Pull 时进入冲突待处理区
  editSkillBody(path.join(dirs.lib, 'skills', 'alpha'), 'alpha 本机版本：增加时间线');
  editSkillBody(path.join(dirs.lib, 'skills', 'beta'), 'beta 本机版本：增加已知问题');
  await library.rescan();

  // 截图 1 需要未连接态：移除远端配置（仓库与历史保留）
  fs.rmSync(path.join(dirs.data, 'backup-config.json'), { force: true });

  const { AppStateService } = await loadBackupDeps();
  new AppStateService(dirs.data).markFirstRunCompleted();
  library.close();
  console.log(`[screenshot] seed t14-a -> ${dirs.root} remote=${remote}`);
  return dirs;
}

/**
 * T14-B 种子：
 *  - 已连接远端并有 2 个版本；
 *  - 远端领先（另一台机器又推了一次），本机有未提交改动 → Push 被拒（截图 5）；
 *  - 版本历史可选中旧版本并弹出恢复确认（截图 6）。
 */
async function seedBackupSyncB() {
  const dirs = freshRuntime('b', T14_SHOT_ROOT);
  const remote = path.join(T14_SHOT_ROOT, 'b', 'remote.git');
  initBareRemote(remote);

  for (const [name, description] of [
    ['alpha', '把会议记录整理成结构化纪要'],
    ['beta', '根据改动生成发布说明'],
  ]) {
    writeSkill(path.join(dirs.src, name), name, description, `${name} 初始版本`);
  }

  const { library, backup } = await seedBackupStack(dirs, remote);
  const first = await backup.push({ message: '首次备份技能库' });
  if (first.status !== 'pushed') throw new Error(`T14-B 首次 Push 失败：${first.status}`);

  editSkillBody(path.join(dirs.lib, 'skills', 'beta'), 'beta 第二版：补充回滚步骤');
  await library.rescan();
  const second = await backup.push({ message: '更新 beta 的回滚步骤' });
  if (second.status !== 'pushed') throw new Error(`T14-B 第二次 Push 失败：${second.status}`);

  // 远端领先：另一台机器改了 beta 并推送
  remoteCommitFromOtherMachine(
    remote,
    path.join(T14_SHOT_ROOT, 'b', 'work-remote'),
    '另一台机器调整 beta',
    (work) => editSkillBody(path.join(work, 'skills', 'beta'), 'beta 远端版本：补充常见问题'),
  );

  // 本机未提交改动 → Push 会先形成本地提交，再因远端领先被拒
  editSkillBody(path.join(dirs.lib, 'skills', 'alpha'), 'alpha 本机版本：增加示例');
  await library.rescan();

  const { AppStateService } = await loadBackupDeps();
  new AppStateService(dirs.data).markFirstRunCompleted();
  library.close();
  console.log(`[screenshot] seed t14-b -> ${dirs.root} remote=${remote}`);
  return dirs;
}

// ────────────────────────── 执行 ──────────────────────────

function collectFiles() {
  return fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith('.png'))
    .sort();
}

function report(expectMin) {
  const files = collectFiles();
  for (const name of files) {
    const stat = fs.statSync(path.join(outDir, name));
    console.log(`[screenshot] ${name} ${stat.size} bytes`);
  }
  console.log(`[screenshot] dir=${outDir} files=${files.length}`);
  return files.length >= expectMin;
}

// ────────────────────────── T15 种子 ──────────────────────────

const T15_SHOT_ROOT = path.join(RUNTIME_ROOT, 't15-shot');

/** 写入一条演示会话（消息/运行/文件引用），用于「会话列表 / 报告打开」截图。 */
function seedSession(ctx, ConversationStore, input) {
  const created = ctx.conversations.createSession({
    authorizedDir: input.authorizedDir,
    title: input.title,
    workflow: input.workflow ?? null,
    toolPolicy: input.toolPolicy ?? 'read-write',
  });
  const store = ctx.conversations.store;
  const record = store.load(created.sessionId, { normalizeInterrupted: false });
  const startedAt = new Date(Date.now() - (input.minutesAgo ?? 10) * 60_000).toISOString();
  const endedAt = new Date(Date.parse(startedAt) + (input.durationMs ?? 3200)).toISOString();
  record.messages = input.messages.map((message) => {
    const base = ConversationStore.newMessage(message.role, message.text);
    return { ...base, at: new Date(Date.parse(startedAt) + (message.offsetMs ?? 0)).toISOString(), status: 'complete' };
  });
  record.runs = input.runs === false
    ? []
    : [
        ConversationStore.newRun({
          status: 'done',
          startedAt,
          endedAt,
          providerId: 'ollama',
          modelId: 'mock-model',
          error: null,
          usage: { input: 128, output: 64, cacheRead: 0, cacheWrite: 0, totalTokens: 192, cost: 0 },
          durationMs: input.durationMs ?? 3200,
        }),
      ];
  record.files = (input.files ?? []).map((relPath) => {
    const absolute = path.join(input.authorizedDir, relPath);
    return { relPath, path: absolute, bytes: fs.statSync(absolute).size, at: endedAt };
  });
  record.draftPrompt = null;
  record.status = 'done';
  store.save(record);
  // save 会把 updatedAt 刷成当前时间；夹具需要时间梯度时按 ageMinutes 回写
  if (input.ageMinutes) {
    const file = store.file(record.sessionId);
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    payload.updatedAt = new Date(Date.now() - input.ageMinutes * 60_000).toISOString();
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
  return created.sessionId;
}

/**
 * T15 种子：库内 3 个技能（其中 1 个有评测报告）+ 三条历史会话 + 指向本地假模型服务的供应商。
 * 供应商用 ollama 预设（不需要 Key），Endpoint 指向截图进程内的 127.0.0.1:18915。
 */
async function seedT15() {
  const dirs = freshRuntime('main', T15_SHOT_ROOT);
  const { AppContext } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'context.js')).href);
  const { AppStateService } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'app-state.js')).href);
  const { ConversationStore } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href);

  for (const agent of ['claude', 'codex']) fs.mkdirSync(seedAgentSkills(dirs.agents, agent), { recursive: true });

  const skills = [
    { name: 'code-review', description: '按清单审查改动并输出结构化评审结论', body: '审查流程' },
    { name: 'doc-writer', description: '把需求与实现整理成可维护的技术文档', body: '文档写作' },
    { name: 'meeting-notes', description: '把会议逐字稿整理成决议与待办', body: '会议纪要' },
  ];
  for (const skill of skills) writeSkill(path.join(dirs.src, skill.name), skill.name, skill.description, skill.body);

  const ctx = AppContext.create({
    libraryDir: dirs.lib,
    dataDir: dirs.data,
    tempDir: dirs.tmp,
    homeDir: dirs.agents,
    adapters: SEED_ADAPTERS,
    appEnv: 'development',
    version: '0.1.0',
  });
  const imported = await ctx.sources.importSkills(ctx.sources.discoverFromLocalDir(dirs.src).items);
  const failed = imported.results.filter((r) => r.status !== 'imported');
  if (failed.length > 0) throw new Error(`种子导入失败：${JSON.stringify(failed)}`);
  const byName = new Map(ctx.library.listSkills().map((s) => [s.dirName, s.skillId]));
  if (byName.size !== skills.length) throw new Error(`种子技能数不符：${byName.size}`);

  // 当前技能（code-review）已有评测报告 → 会话里以文本打开
  fs.mkdirSync(path.join(dirs.lib, 'reports'), { recursive: true });
  fs.writeFileSync(
    ctx.catalog.reportPath(byName.get('code-review')),
    [
      '# 评测结果 · code-review',
      '',
      '总评：结构清晰，触发描述明确；执行步骤可以更可执行。',
      '',
      '## 逐项检查',
      '- frontmatter：通过（name / description 均存在）',
      '- 触发描述：通过（覆盖「审查改动」「评审结论」两类意图）',
      '- 文件组织：通过（仅 SKILL.md，无冗余引用）',
      '- 可执行步骤：需改进（缺少失败回退与输出模板）',
      '',
      '## 问题清单',
      '1. 「审查流程」缺少输出格式示例。',
      '2. 未说明改动过大时的拆分策略。',
      '',
      '## 结论',
      '建议改进：补充输出模板与超量改动的分批评审说明。',
      '',
    ].join('\n'),
    'utf8',
  );

  // 本地模拟模型（截图进程内启动；零真实网络、零真实 Key）
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dirs.data, 'agent-providers.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        activeProviderId: 'ollama',
        activeModelId: 'mock-model',
        providers: [
          {
            id: 'ollama',
            preset: 'ollama',
            name: '本地模型服务',
            apiFormat: 'openai-completions',
            baseUrl: 'http://127.0.0.1:18915/v1',
            models: ['mock-model', 'mock-model-pro'],
            requiresApiKey: false,
            credentialConfigured: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // 历史会话（列表可滚动、当前会话可区分）
  seedSession(ctx, ConversationStore, {
    authorizedDir: path.join(dirs.lib, 'skills', 'code-review'),
    title: '评测 Skill：code-review',
    workflow: 'evaluate',
    toolPolicy: 'read-write',
    minutesAgo: 8,
    durationMs: 4200,
    messages: [
      {
        role: 'user',
        offsetMs: 0,
        text: '请按产品自带的「技能评测（skill-doctor）」流程，评测技能「code-review」。',
      },
      {
        role: 'assistant',
        offsetMs: 1200,
        text: '## 评测摘要\n\n已按 skill-doctor 完成逐项检查：\n\n- 结构完整\n- 触发描述清晰\n- 执行步骤建议补充输出模板\n\n完整报告已由应用保存到中心库。',
      },
    ],
  });
  seedSession(ctx, ConversationStore, {
    authorizedDir: path.join(dirs.lib, 'skills', 'doc-writer'),
    title: '优化 Skill：doc-writer',
    workflow: 'improve',
    minutesAgo: 36,
    ageMinutes: 11520,
    durationMs: 6800,
    messages: [
      { role: 'user', offsetMs: 0, text: '请按「技能优化」流程，诊断并优化技能「doc-writer」。' },
      {
        role: 'assistant',
        offsetMs: 2200,
        text: '已修改 SKILL.md：补充触发场景、输出结构与失败回退说明；改动清单见对话上方工具摘要。',
      },
    ],
  });
  seedSession(ctx, ConversationStore, {
    authorizedDir: path.join(dirs.lib, 'skills', 'meeting-notes'),
    title: '会议纪要格式怎么定？',
    workflow: null,
    minutesAgo: 120,
    ageMinutes: 93600,
    durationMs: 2400,
    messages: [
      { role: 'user', offsetMs: 0, text: '会议纪要格式怎么定？希望决议、待办、待确认分开。' },
      {
        role: 'assistant',
        offsetMs: 900,
        text: '建议按「议题 → 决议 → 待办（负责人 / 截止时间）→ 待确认」组织，并固定输出模板，便于后续检索。',
      },
    ],
  });

  const previewDir = path.join(dirs.lib, 'skills', 'meeting-notes');
  fs.writeFileSync(path.join(previewDir, 'preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'));
  const pdfObjects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 43 >>\nstream\nBT /F1 18 Tf 72 720 Td (PDF preview) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdfSource = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, body] of pdfObjects.entries()) {
    offsets.push(Buffer.byteLength(pdfSource));
    pdfSource += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdfSource);
  pdfSource += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdfSource += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdfSource += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(previewDir, 'preview.pdf'), pdfSource);
  fs.writeFileSync(path.join(previewDir, 'preview.yml'), 'name: meeting-notes\nversion: 1\nconfig:\n  enabled: true\n  steps:\n    - decision\n    - action\n', 'utf8');
  seedSession(ctx, ConversationStore, {
    authorizedDir: previewDir,
    title: '预览文件：图片与 PDF',
    workflow: null,
    minutesAgo: 180,
    files: ['preview.png', 'preview.pdf', 'preview.yml'],
    messages: [
      { role: 'user', text: '查看图片和 PDF。' },
      { role: 'assistant', text: '已生成图片、PDF 和 YAML 文件。' },
    ],
  });

  new AppStateService(dirs.data).markFirstRunCompleted();
  ctx.dispose();
  console.log(`[screenshot] seed t15 -> ${dirs.root} skills=${byName.size} sessions=4 model=${'mock-model'}`);
  return dirs;
}
async function main() {
  if (scenario === 't15') {
    const seed = await seedT15();
    const status = runElectron([
      '--scenario=t15',
      `--runtime=${path.relative(PROJECT_ROOT, seed.root)}`,
      `--screenshot=${outDir}`,
    ]);
    if (status !== 0) return 1;
    return report(14) ? 0 : 1;
  }
  if (scenario === 't13') {
    const seed = await seedAgents();
    const status = runElectron([
      '--scenario=t13',
      `--runtime=${path.relative(PROJECT_ROOT, seed.root)}`,
      `--screenshot=${outDir}`,
    ]);
    if (status !== 0) return 1;
    return report(5) ? 0 : 1;
  }

  if (scenario === 't14') {
    const a = await seedBackupSyncA();
    const statusA = runElectron([
      '--scenario=t14',
      `--runtime=${path.relative(PROJECT_ROOT, a.root)}`,
      `--screenshot=${outDir}`,
    ]);
    if (statusA !== 0) return 1;

    const b = await seedBackupSyncB();
    const statusB = runElectron([
      '--scenario=t14b',
      `--runtime=${path.relative(PROJECT_ROOT, b.root)}`,
      `--screenshot=${outDir}`,
    ]);
    if (statusB !== 0) return 1;

    return report(4) ? 0 : 1;
  }

  if (scenario === 't12') {
    const seed = await seedInstall();
    const status = runElectron([
      '--scenario=t12',
      `--runtime=${path.relative(PROJECT_ROOT, seed.root)}`,
      `--screenshot=${outDir}`,
    ]);
    if (status !== 0) return 1;
    return report(8) ? 0 : 1;
  }

  if (scenario === 't11') {
    const seed = await seedCatalog();
    const status = runElectron([
      `--scenario=t11`,
      `--runtime=${path.relative(PROJECT_ROOT, seed.root)}`,
      `--screenshot=${outDir}`,
    ]);
    if (status !== 0) return 1;
    return report(10) ? 0 : 1;
  }

  if (scenario === 't10') {
    const firstRun = seedFirstRun();
    const firstStatus = runElectron([
      `--scenario=first-run`,
      `--runtime=${path.relative(PROJECT_ROOT, firstRun.root)}`,
      `--screenshot=${outDir}`,
    ]);
    if (firstStatus !== 0) return 1;

    const mainSeed = await seedMain();
    const mainStatus = runElectron([
      `--scenario=main`,
      `--runtime=${path.relative(PROJECT_ROOT, mainSeed.root)}`,
      `--screenshot=${outDir}`,
    ]);
    if (mainStatus !== 0) return 1;

    return report(6) ? 0 : 1;
  }

  // T09：按开发数据做一份 tests/runtime 内的快照跑截图，开发环境只读
  const seed = seedDevSnapshot();
  await seedMarketCache(path.join(seed.root, 'data'));
  const status = runElectron([
    `--runtime=${path.relative(PROJECT_ROOT, seed.root)}`,
    `--screenshot=${outDir}`,
  ]);
  if (status !== 0) return status;
  return report(9) ? 0 : 1;
}

process.exit(await main());
