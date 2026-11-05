// T10 自动验证（tests/test_cases.md C-35、C-36 及主页/设置相关 P0）
// 运行：cd backend && npm run build && node --no-warnings --test tests/t10.test.mjs
//
// 隔离纪律：全部数据只写 tests/runtime/t10/；Agent 目录用自建模拟目录
// （defaultSkillsDirFor 显式 baseDir），绝不触碰真实 ~/.claude 等目录。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME = path.join(PROJECT_ROOT, 'tests', 'runtime');
const BASE = path.join(RUNTIME, 't10');

const { AppContext } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'context.js')).href);
const { createIpcHandlers } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'ipc', 'handlers.js')).href);
const { AppStateService } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'app-state.js')).href);
const { defaultSkillsDirFor, selectBuiltinAgents } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'agents.js')).href
);

// ────────────────────────── 工具 ──────────────────────────

function writeSkill(dir, name, description, body = '') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  );
}

function readMeta(libraryDir, dirName) {
  return JSON.parse(fs.readFileSync(path.join(libraryDir, 'sync', `${dirName}.skill.json`), 'utf8'));
}

function skillNames(libraryDir) {
  const dir = path.join(libraryDir, 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function assertLinkTo(target, expected) {
  const st = fs.lstatSync(target);
  assert.equal(st.isSymbolicLink(), true, `lstat 判定为链接：${target}`);
  const resolved = path.resolve(fs.readlinkSync(target));
  assert.equal(resolved.toLowerCase(), path.resolve(expected).toLowerCase(), `readlink 指向 ${expected}`);
}

function readAppStateFile(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'app-state.json'), 'utf8'));
}

