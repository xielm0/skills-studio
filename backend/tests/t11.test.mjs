// T11 自动验证（tests/test_cases.md C-33 及中心库/详情相关 P0）
// 运行：cd backend && npm run build && node --no-warnings --test tests/t11.test.mjs
//
// 隔离纪律：全部数据只写 tests/runtime/t11/；Agent 目录用自建模拟目录，
// 绝不触碰真实 ~/.claude 等目录；不写真实库。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME = path.join(PROJECT_ROOT, 'tests', 'runtime');
const BASE = path.join(RUNTIME, 't11');

const { AppContext } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'context.js')).href);
const { createIpcHandlers } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'ipc', 'handlers.js')).href);
const { defaultSkillsDirFor, selectBuiltinAgents } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'agents.js')).href
);
const { EvalReportStore } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'agent', 'workflows', 'report-store.js')).href
);
const { countFiles } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'file-tree.js')).href);

// ────────────────────────── 工具 ──────────────────────────

function writeSkill(dir, name, description, body = '') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  );
}

/** 72 文件样本（SKILL.md + references/40 + scripts/20 + assets/11）。 */
function writeBigSkill(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: big-skill\ndescription: 72 文件规模的浏览样本\n---\n\n# Big Skill\n\n完整目录结构。\n',
    'utf8',
  );
  for (let i = 1; i <= 40; i++) {
    const rel = `references/file-${String(i).padStart(2, '0')}.md`;
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), `# reference ${i}\n参考内容 ${i}\n`, 'utf8');
  }
  for (let i = 1; i <= 20; i++) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, `scripts/file-${String(i).padStart(2, '0')}.py`), `print("script ${i}")\n`, 'utf8');
  }
  for (let i = 1; i <= 11; i++) {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, `assets/file-${String(i).padStart(2, '0')}.txt`), `asset ${i}\n`, 'utf8');
  }
}

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
 * 本用例需要更多目标，其余以「自定义 Agent」写进本机配置（见 seedCustomAgents）。
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
  return path.join(dirs.agents, AGENT_PLAIN[agentId] ?? agentId, 'skills');
}

/** 预置本机配置：claude-code / codex / windsurf / cline 作为自定义 Agent。 */
function seedCustomAgents(dirs) {
  fs.mkdirSync(dirs.data, { recursive: true });
  const records = ['claude-code', 'codex', 'windsurf', 'cline'].map((id) => ({
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

function makeHandlers(ctx, dirs) {
  return createIpcHandlers({
    context: ctx,
    appInfo: () => ({
      productName: 'Skills 工作台',
      version: '0.0.0-test',
      appEnv: 'development',
      libraryDir: ctx.libraryDir,
      dataDir: dirs.data,
      logDir: path.join(dirs.root, 'logs'),
      electron: '39.8.10',
      chrome: '142',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
    version: '0.0.0-test',
    mode: 'development',
    pickDirectory: async () => null,
    openPath: async () => '',
  });
}

function assertLinkTo(target, expected) {
  const st = fs.lstatSync(target);
  assert.equal(st.isSymbolicLink(), true, `lstat 判定为链接：${target}`);
  const resolved = path.resolve(fs.readlinkSync(target));
  assert.equal(resolved.toLowerCase(), path.resolve(expected).toLowerCase(), `readlink 指向 ${expected}`);
}

async function expectRejected(fn, pattern) {
  let error = null;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error, '应当抛错');
  if (pattern) assert.match(`${error.code ?? ''} ${error.message ?? ''}`, pattern);
  return error;
}

function metaOf(dirs, dirName) {
  return JSON.parse(fs.readFileSync(path.join(dirs.lib, 'sync', `${dirName}.skill.json`), 'utf8'));
}

const MAIN = makeDirs('main');
let ctx;
let handlers;
let ids = {};

before(async () => {
  fs.rmSync(BASE, { recursive: true, force: true });
  for (const agent of ['claude-code', 'codex', 'cursor', 'windsurf']) {
    fs.mkdirSync(agentSkills(MAIN, agent), { recursive: true });
  }
  seedCustomAgents(MAIN);

  writeBigSkill(path.join(MAIN.src, 'big-skill'));
  writeSkill(path.join(MAIN.src, 'code-review'), 'code-review', '按清单审查改动并输出结构化评审结论', '审查流程');
  writeSkill(path.join(MAIN.src, 'doc-writer'), 'doc-writer', '把需求与实现整理成可维护的技术文档', '文档写作');
  writeSkill(path.join(MAIN.src, 'git-commit'), 'git-commit', '根据改动生成符合规范的提交信息', '提交信息');
  writeSkill(path.join(MAIN.src, 'react-patterns'), 'react-patterns', 'React 组件拆分与状态管理约定');
  writeSkill(path.join(MAIN.src, 'api-design'), 'api-design', '接口命名、错误码与分页约定');

  ctx = newContext(MAIN);
  handlers = makeHandlers(ctx, MAIN);

  const imported = await ctx.sources.importSkills(ctx.sources.discoverFromLocalDir(MAIN.src).items);
  const failed = imported.results.filter((r) => r.status !== 'imported');
  assert.equal(failed.length, 0, `样本导入失败：${JSON.stringify(failed)}`);
  ids = Object.fromEntries(ctx.library.listSkills().map((s) => [s.dirName, s.skillId]));
  assert.equal(Object.keys(ids).length, 6);

  // 部署到两个模拟 Agent（链接）
  const deployed = await ctx.deploy.syncToAgents(
    [ids['code-review'], ids['api-design']],
    ['claude-code', 'codex'],
  );
  assert.equal(deployed.summary.deployed, 4);

  // 评测报告：仅 big-skill 有（决定「评测查看」是否出现在菜单）
  new EvalReportStore(path.join(MAIN.lib, 'reports'), () => 'big-skill').save(ids['big-skill'], '# 评测结果\n\n总评：结构完整。\n');

  // 配置一个不需要 Key 的本地供应商，用于 prefill 建会话
  ctx.providers.addProvider({ preset: 'ollama' });
  ctx.providers.addModel('ollama', 'llama3:8b');
});

after(() => {
  ctx?.dispose();
});

// ────────────────────────── 列表与筛选 ──────────────────────────

test('library:list 组合筛选 + facets（Group / 来源 / Agent）', async () => {
  const all = handlers['library:list']({});
  assert.equal(all.total, 6);
  assert.deepEqual(
    all.items.map((row) => row.dirName),
    ['api-design', 'big-skill', 'code-review', 'doc-writer', 'git-commit', 'react-patterns'],
  );
  const big = all.items.find((row) => row.dirName === 'big-skill');
  assert.equal(big.hasReport, true, '仅有报告的技能 hasReport=true');
  assert.equal(big.source.type, 'local-dir');
  assert.equal(big.source.label, '本地');
  assert.equal(all.items.find((row) => row.dirName === 'api-design').deployedAgents.length, 2);

  // Group 标签（先写后查）
  await handlers['library:setGroups']({ skillId: ids['code-review'], add: ['写作', '日常'] });
  await handlers['library:setGroups']({ skillId: ids['doc-writer'], add: ['写作'] });
  await handlers['library:setGroups']({ skillId: ids['git-commit'], add: ['开发'] });

  const byGroup = handlers['library:list']({ group: '写作' });
  assert.deepEqual(byGroup.items.map((r) => r.dirName).sort(), ['code-review', 'doc-writer']);

  const byQuery = handlers['library:list']({ query: '审查' });
  assert.deepEqual(byQuery.items.map((r) => r.dirName), ['code-review']);

  const byQueryAndGroup = handlers['library:list']({ query: '文档', group: '写作' });
  assert.deepEqual(byQueryAndGroup.items.map((r) => r.dirName), ['doc-writer']);

  // 组合：来源 + Agent + Group
  const combined = handlers['library:list']({
    sourceType: 'local-dir',
    agentId: 'claude-code',
    group: '写作',
  });
  assert.deepEqual(combined.items.map((r) => r.dirName), ['code-review']);

  const bySource = handlers['library:list']({ sourceType: 'git' });
  assert.equal(bySource.total, 0, '不存在的来源类型返回空列表');
  const byDisplayedSource = handlers['library:list']({ sourceType: 'local-dir' });
  assert.equal(byDisplayedSource.total, 6, '展示分类“本地”覆盖本地目录来源');

  const byOrigin = handlers['library:list']({ origin: MAIN.src });
  assert.equal(byOrigin.total, 6, '按来源位置筛选');
  const byOtherOrigin = handlers['library:list']({ origin: path.join(MAIN.root, 'other-src') });
  assert.equal(byOtherOrigin.total, 0, '不同来源位置不匹配');

  const facets = handlers['library:facets'](undefined);
  assert.equal(facets.total, 6);
  assert.deepEqual(
    facets.groups.map((g) => g.value),
    ['写作', '开发', '日常'].sort((a, b) => (a < b ? -1 : 1)),
  );
  assert.equal(facets.groups.find((g) => g.value === '写作').count, 2);
  assert.deepEqual(
    facets.sources.map((s) => s.value),
    ['local-dir'],
  );
  assert.ok(facets.agents.every((a) => a.value !== 'cline'), '未安装 Agent 不出现在可选值');
  assert.equal(facets.agents.find((a) => a.value === 'claude-code').count, 2);

  const missing = handlers['library:list']({ query: '不存在的关键词' });
  assert.equal(missing.total, 0);
});

test('中心库导航只显示一层文件夹，并按当前层列出文件夹名 Skill', async () => {
  const dirs = makeDirs('folder-navigation');
  writeSkill(path.join(dirs.lib, 'skills', 'root-skill'), 'frontmatter-root', '根目录技能');
  writeSkill(path.join(dirs.lib, 'skills', 'docs', 'nested-skill'), 'frontmatter-nested', '文件夹技能');
  fs.mkdirSync(path.join(dirs.lib, 'skills', 'empty-folder'), { recursive: true });
  const localCtx = newContext(dirs);
  const localHandlers = makeHandlers(localCtx, dirs);
  try {
    await localCtx.library.rescan();
    assert.deepEqual((await localHandlers['library:folders'](undefined)).folders, ['docs', 'empty-folder']);
    writeSkill(path.join(dirs.lib, 'skills', 'external-skill'), 'frontmatter-external', '尚未重扫的根目录技能');
    fs.mkdirSync(path.join(dirs.lib, 'skills', 'external-folder'), { recursive: true });
    assert.deepEqual((await localHandlers['library:folders'](undefined)).folders, ['docs', 'empty-folder', 'external-folder'],
      '外部目录变动应直接按磁盘识别，不等待索引刷新');
    assert.deepEqual(localHandlers['library:list']({ folder: '' }).items.map((row) => row.name), ['root-skill']);
    assert.deepEqual(localHandlers['library:list']({ folder: 'docs' }).items.map((row) => row.name), ['nested-skill']);
    assert.equal(localHandlers['library:list']({ folder: 'empty-folder' }).total, 0);
    assert.equal(localHandlers['library:facets']({ folder: 'docs' }).total, 1);
    assert.equal(localHandlers['library:facets']({ folder: '' }).total, 1);
    assert.equal(localHandlers['library:list']({}).total, 2, '省略 folder 的现有调用仍查询全库');
    assert.equal(localHandlers['library:list']({ folder: 'docs', query: 'frontmatter-nested' }).total, 0);
  } finally {
    localCtx.dispose();
  }
});

// ────────────────────────── 详情与文件树 ──────────────────────────

test('library:detail：72 文件真实树（references/scripts/assets 完整）', () => {
  const detail = handlers['library:detail']({ skillId: ids['big-skill'] });
  assert.equal(detail.name, 'big-skill');
  assert.equal(detail.missing, false);
  assert.equal(countFiles(detail.fileTree), 72, '文件数应为 72');
  const names = detail.fileTree.children.map((child) => child.name);
  assert.deepEqual(names, ['assets', 'references', 'scripts', 'SKILL.md']);
  const refs = detail.fileTree.children.find((child) => child.name === 'references');
  assert.equal(refs.children.length, 40);
  const scripts = detail.fileTree.children.find((child) => child.name === 'scripts');
  assert.deepEqual(
    scripts.children.slice(0, 2).map((child) => child.name),
    ['file-01.py', 'file-02.py'],
  );
  assert.ok(detail.contentHash, '详情带内容哈希');
  assert.equal(detail.hasReport, true);
  assert.match(detail.reportPath, /reports[\\/]big-skill_review_\d{8}-\d{6}\.md$/);
});

test('library:readFile：正常读取 / 越界拒绝 / 二进制只读 / 超限只读', async () => {
  const md = handlers['library:readFile']({ skillId: ids['big-skill'], relPath: 'SKILL.md' });
  assert.equal(md.editable, true);
  assert.match(md.content, /name: big-skill/);
  assert.equal(md.reason, null);

  const nested = handlers['library:readFile']({ skillId: ids['big-skill'], relPath: 'references/file-07.md' });
  assert.equal(nested.editable, true);
  assert.match(nested.content, /reference 7/);

  // 越界：.. / 绝对路径 / 盘符
  for (const relPath of ['../doc-writer/SKILL.md', '../../library.json', 'C:/Windows/win.ini', '/etc/passwd']) {
    assert.throws(
      () => handlers['library:readFile']({ skillId: ids['big-skill'], relPath }),
      /INVALID_PATH|拒绝/,
      `应拒绝：${relPath}`,
    );
  }

  // 二进制文件（含 NUL）
  const skillDir = path.join(MAIN.lib, 'skills', 'big-skill');
  fs.writeFileSync(path.join(skillDir, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const binary = handlers['library:readFile']({ skillId: ids['big-skill'], relPath: 'assets/logo.png' });
  assert.equal(binary.editable, false);
  assert.equal(binary.reason, 'BINARY');
  assert.equal(binary.content, null, '二进制内容不送入渲染层');

  // 超限（> 512KB）
  fs.writeFileSync(path.join(skillDir, 'assets', 'huge.txt'), 'a'.repeat(600 * 1024), 'utf8');
  const huge = handlers['library:readFile']({ skillId: ids['big-skill'], relPath: 'assets/huge.txt' });
  assert.equal(huge.editable, false);
  assert.equal(huge.reason, 'TOO_LARGE');
  assert.equal(huge.content, null);

  assert.throws(
    () => handlers['library:readFile']({ skillId: ids['big-skill'], relPath: 'references/missing.md' }),
    /FILE_NOT_FOUND|文件不存在/,
  );

  // 清理只读样本并重扫，避免影响后续「保存只产生一条事件」的基线
  fs.rmSync(path.join(skillDir, 'assets', 'logo.png'), { force: true });
  fs.rmSync(path.join(skillDir, 'assets', 'huge.txt'), { force: true });
  await ctx.library.rescan();
});

// ────────────────────────── 保存 ──────────────────────────

test('C-33 library:writeFile：原子保存 + 哈希更新 + content-changed + 重扫', async () => {
  const before = handlers['library:detail']({ skillId: ids['code-review'] });
  const eventsBefore = ctx.library.getActivityCount();

  const next = '---\nname: code-review\ndescription: 按清单审查改动并输出结构化评审结论（已更新）\n---\n\n# code-review\n\n新内容\n';
  const result = await handlers['library:writeFile']({
    skillId: ids['code-review'],
    relPath: 'SKILL.md',
    content: next,
  });
  assert.equal(result.size, Buffer.byteLength(next, 'utf8'));
  assert.notEqual(result.contentHash, before.contentHash, '内容哈希已变化');

  // 磁盘 + 索引 + 元数据三处一致
  const disk = fs.readFileSync(path.join(MAIN.lib, 'skills', 'code-review', 'SKILL.md'), 'utf8');
  assert.equal(disk, next);
  const detail = handlers['library:detail']({ skillId: ids['code-review'] });
  assert.equal(detail.contentHash, result.contentHash);
  assert.equal(detail.description, '按清单审查改动并输出结构化评审结论（已更新）');
  assert.equal(metaOf(MAIN, 'code-review').contentHash, result.contentHash);

  // 真实产生一条 content-changed（重扫不重复计）
  const eventsAfter = ctx.library.getActivityCount();
  assert.equal(eventsAfter, eventsBefore + 1, '保存应新增一条事件');
  const latest = ctx.library.getRecentActivity().find((event) => event.skillId === ids['code-review']);
  assert.equal(latest.type, 'content-changed');

  // 相同内容再保存：不产生第二条事件
  await handlers['library:writeFile']({ skillId: ids['code-review'], relPath: 'SKILL.md', content: next });
  assert.equal(ctx.library.getActivityCount(), eventsAfter, '内容未变不应重复发事件');

  // 越界写被拒绝
  await expectRejected(
    () => handlers['library:writeFile']({ skillId: ids['code-review'], relPath: '../api-design/SKILL.md', content: 'x' }),
    /INVALID_PATH/,
  );
});

test('保存失败：旧内容保留、未保存文本由渲染层保留（服务层抛出可读原因）', async () => {
  const dirs = makeDirs('save-fail');
  const localCtx = newContext(dirs, { fileWriteFailPoint: 'before-rename' });
  const localHandlers = makeHandlers(localCtx, dirs);
  try {
    writeSkill(path.join(dirs.src, 'flaky'), 'flaky', '保存失败样本');
    await localCtx.sources.importSkills(localCtx.sources.discoverFromLocalDir(dirs.src).items);
    const skillId = localCtx.library.listSkills()[0].skillId;
    const original = fs.readFileSync(path.join(dirs.lib, 'skills', 'flaky', 'SKILL.md'), 'utf8');
    const error = await expectRejected(
      () => localHandlers['library:writeFile']({ skillId, relPath: 'SKILL.md', content: '写坏了' }),
      /SAVE_FAILED/,
    );
    assert.match(error.message, /旧内容|保存失败/);
    const after = fs.readFileSync(path.join(dirs.lib, 'skills', 'flaky', 'SKILL.md'), 'utf8');
    assert.equal(after, original, '失败后旧内容零改动');
    assert.equal(localCtx.library.getActivityCount(), 1, '失败不产生内容变更事件');
    // 目录里不留临时文件
    const leftovers = fs.readdirSync(path.join(dirs.lib, 'skills', 'flaky')).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    localCtx.dispose();
  }
});

// ────────────────────────── Group ──────────────────────────

test('library:setGroups / batchGroups：集合语义，批量只作用选中项', async () => {
  const added = await handlers['library:setGroups']({
    skillId: ids['react-patterns'],
    add: ['前端', '常用'],
  });
  assert.deepEqual(added.groups, ['前端', '常用'].sort((a, b) => (a < b ? -1 : 1)));

  const twice = await handlers['library:setGroups']({
    skillId: ids['react-patterns'],
    add: ['常用'],
    remove: ['前端'],
  });
  assert.deepEqual(twice.groups, ['常用']);

  // 非法 Group 名拒绝
  await expectRejected(
    () => handlers['library:setGroups']({ skillId: ids['react-patterns'], add: ['  '] }),
    /Group 名不能为空/,
  );
  await expectRejected(
    () => handlers['library:setGroups']({ skillId: ids['react-patterns'], add: ['x'.repeat(41)] }),
    /过长/,
  );

  const batch = await handlers['library:batchGroups']({
    skillIds: [ids['git-commit'], ids['api-design']],
    add: ['批量组'],
  });
  assert.equal(batch.items.length, 2);
  assert.ok(batch.items.every((item) => item.groups.includes('批量组')));

  const all = handlers['library:list']({});
  const byDir = new Map(all.items.map((row) => [row.dirName, row]));
  assert.deepEqual(byDir.get('git-commit').groups.sort(), ['批量组', '开发'].sort());
  assert.deepEqual(byDir.get('api-design').groups, ['批量组']);
  assert.ok(!byDir.get('react-patterns').groups.includes('批量组'), '未选中的技能不受批量影响');

  // 筛选与批量改动一致
  const filtered = handlers['library:list']({ group: '批量组' });
  assert.deepEqual(filtered.items.map((r) => r.dirName).sort(), ['api-design', 'git-commit']);
});

// ────────────────────────── 同步 ──────────────────────────

test('library:syncToAgents 逐项结果（只列启用 Agent）与 unsync', async () => {
  ctx.agents.setEnabled('windsurf', false);
  const result = await handlers['library:syncToAgents']({
    skillIds: [ids['git-commit'], ids['react-patterns']],
    agentIds: ['claude-code', 'codex', 'windsurf', 'cline'],
  });
  // 2 技能 × 2 有效目标；windsurf 停用、cline 未安装 → 忽略
  assert.equal(result.items.length, 4);
  assert.ok(result.items.every((item) => item.status === 'deployed' || item.status === 'already'));
  assert.equal(result.summary.deployed + result.summary.already, 4);
  assert.deepEqual(
    result.ignoredAgents.map((item) => item.agentId).sort(),
    ['cline', 'windsurf'],
  );
  assertLinkTo(
    path.join(agentSkills(MAIN, 'codex'), 'git-commit'),
    path.join(MAIN.lib, 'skills', 'git-commit'),
  );

  const rows = handlers['library:list']({ agentId: 'codex' });
  assert.ok(rows.items.some((row) => row.dirName === 'git-commit'));

  const unsync = await handlers['library:unsyncFromAgents']({
    skillIds: [ids['git-commit']],
    agentIds: ['codex'],
  });
  assert.equal(unsync.items.length, 1);
  assert.equal(unsync.items[0].status, 'removed');
  assert.equal(fs.existsSync(path.join(agentSkills(MAIN, 'codex'), 'git-commit')), false);
  assert.equal(
    fs.existsSync(path.join(MAIN.lib, 'skills', 'git-commit')),
    true,
    '撤下链接不动库内真身',
  );

  const after = handlers['library:list']({});
  assert.ok(!after.items.find((row) => row.dirName === 'git-commit').deployedAgents.includes('codex'));

  // 停用的 Agent 不再作为同步目标，但已有链接保留（此处未部署，无链接）
  ctx.agents.setEnabled('windsurf', true);
});

// ────────────────────────── 报告 / 删除 ──────────────────────────

test('library:report：有报告返回文本，不存在返回 exists:false', () => {
  const report = handlers['library:report']({ skillId: ids['big-skill'] });
  assert.equal(report.exists, true);
  assert.match(report.text, /总评/);

  const none = handlers['library:report']({ skillId: ids['react-patterns'] });
  assert.equal(none.exists, false);
  assert.equal(none.text, undefined);
});

test('library:removePlan / remove：撤下受管理链接、保留实体目录、需 confirm', async () => {
  // 实体目录（非本应用链接）放在 cursor 目录，删除时保留
  writeSkill(path.join(agentSkills(MAIN, 'cursor'), 'api-design'), 'api-design', '同名实体目录');
  const plan = handlers['library:removePlan']({ skillId: ids['api-design'] });
  assert.equal(plan.linksToRemove.length, 2, 'claude-code + codex 的受管理链接');
  assert.equal(plan.skippedTargets.length, 1, 'cursor 的实体目录保留');
  assert.equal(plan.dirName, 'api-design');

  await expectRejected(
    () => handlers['library:remove']({ skillId: ids['api-design'], confirm: false }),
    /confirm/,
  );
  assert.equal(fs.existsSync(path.join(MAIN.lib, 'skills', 'api-design')), true, '未确认不删除');

  const removed = await handlers['library:remove']({ skillId: ids['api-design'], confirm: true });
  assert.equal(removed.removedLinks, 2);
  assert.equal(removed.libraryDirDeleted, true);
  assert.equal(removed.remainingSkills, 5);
  assert.equal(fs.existsSync(path.join(MAIN.lib, 'skills', 'api-design')), false);
  assert.equal(fs.existsSync(path.join(MAIN.lib, 'sync', 'api-design.skill.json')), false);
  assert.equal(fs.existsSync(path.join(agentSkills(MAIN, 'claude-code'), 'api-design')), false);
  assert.equal(fs.existsSync(path.join(agentSkills(MAIN, 'codex'), 'api-design')), false);
  assert.equal(
    fs.existsSync(path.join(agentSkills(MAIN, 'cursor'), 'api-design')),
    true,
    '非归属实体目录零删除',
  );
  const list = handlers['library:list']({});
  assert.equal(list.total, 5);
  assert.throws(() => handlers['library:detail']({ skillId: ids['api-design'] }), /SKILL_NOT_FOUND/);
});

// ────────────────────────── 对话预填 ──────────────────────────

test('conversation:prefill：创建会话并预填提示词，运行请求数为 0', async () => {
  let runCalls = 0;
  const original = ctx.conversations.startRun.bind(ctx.conversations);
  ctx.conversations.startRun = async (...args) => {
    runCalls += 1;
    return original(...args);
  };
  try {
    const improve = handlers['conversation:prefill']({ mode: 'improve', skillId: ids['code-review'] });
    assert.equal(improve.mode, 'improve');
    assert.ok(improve.sessionId.startsWith('cv_'), `会话 ID 前缀：${improve.sessionId}`);
    assert.match(improve.prompt, /code-review/);
    assert.match(improve.prompt, /优化/);

    const evaluate = handlers['conversation:prefill']({ mode: 'evaluate', skillId: ids['code-review'] });
    assert.equal(evaluate.mode, 'evaluate');
    // 预填文案只保留用户可见的一句引导；skill-doctor 与 reports/ 约束在流程文本（t07 评测用例覆盖）
    assert.match(evaluate.prompt, /评测/);

    assert.equal(runCalls, 0, '预填不得启动运行');
    for (const sessionId of [improve.sessionId, evaluate.sessionId]) {
      const detail = ctx.conversations.getSession(sessionId);
      assert.equal(detail.runs.length, 0, '会话没有运行记录');
      assert.equal(detail.messages.length, 0, '会话没有消息（提示词只在渲染层预填）');
      assert.equal(detail.status, 'done');
    }

    await expectRejected(
      () => handlers['conversation:prefill']({ mode: 'unknown', skillId: ids['code-review'] }),
      /未知的预填模式/,
    );
  } finally {
    ctx.conversations.startRun = original;
  }
});

// ────────────────────────── 性能 ──────────────────────────

test('100 个 Skills 的列表与筛选在 1000ms 内可交互', async () => {
  const dirs = makeDirs('perf');
  const perfCtx = newContext(dirs);
  const perfHandlers = makeHandlers(perfCtx, dirs);
  try {
    for (let i = 1; i <= 100; i++) {
      const name = `perf-skill-${String(i).padStart(3, '0')}`;
      writeSkill(path.join(dirs.src, name), name, `性能样本 ${i}：用于验证 100 个技能的列表响应`, '内容');
    }
    const imported = await perfCtx.sources.importSkills(perfCtx.sources.discoverFromLocalDir(dirs.src).items);
    assert.equal(imported.results.filter((r) => r.status === 'imported').length, 100);
    assert.equal(perfCtx.library.listSkills().length, 100);

    // 预热（首次调用包含 DFS 目录构建等一次性成本）
    perfHandlers['library:facets'](undefined);

    const started = performance.now();
    const list = perfHandlers['library:list']({});
    const filtered = perfHandlers['library:list']({ query: 'perf-skill-05' });
    const facets = perfHandlers['library:facets'](undefined);
    const elapsed = performance.now() - started;

    assert.equal(list.total, 100);
    assert.equal(filtered.total, 10, 'perf-skill-05x 共 10 个');
    assert.equal(facets.total, 100);
    assert.ok(elapsed < 1000, `100 技能列表耗时 ${elapsed.toFixed(0)}ms，超过 1000ms`);
    console.log(
      `[t11] 100 技能：list ${list.total} 项 + 筛选 ${filtered.total} 项 + facets 合计 ${elapsed.toFixed(1)}ms（上限 1000ms）`,
    );
  } finally {
    perfCtx.dispose();
  }
});