/** 每个测试组独立的全新目录（库 / 数据 / 临时 / 模拟 Agent 目录）。 */
function makeDirs(name) {
  const root = path.join(BASE, name);
  fs.rmSync(root, { recursive: true, force: true });
  const dirs = {
    root,
    lib: path.join(root, 'lib'),
    data: path.join(root, 'data'),
    tmp: path.join(root, 'tmp'),
    agents: path.join(root, 'agents'),
    src: path.join(root, 'src'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

/**
 * Agent 模拟目录名。产品内置清单只有 CodeBuddy / Cursor；
 * 本用例需要更多部署目标，其余以「自定义 Agent」写进本机配置（见 seedCustomAgents）。
 */
const AGENT_PLAIN = {
  codebuddy: '.codebuddy',
  cursor: '.cursor',
  'claude-code': 'claude',
  codex: 'codex',
  windsurf: 'windsurf',
  cline: 'cline',
};
const AGENT_NAMES = {
  codebuddy: 'CodeBuddy',
  cursor: 'Cursor',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  windsurf: 'Windsurf',
  cline: 'Cline',
};

function agentSkills(dirs, agentId) {
  const plain = AGENT_PLAIN[agentId] ?? agentId;
  return path.join(dirs.agents, plain, 'skills');
}

/** 预置本机配置：把 claude-code / codex / windsurf / cline 作为自定义 Agent 写入。 */
function seedCustomAgents(dirs) {
  fs.mkdirSync(dirs.data, { recursive: true });
  const ids = ['claude-code', 'codex', 'windsurf', 'cline'];
  const records = ids.map((id) => ({
    id,
    name: AGENT_NAMES[id],
    skillsDir: agentSkills(dirs, id),
    enabled: true,
    builtin: false,
  }));
  fs.writeFileSync(
    path.join(dirs.data, 'agents.json'),
    JSON.stringify({ schemaVersion: 1, agents: records }, null, 2),
    'utf8',
  );
}

function newContext(dirs, extra = {}) {
  return AppContext.create({
    libraryDir: dirs.lib,
    dataDir: dirs.data,
    tempDir: dirs.tmp,
    homeDir: dirs.agents,
    adapters: selectBuiltinAgents('codebuddy,cursor'),
    appEnv: 'development',
    version: '0.0.0-test',
    credentialPrefix: 'skills-studio-test/',
    ...extra,
  });
}

/** 在库里导入若干技能（来自独立 src 目录）并返回 name → skillId。 */
async function importSkills(ctx, srcDir, skills) {
  const ids = {};
  for (const skill of skills) {
    writeSkill(path.join(srcDir, skill.name), skill.name, skill.description, skill.body ?? '');
  }
  const batch = await ctx.sources.importSkills(ctx.sources.discoverFromLocalDir(srcDir).items);
  for (const r of batch.results) {
    assert.equal(r.status, 'imported', `样本导入成功：${r.name} → ${r.reason ?? ''}`);
    ids[r.name] = r.skillId;
  }
  return ids;
}

const MAIN = makeDirs('main');
let ctx;
let handlers;

before(async () => {
  fs.rmSync(BASE, { recursive: true, force: true });
  // 模拟 Agent 目录与其中的本机技能（首启扫描数据源）
  writeSkill(path.join(agentSkills(MAIN, 'claude-code'), 'hello-skill'), 'hello-skill', '问候技能', 'hello body');
  writeSkill(path.join(agentSkills(MAIN, 'claude-code'), 'alpha-skill'), 'alpha-skill', '阿尔法技能', 'alpha body');
  writeSkill(path.join(agentSkills(MAIN, 'codex'), 'beta-skill'), 'beta-skill', '贝塔技能', 'beta body');
  // 同一技能在第二个 Agent 目录中出现（导入时应识别为同名同内容 → 跳过）
  writeSkill(path.join(agentSkills(MAIN, 'cursor'), 'hello-skill'), 'hello-skill', '问候技能', 'hello body');
  writeSkill(path.join(agentSkills(MAIN, 'windsurf'), 'gamma-skill'), 'gamma-skill', '伽马技能', 'gamma body');
  writeSkill(path.join(agentSkills(MAIN, 'windsurf'), 'delta-skill'), 'delta-skill', '德尔塔技能', 'delta body');

  seedCustomAgents(MAIN);
  ctx = newContext(MAIN);
  handlers = createIpcHandlers({
    context: ctx,
    appInfo: () => ({
      productName: 'Skills 工作台',
      version: '0.0.0-test',
      appEnv: 'development',
      libraryDir: ctx.libraryDir,
      dataDir: MAIN.data,
      logDir: path.join(MAIN.root, 'logs'),
      electron: '39.8.10',
      chrome: '142',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
    version: '0.0.0-test',
    mode: 'development',
    pickDirectory: async () => null,
    openPath: async (target) => (fs.existsSync(target) ? '' : '目录不存在'),
  });
});

after(() => {
  ctx?.dispose();
});

// ────────────────────────── 首次启动 ──────────────────────────

let scanResult;

test('C-35 首启扫描：已启用且目录存在的 Agent、条目不落库', () => {
  const state = handlers['app:getInitialState'](undefined);
  assert.equal(state.firstRunCompleted, false);
  assert.equal(state.libraryPath, MAIN.lib);
  assert.equal(state.mode, 'development');

  scanResult = handlers['firstRun:scan'](undefined);
  assert.equal(scanResult.agentCount, 4, '只有已启用且目录存在的 4 个 Agent 参与扫描');
  assert.deepEqual(
    scanResult.agents.map((a) => a.id).sort(),
    ['claude-code', 'codex', 'cursor', 'windsurf'],
  );
  assert.equal(scanResult.items.length, 6);

  const byKey = new Map(scanResult.items.map((item) => [item.key, item]));
  const helloClaude = [...byKey.values()].find((i) => i.name === 'hello-skill' && i.agentId === 'claude-code');
  assert.ok(helloClaude, '发现 claude 目录中的 hello-skill');
  assert.equal(helloClaude.agentLabel, 'Claude Code');
  assert.equal(helloClaude.description, '问候技能');
  assert.equal(helloClaude.valid, true);
  assert.equal(helloClaude.inLibrary, false);
  assert.equal(helloClaude.path, path.join(agentSkills(MAIN, 'claude-code'), 'hello-skill'));

  // 扫描是纯读：不入库、不形成来源记录
  assert.equal(ctx.library.listSkills().length, 0, '扫描后库仍为空');
  const metaDir = path.join(MAIN.lib, 'sync');
  const metaFiles = fs.existsSync(metaDir) ? fs.readdirSync(metaDir).filter((n) => n.endsWith('.skill.json')) : [];
  assert.equal(metaFiles.length, 0, '扫描不写元数据（不形成来源记录）');
});

test('首启导入子集：计数 / 具体 Agent 来源与根目录 / 不自动部署', async () => {
  const helloKey = scanResult.items.find((i) => i.name === 'hello-skill' && i.agentId === 'claude-code').key;
  const betaKey = scanResult.items.find((i) => i.name === 'beta-skill').key;

  const result = await handlers['firstRun:import']({ keys: [helloKey, betaKey] });
  assert.deepEqual(result.summary, { imported: 2, skipped: 0, failed: 0 });
  assert.deepEqual(result.items.map((i) => i.status), ['imported', 'imported']);

  const skills = ctx.library.listSkills();
  assert.equal(skills.length, 2);
  assert.deepEqual(skillNames(MAIN.lib), ['beta-skill', 'hello-skill']);

  const meta = readMeta(MAIN.lib, 'hello-skill');
  assert.equal(meta.source.type, 'agent:claude-code');
  assert.equal(meta.source.origin, agentSkills(MAIN, 'claude-code'), '来源记可定位的 Agent 技能根目录');
  assert.equal(meta.source.sourceRelPath, 'hello-skill');

  // 导入不自动部署：Agent 原位置仍是实体目录，不是库链接
  const originPath = path.join(agentSkills(MAIN, 'claude-code'), 'hello-skill');
  assert.equal(fs.lstatSync(originPath).isSymbolicLink(), false, '导入不自动部署');
  assert.equal(skills.find((s) => s.dirName === 'hello-skill').deployedAgents.length, 0);

  // 同名同内容再次导入 → 跳过；扫描结果 inLibrary 标记更新
  const dupKey = scanResult.items.find((i) => i.name === 'hello-skill' && i.agentId === 'cursor').key;
  const dup = await handlers['firstRun:import']({ keys: [dupKey] });
  assert.deepEqual(dup.summary, { imported: 0, skipped: 1, failed: 0 });
  assert.equal(ctx.library.listSkills().length, 2);

  const rescan = handlers['firstRun:scan'](undefined);
  const helloItems = rescan.items.filter((i) => i.name === 'hello-skill');
  assert.equal(helloItems.length, 2);
  assert.ok(helloItems.every((i) => i.inLibrary === true), '已入库技能的 inLibrary=true');
  assert.equal(rescan.items.find((i) => i.name === 'alpha-skill').inLibrary, false);
});

test('首启扫描同名版本：较新 mtime 先入库，较旧版本报告冲突', async () => {
  const dirs = makeDirs('first-run-mtime');
  const older = path.join(agentSkills(dirs, 'cursor'), 'same-skill');
  const newer = path.join(agentSkills(dirs, 'codebuddy'), 'same-skill');
  writeSkill(older, 'same-skill', '旧版本', 'older body');
  writeSkill(newer, 'same-skill', '新版本', 'newer body');
  fs.utimesSync(path.join(older, 'SKILL.md'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  fs.utimesSync(path.join(newer, 'SKILL.md'), new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'));
  const localCtx = newContext(dirs);
  try {
    const rows = localCtx.firstRun.scan().items.filter((item) => item.name === 'same-skill');
    const oldRow = rows.find((item) => item.agentId === 'cursor');
    const newRow = rows.find((item) => item.agentId === 'codebuddy');
    assert.ok(oldRow && newRow);
    const result = await localCtx.firstRun.importSelected([oldRow.key, newRow.key]);
    assert.equal(result.items[0].key, newRow.key);
    assert.equal(result.items[0].status, 'imported');
    assert.equal(result.items[1].key, oldRow.key);
    assert.equal(result.items[1].status, 'failed');
    assert.match(result.items[1].reason, /中心库已存在同名但内容不同/);
    assert.match(fs.readFileSync(path.join(dirs.lib, 'skills', 'same-skill', 'SKILL.md'), 'utf8'), /newer body/);
    assert.equal(readMeta(dirs.lib, 'same-skill').source.origin, agentSkills(dirs, 'codebuddy'));
  } finally {
    localCtx.dispose();
  }
});

test('首启完成标记幂等，并跨实例持久（app-state.json）', () => {
  const first = handlers['firstRun:complete'](undefined);
  assert.equal(first.firstRunCompleted, true);
  const second = handlers['firstRun:complete'](undefined);
  assert.equal(second.firstRunCompleted, true);

  const stored = readAppStateFile(MAIN.data);
  assert.equal(stored.firstRunCompleted, true);
  assert.equal(stored.libraryPath, null, '未改路径时不写 libraryPath');

  // 新实例读同一 DATA_DIR → 仍是已完成
  assert.equal(new AppStateService(MAIN.data).firstRunCompleted, true);
  assert.equal(handlers['app:getInitialState'](undefined).firstRunCompleted, true);
});

// ────────────────────────── 主页 ──────────────────────────

let skillIds = {};

test('主页概览：库中数量、同步覆盖（实测链接）、已接入 Agent', async () => {
  // 继续导入剩余技能，库中共 5 个
  const scan = handlers['firstRun:scan'](undefined);
  const keys = scan.items
    .filter((i) => ['alpha-skill', 'gamma-skill', 'delta-skill'].includes(i.name))
    .map((i) => i.key);
  const imported = await handlers['firstRun:import']({ keys });
  assert.deepEqual(imported.summary, { imported: 3, skipped: 0, failed: 0 });

  skillIds = Object.fromEntries(ctx.library.listSkills().map((s) => [s.dirName, s.skillId]));
  assert.equal(Object.keys(skillIds).length, 5);

  // 部署 2 个技能到 2 个 Agent（选择「不是该技能来源目录」的 Agent：
  // 技能来源目录里仍是实体目录，部署到同一处属冲突，产品语义为零覆盖）
  const deployed = await ctx.deploy.syncToAgents(
    [skillIds['hello-skill'], skillIds['beta-skill']],
    ['codex', 'claude-code'],
  );
  assert.equal(deployed.summary.deployed, 2);
  assertLinkTo(
    path.join(agentSkills(MAIN, 'codex'), 'hello-skill'),
    path.join(MAIN.lib, 'skills', 'hello-skill'),
  );

  const overview = handlers['library:getOverview'](undefined);
  assert.equal(overview.skillCount, 5);
  assert.deepEqual(overview.syncCoverage, { deployed: 2, total: 5 });
  assert.equal(overview.agentsConnected, 4);
});

test('近期动态：每技能只取最新一条、倒序、文案与相对时间', () => {
  const before = ctx.library.getActivityCount();
  const activity = handlers['library:getRecentActivity'](undefined).items;
  assert.equal(ctx.library.getActivityCount(), before, '读取动态不产生事件');

  assert.equal(activity.length, 5, '每技能一条（6 次导入里 hello 被跳过，无新事件）');
  const ids = activity.map((i) => i.skillId);
  assert.equal(new Set(ids).size, ids.length, '同一技能只出现一次');

  const times = activity.map((i) => i.occurredAt);
  const sorted = [...times].sort().reverse();
  assert.deepEqual(times, sorted, '按发生时间倒序');

  const hello = activity.find((i) => i.skillId === skillIds['hello-skill']);
  assert.match(hello.text, /^已同步至 /, '部署后的技能显示「已同步至 X」');
  assert.ok(hello.text.includes('Codex'));

  const alpha = activity.find((i) => i.skillId === skillIds['alpha-skill']);
  assert.equal(alpha.text, '新入库 · 尚未同步');
  assert.equal(alpha.relativeTime, '刚刚');
  assert.equal(typeof alpha.occurredAt, 'string');
  assert.equal(alpha.missing, false);

  // 追加一条更早/更新的历史事件，验证「只保留最新一条 + 倒序」
  const jsonl = path.join(MAIN.data, 'activity.jsonl');
  const oldEvent = {
    eventId: 'ev_test_old',
    skillId: skillIds['gamma-skill'],
    type: 'content-changed',
    occurredAt: '2024-01-01T00:00:00.000Z',
    detail: '旧事件',
  };
  fs.appendFileSync(jsonl, `${JSON.stringify(oldEvent)}\n`, 'utf8');
  const afterOld = handlers['library:getRecentActivity'](undefined).items;
  const gamma = afterOld.find((i) => i.skillId === skillIds['gamma-skill']);
  assert.equal(gamma.text, '新入库 · 尚未同步', '更早的历史事件不会覆盖最新状态');
  assert.equal(afterOld.length, 5);

  const newer = {
    eventId: 'ev_test_new',
    skillId: skillIds['gamma-skill'],
    type: 'content-changed',
    occurredAt: '2099-01-01T00:00:00.000Z',
    detail: '未来事件',
  };
  fs.appendFileSync(jsonl, `${JSON.stringify(newer)}\n`, 'utf8');
  const afterNew = handlers['library:getRecentActivity'](undefined).items;
  assert.equal(afterNew[0].skillId, skillIds['gamma-skill'], '最新事件排在最前');
  assert.equal(afterNew[0].text, '内容已变更 · 尚未同步');
  assert.equal(afterNew.length, 5);
});

// ────────────────────────── 设置：Agent ──────────────────────────

test('Agent 设置：停用保留链接、自定义新增、修改路径、全部启停', async () => {
  const codexLink = path.join(agentSkills(MAIN, 'codex'), 'hello-skill');
  const disabled = handlers['agents:setEnabled']({ agentId: 'codex', enabled: false });
  assert.equal(disabled.agents.find((a) => a.id === 'codex').enabled, false);
  assertLinkTo(codexLink, path.join(MAIN.lib, 'skills', 'hello-skill'));

  // 停用只影响部署目标，不影响扫描（与竞品一致：扫描不看启停）
  const scan = handlers['firstRun:scan'](undefined);
  assert.ok(scan.agents.some((a) => a.id === 'codex'), '停用 Agent 仍参与扫描');
  const target = await ctx.deploy.syncToAgents([skillIds['beta-skill']], ['codex']);
  assert.equal(target.items[0].status, 'skipped');
  assert.equal(target.items[0].code, 'AGENT_DISABLED');

  // 全部启用 / 全部禁用
  const enabledAll = handlers['agents:setEnabled']({ enabled: true });
  assert.ok(enabledAll.agents.every((a) => a.enabled));
  const disabledAll = handlers['agents:setEnabled']({ enabled: false });
  assert.ok(disabledAll.agents.every((a) => !a.enabled));
  handlers['agents:setEnabled']({ enabled: true });

  // 新增自定义 Agent（目录不存在 → 未检测；建目录后 redetect 变已检测）
  const customDir = path.join(MAIN.agents, 'mytool', 'skills');
  const added = handlers['agents:addCustom']({ name: 'My Tool', skillsDir: customDir });
  const custom = added.agents.find((a) => a.name === 'My Tool');
  assert.ok(custom);
  assert.equal(custom.builtin, false);
  assert.equal(custom.installed, false);
  assert.equal(added.stats.custom, 5, '预置 4 个自定义 + 本次新增 1 个');

  fs.mkdirSync(customDir, { recursive: true });
  const redetected = handlers['agents:redetect'](undefined);
  assert.equal(redetected.agents.find((a) => a.id === custom.id).installed, true);

  // 修改路径：旧目录不存在 → 未检测；改回已存在目录 → 已检测
  const missingDir = path.join(MAIN.agents, 'mytool', 'skills2');
  const updated = handlers['agents:updatePath']({ agentId: custom.id, skillsDir: missingDir });
  assert.equal(updated.agents.find((a) => a.id === custom.id).skillsDir, missingDir);
  assert.equal(updated.agents.find((a) => a.id === custom.id).installed, false);
  const restored = handlers['agents:updatePath']({ agentId: custom.id, skillsDir: customDir });
  assert.equal(restored.agents.find((a) => a.id === custom.id).installed, true);

  assert.throws(
    () => handlers['agents:updatePath']({ agentId: custom.id, skillsDir: 'relative/path' }),
    /AGENT_INVALID_DIR|绝对路径/,
    '相对路径被拒绝',
  );

  // 删除自定义 Agent；内置 Agent 不可删除（只能停用）
  assert.throws(() => ctx.agents.removeCustom('codebuddy'), /AGENT_BUILTIN_IMMUTABLE/);
  assert.equal(ctx.agents.removeCustom(custom.id), true);
  assert.ok(!handlers['agents:list'](undefined).agents.some((a) => a.id === custom.id));
  assert.equal(handlers['agents:list'](undefined).stats.custom, 4, '删掉新增项后剩预置 4 个');
});

// ────────────────────────── 设置：供应商（Key 只写不读） ──────────────────────────

test('供应商：新增、单选生效、Key 只写不读、配置无明文', () => {
  const initial = handlers['providers:list'](undefined);
  assert.equal(initial.providers.length, 0);
  assert.equal(initial.activeProviderId, null);
  assert.equal(initial.credentialBackend, 'windows-credential-manager');
  assert.ok(initial.presets.length >= 4, '返回平台预设');

  const added = handlers['providers:add']({
    preset: 'openai',
    name: 'OpenAI 测试',
    baseUrl: 'https://api.openai.com/v1',
    apiFormat: 'openai-completions',
  });
  assert.equal(added.providers.length, 1);
  assert.equal(added.activeProviderId, 'openai', '首个供应商自动生效');
  assert.equal(added.providers[0].credentialConfigured, false);
  assert.equal(added.providers[0].modelCount, 0);
  assert.deepEqual(added.providers[0].models, [], '新建供应商默认无模型，等待添加');
  assert.ok(
    added.presets.find((p) => p.preset === 'openai').suggestedModels.length > 0,
    '预设带候选模型（只作下拉提示）',
  );

  const second = handlers['providers:add']({
    preset: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiFormat: 'anthropic-messages',
  });
  assert.equal(second.providers.length, 2);
  assert.equal(second.activeProviderId, 'openai', '新增不改变当前生效供应商');

  const switched = handlers['providers:setActive']({ providerId: 'anthropic' });
  assert.equal(switched.activeProviderId, 'anthropic');

  const secret = 'sk-test-t10-not-a-real-key';
  const withKey = handlers['providers:saveKey']({ providerId: 'anthropic', apiKey: secret });
  assert.equal(withKey.providers.find((p) => p.id === 'anthropic').credentialConfigured, true);
  assert.ok(!JSON.stringify(withKey).includes(secret), 'IPC 响应不含明文 Key');

  const configText = fs.readFileSync(path.join(MAIN.data, 'agent-providers.json'), 'utf8');
  assert.ok(!configText.includes(secret), '配置文件无明文 Key');
  assert.match(configText, /"credentialConfigured": true/);

  // 编辑供应商：前端保存走 providers:add，同一预设命中原记录 = 原地更新
  ctx.providers.addModel('anthropic', 'claude-x');
  const edited = handlers['providers:add']({
    preset: 'anthropic',
    name: 'Anthropic 改名',
    baseUrl: 'https://api.anthropic.com/v1',
    apiFormat: 'anthropic-messages',
  });
  const editedRecord = edited.providers.find((p) => p.id === 'anthropic');
  assert.equal(edited.providers.length, 2, '编辑不新增记录');
  assert.equal(editedRecord.name, 'Anthropic 改名');
  assert.equal(editedRecord.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(editedRecord.modelCount, 1, '模型清单保留');
  assert.equal(editedRecord.credentialConfigured, true, 'Key 状态保留');
  assert.equal(ctx.providers.readApiKey('anthropic'), secret, '留空 Key 不覆盖原 Key');

  // 凭据往返（测试前缀）+ 清理，避免残留测试键
  assert.equal(ctx.providers.readApiKey('anthropic'), secret);
  assert.equal(ctx.providers.verifyCredential('anthropic').matchesStoredState, true);
  ctx.providers.clearApiKey('anthropic');
  assert.equal(ctx.providers.readApiKey('anthropic'), null);
  assert.equal(
    handlers['providers:list'](undefined).providers.find((p) => p.id === 'anthropic').credentialConfigured,
    false,
  );

  // 删除供应商：连带清凭据；生效供应商被删时自动切到下一条
  handlers['providers:saveKey']({ providerId: 'anthropic', apiKey: secret });
  const removed = handlers['providers:remove']({ providerId: 'anthropic' });
  assert.equal(removed.providers.length, 1, '只删掉指定的那一条');
  assert.ok(!removed.providers.some((p) => p.id === 'anthropic'));
  assert.equal(removed.activeProviderId, 'openai', '删掉生效供应商后自动切换');
  assert.equal(ctx.providers.readApiKey('anthropic'), null, '凭据随供应商一并清除');
  assert.throws(
    () => handlers['providers:remove']({ providerId: 'anthropic' }),
    /INVALID_PROVIDER/,
    '重复删除报供应商不存在',
  );

  // 模型清单随供应商一次写入（去重保序）；首个模型自动生效（保存在配置里，不进 IPC 视图）
  const withModels = handlers['providers:add']({
    preset: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiFormat: 'openai-completions',
    models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4'],
  });
  assert.deepEqual(withModels.providers[0].models, ['gpt-5.4', 'gpt-5.4-mini'], '去重且保持顺序');
  assert.equal(ctx.providers.readConfig().activeModelId, 'gpt-5.4', '首个模型自动生效');
});

// ────────────────────────── 库路径迁移 ──────────────────────────

/** 迁移夹具：独立库 + 独立数据 + 独立模拟 Agent，3 个技能部署到 2 个 Agent。 */
async function makeMigrationFixture(name, extra = {}) {
  const dirs = makeDirs(name);
  fs.mkdirSync(agentSkills(dirs, 'claude-code'), { recursive: true });
  fs.mkdirSync(agentSkills(dirs, 'codex'), { recursive: true });
  seedCustomAgents(dirs);
  const c = newContext(dirs, extra);
  const ids = await importSkills(c, dirs.src, [
    { name: 'mig-a', description: '迁移样本 A' },
    { name: 'mig-b', description: '迁移样本 B' },
    { name: 'mig-c', description: '迁移样本 C' },
  ]);
  // 评测报告目录随库迁移（reports/ 不在 skills/ 下，不会被部署）
  fs.mkdirSync(path.join(dirs.lib, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dirs.lib, 'reports', `${ids['mig-a']}.md`), 'migration sample report', 'utf8');
  const sync = await c.deploy.syncToAgents(Object.values(ids), ['claude-code', 'codex']);
  assert.equal(sync.summary.deployed, 6);
  for (const id of ['claude-code', 'codex']) {
    for (const dirName of ['mig-a', 'mig-b', 'mig-c']) {
      assertLinkTo(
        path.join(agentSkills(dirs, id), dirName),
        path.join(dirs.lib, 'skills', dirName),
      );
    }
  }
  return { dirs, ctx: c, ids };
}

test('C-36 迁移成功：文件搬迁 + 配置更新 + 按意图重建全部链接', async () => {
  const fx = await makeMigrationFixture('mig-success');
  const target = path.join(fx.dirs.root, 'new-lib');

  const result = await fx.ctx.changeLibraryDirectory(target, 'empty');
  assert.equal(result.status, 'moved', result.error);
  assert.equal(result.rolledBack, undefined);
  assert.equal(result.libraryPath, target);
  assert.equal(result.movedSkills, 3);
  assert.equal(result.links?.rebuilt, 6, '6 条意图链接全部重建');
  assert.equal(result.links?.failed, 0);

  // 新库内容完整，旧库已清空（避免双份数据）
  assert.deepEqual(skillNames(target), ['mig-a', 'mig-b', 'mig-c']);
  assert.deepEqual(skillNames(fx.dirs.lib), []);
  assert.ok(fs.existsSync(path.join(target, 'library.json')));
  assert.equal(
    fs.readFileSync(path.join(target, 'reports', `${fx.ids['mig-a']}.md`), 'utf8'),
    'migration sample report',
    'reports/ 随库迁移',
  );
  assert.equal(fs.existsSync(path.join(fx.dirs.lib, 'reports')), false, '旧库内容已清理');

  // 本机配置持久
  assert.equal(readAppStateFile(fx.dirs.data).libraryPath, target);

  // 链接按同步意图重建（junction 存绝对路径 → 必须指向新库）
  for (const agentId of ['claude-code', 'codex']) {
    for (const dirName of ['mig-a', 'mig-b', 'mig-c']) {
      assertLinkTo(
        path.join(agentSkills(fx.dirs, agentId), dirName),
        path.join(target, 'skills', dirName),
      );
    }
  }

  // 库服务已切到新路径：内容可读、概览数字正确
  assert.equal(fx.ctx.libraryDir, target);
  assert.equal(fx.ctx.library.listSkills().length, 3);
  const overview = fx.ctx.overview().overview();
  assert.deepEqual(overview.syncCoverage, { deployed: 3, total: 3 });

  fx.ctx.dispose();
});

test('C-36 目标非空：未选择策略返回 needs-policy；选「空目录」拒绝且零改动', async () => {
  const fx = await makeMigrationFixture('mig-nonempty');
  const target = path.join(fx.dirs.root, 'busy-lib');
  writeSkill(path.join(target, 'skills', 'pre-skill'), 'pre-skill', '目标已有技能');

  const needs = await fx.ctx.changeLibraryDirectory(target);
  assert.equal(needs.status, 'needs-policy');
  assert.equal(needs.libraryPath, fx.dirs.lib);
  assert.deepEqual(skillNames(fx.dirs.lib), ['mig-a', 'mig-b', 'mig-c'], '未做任何迁移');
  assertLinkTo(
    path.join(agentSkills(fx.dirs, 'claude-code'), 'mig-a'),
    path.join(fx.dirs.lib, 'skills', 'mig-a'),
  );

  const rejected = await fx.ctx.changeLibraryDirectory(target, 'empty');
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.errorCode, 'TARGET_NOT_EMPTY');
  assert.equal(rejected.libraryPath, fx.dirs.lib);
  assert.equal(fx.ctx.libraryDir, fx.dirs.lib);
  assert.deepEqual(skillNames(target), ['pre-skill'], '目标目录零改动');

  // 合并：目标已有技能保留，库内技能并入，链接重建到合并后的库
  const merged = await fx.ctx.changeLibraryDirectory(target, 'merge');
  assert.equal(merged.status, 'moved', merged.error);
  assert.equal(merged.movedSkills, 3);
  assert.equal(merged.links?.rebuilt, 6);
  assert.deepEqual(skillNames(target), ['mig-a', 'mig-b', 'mig-c', 'pre-skill']);
  assert.equal(fx.ctx.library.listSkills().length, 4, '合并后库内 4 个技能');
  assertLinkTo(
    path.join(agentSkills(fx.dirs, 'codex'), 'mig-b'),
    path.join(target, 'skills', 'mig-b'),
  );

  fx.ctx.dispose();
});

test('C-36 注入失败：回退旧路径、恢复链接、清掉目标侧复制', async () => {
  const fx = await makeMigrationFixture('mig-rollback', { migrationFailPoint: 'after-link' });
  const target = path.join(fx.dirs.root, 'failed-lib');
  // 目标目录为空但已存在
  fs.mkdirSync(target, { recursive: true });

  const result = await fx.ctx.changeLibraryDirectory(target, 'empty');
  assert.equal(result.status, 'failed');
  assert.equal(result.rolledBack, true, result.error);
  assert.equal(result.errorCode, 'MIGRATION_FAILED');
  assert.equal(result.libraryPath, fx.dirs.lib, '回退后仍用旧路径');

  // 配置回退（初始未设置 libraryPath → 仍是 null；未发生写入时文件可能不存在）
  if (fs.existsSync(path.join(fx.dirs.data, 'app-state.json'))) {
    assert.equal(readAppStateFile(fx.dirs.data).libraryPath, null);
  }
  assert.equal(fx.ctx.libraryDir, fx.dirs.lib);
  assert.deepEqual(skillNames(fx.dirs.lib), ['mig-a', 'mig-b', 'mig-c'], '旧库完好');

  // 目标侧复制被撤销（只留空目录）
  assert.deepEqual(skillNames(target), []);

  // 链接恢复指向旧库
  for (const agentId of ['claude-code', 'codex']) {
    for (const dirName of ['mig-a', 'mig-b', 'mig-c']) {
      assertLinkTo(
        path.join(agentSkills(fx.dirs, agentId), dirName),
        path.join(fx.dirs.lib, 'skills', dirName),
      );
    }
  }
  assert.equal(fx.ctx.library.listSkills().length, 3);
  assert.deepEqual(fx.ctx.overview().overview().syncCoverage, { deployed: 3, total: 3 });

  fx.ctx.dispose();
});

test('C-36 目标非法：同目录 / 嵌套目录在写入前被拒绝', async () => {
  const fx = await makeMigrationFixture('mig-invalid');

  const same = await fx.ctx.changeLibraryDirectory(fx.dirs.lib);
  assert.equal(same.status, 'failed');
  assert.equal(same.errorCode, 'SAME_DIRECTORY');

  const nested = await fx.ctx.changeLibraryDirectory(path.join(fx.dirs.lib, 'inner'));
  assert.equal(nested.status, 'failed');
  assert.equal(nested.errorCode, 'NESTED_DIRECTORY');

  assert.equal(fx.ctx.libraryDir, fx.dirs.lib);
  assert.deepEqual(skillNames(fx.dirs.lib), ['mig-a', 'mig-b', 'mig-c']);
  assert.equal(fx.ctx.library.listSkills().length, 3);

  fx.ctx.dispose();
});

// ────────────────────────── 打开文件夹 IPC ──────────────────────────

test('library:openFolder 使用当前库路径并回报失败原因', async () => {
  const ok = await handlers['library:openFolder'](undefined);
  assert.equal(ok.ok, true);
  assert.equal(ok.path, ctx.libraryDir);

  const failing = createIpcHandlers({
    context: ctx,
    appInfo: () => ({ libraryDir: ctx.libraryDir }),
    version: '0.0.0-test',
    mode: 'development',
    pickDirectory: async () => 'C:/picked',
    openPath: async () => '拒绝访问',
  });
  const failed = await failing['library:openFolder'](undefined);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, '拒绝访问');

  const picked = await failing['app:pickDirectory']({ title: '选择目录' });
  assert.deepEqual(picked, { path: 'C:/picked' });
});
