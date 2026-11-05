// T13 自动验证（tests/test_cases.md C-34；ui.md「Agents」「技能详情」）
// 运行：cd backend && npm run build && node --no-warnings --test tests/t13.test.mjs
// 隔离纪律：库/数据/临时/模拟 Agent 全部位于 tests/runtime/t13，绝不触碰真实 Agent 目录。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME = path.join(PROJECT_ROOT, 'tests', 'runtime');
const ROOT = path.join(RUNTIME, 't13');
const LIB = path.join(ROOT, 'lib');
const SKILLS = path.join(LIB, 'skills');
const DATA = path.join(ROOT, 'data');
const TMP = path.join(ROOT, 'tmp');
const AGENTS = path.join(ROOT, 'agents-mock');
const SRC = path.join(ROOT, 'src');

const { hashSkillDir } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href);
const { AppContext } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'context.js')).href);
const { selectBuiltinAgents } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'agents.js')).href
);
const { createIpcHandlers } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'ipc', 'handlers.js')).href
);

let ctx;
let handlers;
let ids = {};

function writeSkill(dir, name, description, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  );
}

/** 内置 adapter 的目录是 home 下的点目录（cursor → .cursor）；自定义 Agent 用调用方给的目录名。 */
const BUILTIN_DIRS = { cursor: '.cursor', codebuddy: '.codebuddy' };
function agentSkills(agentPlainDir) {
  return path.join(AGENTS, BUILTIN_DIRS[agentPlainDir] ?? agentPlainDir, 'skills');
}

function readMeta(dirName) {
  const file = path.join(LIB, 'sync', `${dirName}.skill.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function silentLogger() {
  return { info: () => undefined, error: () => undefined };
}

function makeHandlers(context, openPath = async () => '') {
  return createIpcHandlers({
    context,
    appInfo: () => ({
      productName: 'Skills 工作台',
      version: '0.1.0',
      appEnv: 'development',
      libraryDir: context.libraryDir,
      dataDir: context.dataDir,
      logDir: path.join(ROOT, 'logs'),
      electron: '39.8.10',
      chrome: '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    }),
    version: '0.1.0',
    mode: 'development',
    pickDirectory: async () => null,
    pickFile: async () => null,
    openPath,
    logger: silentLogger(),
  });
}

before(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const dir of [SKILLS, DATA, TMP, AGENTS, SRC]) fs.mkdirSync(dir, { recursive: true });
  for (const agent of ['claude', 'codex', 'cursor']) {
    fs.mkdirSync(agentSkills(agent), { recursive: true });
  }
  // 产品内置清单只有 codebuddy / cursor；本用例需要 claude-code / codex 作部署目标，写成本机自定义项
  fs.writeFileSync(
    path.join(DATA, 'agents.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        agents: [
          { id: 'claude-code', name: 'Claude Code', skillsDir: agentSkills('claude'), enabled: true, builtin: false },
          { id: 'codex', name: 'Codex', skillsDir: agentSkills('codex'), enabled: true, builtin: false },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  // ── 中心库基线：绿灯技能 / 可复用技能 / 同名异内容技能 ──
  writeSkill(path.join(SRC, 'green-skill'), 'green-skill', '已部署到 Claude 的中心库技能', 'green body');
  writeSkill(path.join(SRC, 'reuse-skill'), 'reuse-skill', '同名同内容应复用', 'reuse body');
  writeSkill(path.join(SRC, 'conflict-skill'), 'conflict-skill', '库内版本 v1', 'library v1');
  writeSkill(path.join(SRC, 'plain-lib'), 'plain-lib', '中心库普通技能', 'plain');

  ctx = AppContext.create({
    libraryDir: LIB,
    dataDir: DATA,
    tempDir: TMP,
    homeDir: AGENTS,
    adapters: selectBuiltinAgents('codebuddy,cursor'),
    appEnv: 'development',
    version: '0.1.0',
    logger: silentLogger(),
  });
  const imported = await ctx.sources.importSkills(
    ctx.sources.discoverFromLocalDir(SRC).items,
  );
  const failed = imported.results.filter((r) => r.status !== 'imported');
  assert.deepEqual(failed, [], '基线技能全部导入成功');
  ids = Object.fromEntries(ctx.library.listSkills().map((s) => [s.dirName, s.skillId]));

  const deployed = await ctx.deploy.syncToAgents([ids['green-skill']], ['claude-code', 'codex']);
  assert.equal(deployed.summary.deployed, 2, '绿灯技能已建链到 claude/codex');

  // ── Agent 目录中的实际内容（灰灯） ──
  writeSkill(path.join(agentSkills('claude'), 'grey-skill'), 'grey-skill', 'Agent 独有技能，入库后应变绿', 'grey body');
  fs.mkdirSync(path.join(agentSkills('claude'), 'grey-skill', 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(agentSkills('claude'), 'grey-skill', 'references', 'note.md'),
    '# note\n\nAgent 原文件内容\n',
    'utf8',
  );
  writeSkill(path.join(agentSkills('claude'), 'conflict-skill'), 'conflict-skill', 'Agent 版本 v2（同名异内容）', 'agent v2');
  writeSkill(path.join(agentSkills('claude'), 'reuse-skill'), 'reuse-skill', '同名同内容应复用', 'reuse body');
  writeSkill(path.join(agentSkills('claude'), 'edit-skill'), 'edit-skill', '未入库技能，编辑原文件', 'edit body');
  fs.mkdirSync(path.join(agentSkills('claude'), 'edit-skill', 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(agentSkills('claude'), 'edit-skill', 'references', 'detail.md'),
    'detail content\n',
    'utf8',
  );
  fs.writeFileSync(path.join(agentSkills('claude'), 'README.md'), 'not a skill\n', 'utf8');
  writeSkill(path.join(agentSkills('codex'), 'codex-grey'), 'codex-grey', 'Codex 灰灯技能', 'codex grey');

  handlers = makeHandlers(ctx);
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
});

after(() => {
  try {
    ctx?.dispose();
  } catch {
    /* 忽略关闭失败 */
  }
});

// ───────────────────────── 状态灯与列表 ─────────────────────────

test('agents:listSkills：绿/灰判定、同名同内容标记、非技能项过滤', () => {
  const list = handlers['agents:listSkills']({ agentId: 'claude-code' });
  assert.equal(list.exists, true);
  assert.equal(list.agentLabel, 'Claude Code');
  const byName = new Map(list.items.map((item) => [item.dirName, item]));
  assert.deepEqual(
    list.items.map((item) => item.dirName),
    ['conflict-skill', 'edit-skill', 'green-skill', 'grey-skill', 'reuse-skill'],
    'README.md 等非技能项不进入列表，按目录名排序',
  );

  const green = byName.get('green-skill');
  assert.equal(green.isManagedLink, true, '指向中心库的链接是绿灯');
  assert.equal(green.linkedSkillId, ids['green-skill']);
  assert.equal(green.inLibrary, true);
  assert.equal(green.status, 'synced', '链接指向中心库 → 已同步');
  assert.ok(green.sizeBytes > 0);

  const grey = byName.get('grey-skill');
  assert.equal(grey.isManagedLink, false);
  assert.equal(grey.inLibrary, false);
  assert.equal(grey.inLibrarySameContent, false);
  assert.equal(grey.status, 'not-in-library');
  assert.match(grey.description, /Agent 独有技能/);

  const conflict = byName.get('conflict-skill');
  assert.equal(conflict.isManagedLink, false);
  assert.equal(conflict.inLibrary, true, '库内已有同名技能');
  assert.equal(conflict.inLibrarySameContent, false, '同名但内容不同');
  assert.equal(conflict.status, 'conflict');

  const reuse = byName.get('reuse-skill');
  assert.equal(reuse.inLibrary, true);
  assert.equal(reuse.inLibrarySameContent, true, '同名同内容可复用');
  assert.equal(reuse.status, 'in-library');

  const codex = handlers['agents:listSkills']({ agentId: 'codex' });
  assert.equal(codex.items.find((item) => item.dirName === 'green-skill').isManagedLink, true);
  const cursor = handlers['agents:listSkills']({ agentId: 'cursor' });
  assert.deepEqual(cursor.items, [], '空目录返回空列表');
  assert.equal(cursor.exists, true);
});

test('agents:listSkills：Agent 不存在/目录不存在返回空态而不是抛错', () => {
  const missingAgent = handlers['agents:listSkills']({ agentId: 'no-such-agent' });
  assert.equal(missingAgent.exists, false);
  assert.deepEqual(missingAgent.items, []);

  const missingDir = path.join(AGENTS, 'cline', 'skills');
  assert.equal(fs.existsSync(missingDir), false);
  const list = handlers['agents:listSkills']({ agentId: 'cline' });
  assert.equal(list.exists, false);
  assert.deepEqual(list.items, []);
});

test('agents:rescan：反映外部新增/删除的技能目录', async () => {
  const appeared = agentSkills('claude');
  writeSkill(path.join(appeared, 'appeared-skill'), 'appeared-skill', '外部新增技能', 'appeared');
  let list = await handlers['agents:rescan']({ agentId: 'claude-code' });
  assert.ok(list.items.some((item) => item.dirName === 'appeared-skill'), '重扫后出现外部新增项');

  fs.rmSync(path.join(appeared, 'appeared-skill'), { recursive: true, force: true });
  list = await handlers['agents:rescan']({ agentId: 'claude-code' });
  assert.ok(!list.items.some((item) => item.dirName === 'appeared-skill'), '重扫后移除外部删除项');
});

// ───────────────────────── 灰灯入库 ─────────────────────────

test('agents:adopt：新建库条目 → 原位置变 junction/symlink，来源为具体 Agent', async () => {
  const target = path.join(agentSkills('claude'), 'grey-skill');
  const beforeHash = hashSkillDir(target);
  const result = await handlers['agents:adopt']({ agentId: 'claude-code', dirName: 'grey-skill' });
  assert.equal(result.status, 'linked');
  assert.ok(result.skillId, '返回新技能 ID');
  assert.ok(['symlink', 'junction'].includes(result.linkType ?? ''));

  const st = fs.lstatSync(target);
  assert.equal(st.isSymbolicLink(), true, '原位置已被替换为链接');
  const resolved = fs.realpathSync(target);
  assert.equal(path.dirname(resolved), fs.realpathSync(SKILLS), '链接指向中心库技能目录');
  assert.equal(fs.existsSync(path.join(target, 'references', 'note.md')), true, '原内容经链接可读');
  assert.equal(hashSkillDir(target), beforeHash, '链接读到的内容与入库前一致');

  assert.equal(ctx.deploy.verifyDeployment(result.skillId, 'claude-code').deployed, true);
  const meta = readMeta('grey-skill');
  assert.equal(meta.source.type, 'agent:claude-code');
  assert.equal(meta.source.origin, ctx.agents.get('claude-code').skillsDir, 'origin=Agent 技能根目录');

  const list = handlers['agents:listSkills']({ agentId: 'claude-code' });
  const row = list.items.find((item) => item.dirName === 'grey-skill');
  assert.equal(row.isManagedLink, true, '成功后该行变绿');
  assert.equal(row.linkedSkillId, result.skillId);

  const library = handlers['library:list']({ query: 'grey-skill' });
  assert.equal(library.total, 1);
  assert.equal(library.items[0].source.type, 'agent:claude-code');
  assert.equal(library.items[0].source.label, 'Claude Code');
  assert.equal(library.items[0].source.origin, ctx.agents.get('claude-code').skillsDir);
  const bySource = handlers['library:list']({ sourceType: 'agent:claude-code' });
  assert.equal(bySource.total, 1, '来源筛选按具体 Agent 名称匹配');
  await ctx.updates.checkAll();
  const managed = handlers['library:list']({ query: 'grey-skill' }).items[0];
  assert.equal(managed.updateAvailable, false, '已被接管的 Agent 链接不提示更新');
  assert.equal(managed.updateCheckStatus, undefined, '已被接管的 Agent 链接不显示检查失败');
});

test('agents:adopt：同名同内容 → 复用库内技能，不新增条目', async () => {
  const beforeCount = ctx.library.listSkills().length;
  const result = await handlers['agents:adopt']({ agentId: 'claude-code', dirName: 'reuse-skill' });
  assert.equal(result.status, 'reused');
  assert.equal(result.skillId, ids['reuse-skill']);
  assert.equal(ctx.library.listSkills().length, beforeCount, '技能数不变');
  assert.equal(fs.lstatSync(path.join(agentSkills('claude'), 'reuse-skill')).isSymbolicLink(), true);
  const row = handlers['agents:listSkills']({ agentId: 'claude-code' }).items.find(
    (item) => item.dirName === 'reuse-skill',
  );
  assert.equal(row.isManagedLink, true);
});

test('agents:adopt：同名异内容 → 失败且原目录哈希/灰灯不变', async () => {
  const target = path.join(agentSkills('claude'), 'conflict-skill');
  const beforeHash = hashSkillDir(target);
  const libraryHash = hashSkillDir(path.join(SKILLS, 'conflict-skill'));
  const beforeList = handlers['agents:listSkills']({ agentId: 'claude-code' });
  const beforeCount = ctx.library.listSkills().length;

  const result = await handlers['agents:adopt']({ agentId: 'claude-code', dirName: 'conflict-skill' });
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /中心库已存在同名但内容不同的 Skill/);
  assert.equal(result.code, 'NAME_CONFLICT');
  assert.equal(hashSkillDir(target), beforeHash, 'Agent 原目录内容零改动');
  assert.equal(hashSkillDir(path.join(SKILLS, 'conflict-skill')), libraryHash, '库内 v1 零改动');
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false, '原位置仍是实体目录');
  assert.equal(ctx.library.listSkills().length, beforeCount, '未新增库条目');

  const after = handlers['agents:listSkills']({ agentId: 'claude-code' }).items.find(
    (item) => item.dirName === 'conflict-skill',
  );
  assert.equal(after.isManagedLink, false, '失败后仍为灰灯');
  assert.equal(beforeList.items.find((item) => item.dirName === 'conflict-skill').isManagedLink, false);
});

// ───────────────────────── agent 源详情与文件读写 ─────────────────────────

test('library:detail(agent)：未入库技能返回真实文件树与「未入库」标记', () => {
  const detail = handlers['library:detail']({
    origin: 'agent',
    agentId: 'claude-code',
    dirName: 'edit-skill',
  });
  assert.equal(detail.origin, 'agent');
  assert.equal(detail.isManagedLink, false);
  assert.equal(detail.skillId, null);
  assert.equal(detail.name, 'edit-skill');
  assert.equal(detail.agentId, 'claude-code');
  assert.equal(detail.agentEntry, 'edit-skill');
  const names = detail.fileTree.children.map((child) => child.name);
  assert.deepEqual(names, ['references', 'SKILL.md'], '文件树包含 SKILL.md 与 references');
  assert.equal(detail.fileTree.children.find((child) => child.name === 'references').children.length, 1);
  assert.ok(detail.contentHash);
  assert.ok(detail.sizeBytes > 0);
});

test('library:readFile/writeFile(agent)：未入库写 Agent 原文件，中心库不受影响', async () => {
  const target = path.join(agentSkills('claude'), 'edit-skill', 'SKILL.md');
  const before = fs.readFileSync(target, 'utf8');
  const read = handlers['library:readFile']({
    origin: 'agent',
    agentId: 'claude-code',
    dirName: 'edit-skill',
    relPath: 'SKILL.md',
  });
  assert.equal(read.editable, true);
  assert.equal(read.content, before);

  const next = before.replace('edit body', 'edited in agent file');
  const written = await handlers['library:writeFile']({
    origin: 'agent',
    agentId: 'claude-code',
    dirName: 'edit-skill',
    relPath: 'SKILL.md',
    content: next,
  });
  assert.equal(written.size, Buffer.byteLength(next, 'utf8'));
  assert.equal(fs.readFileSync(target, 'utf8'), next, '写入落在 Agent 原文件');
  assert.equal(handlers['library:list']({ query: 'edit-skill' }).total, 0, '未入库技能不出现在中心库');

  const nested = handlers['library:readFile']({
    origin: 'agent',
    agentId: 'claude-code',
    dirName: 'edit-skill',
    relPath: 'references/detail.md',
  });
  assert.equal(nested.content, 'detail content\n');
});

test('library:detail/readFile/writeFile(agent)：已入库链接技能读写落中心库', async () => {
  const agentTarget = path.join(agentSkills('claude'), 'grey-skill');
  const libraryTarget = path.join(SKILLS, 'grey-skill');
  const detail = handlers['library:detail']({
    origin: 'agent',
    agentId: 'claude-code',
    dirName: 'grey-skill',
  });
  assert.equal(detail.origin, 'agent');
  assert.equal(detail.isManagedLink, true, '绿灯详情标记为管理中心库文件');
  assert.ok(detail.skillId);

  const read = handlers['library:readFile']({
    origin: 'agent',
    agentId: 'claude-code',
    dirName: 'grey-skill',
    relPath: 'SKILL.md',
  });
  assert.match(read.content ?? '', /grey body/);

  const next = '---\nname: grey-skill\ndescription: Agent 独有技能，入库后应变绿\n---\n\n# grey-skill\n\nedited through link\n';
  const written = await handlers['library:writeFile']({
    origin: 'agent',
    agentId: 'claude-code',
    dirName: 'grey-skill',
    relPath: 'SKILL.md',
    content: next,
  });
  assert.ok(written.contentHash, '写库后返回新的内容哈希');
  assert.equal(fs.readFileSync(path.join(libraryTarget, 'SKILL.md'), 'utf8'), next, '中心库文件已更新');
  assert.equal(fs.readFileSync(path.join(agentTarget, 'SKILL.md'), 'utf8'), next, 'Agent 链接立即读到新内容');
  const meta = readMeta('grey-skill');
  assert.equal(meta.contentHash, written.contentHash, '元数据哈希同步更新');
});

test('agent 源读写：绝对路径/.. 越界被结构化拒绝', async () => {
  assert.throws(
    () =>
      handlers['library:readFile']({
        origin: 'agent',
        agentId: 'claude-code',
        dirName: 'edit-skill',
        relPath: '../conflict-skill/SKILL.md',
      }),
    (err) => err.code === 'PATH_ESCAPE',
  );
  assert.throws(
    () =>
      handlers['library:readFile']({
        origin: 'agent',
        agentId: 'claude-code',
        dirName: 'edit-skill',
        relPath: 'C:/Windows/win.ini',
      }),
    (err) => err.code === 'PATH_ESCAPE',
  );
  assert.throws(
    () =>
      handlers['library:detail']({
        origin: 'agent',
        agentId: 'claude-code',
        dirName: '../codex',
      }),
    (err) => err.code === 'PATH_ESCAPE',
  );
  assert.throws(
    () =>
      handlers['library:readFile']({
        origin: 'agent',
        agentId: 'claude-code',
        dirName: 'grey-skill',
        relPath: '../../conflict-skill/SKILL.md',
      }),
    (err) => err.code === 'PATH_ESCAPE',
    '已入库链接技能同样拒绝越界路径',
  );
  await assert.rejects(
    () => handlers['agents:adopt']({ agentId: 'claude-code', dirName: '../codex/codex-grey' }),
    (err) => err.code === 'PATH_ESCAPE',
  );
  assert.throws(
    () =>
      handlers['library:readFile']({
        origin: 'agent',
        agentId: 'claude-code',
        dirName: 'edit-skill',
        relPath: 'references/missing.md',
      }),
    (err) => err.code === 'FILE_NOT_FOUND',
  );
});

test('回归：中心库详情/读写仍走原路径（origin 缺省=library）', () => {
  const detail = handlers['library:detail']({ skillId: ids['plain-lib'] });
  assert.equal(detail.origin, 'library');
  assert.equal(detail.isManagedLink, false);
  assert.equal(detail.skillId, ids['plain-lib']);
  const read = handlers['library:readFile']({ skillId: ids['plain-lib'], relPath: 'SKILL.md' });
  assert.match(read.content ?? '', /plain-lib/);
});

// ───────────────────────── 打开文件夹 ─────────────────────────

test('agents:openFolder 打开该 Agent 的 skills 目录，失败原因原样回报', async () => {
  const calls = [];
  const recording = makeHandlers(ctx, async (target) => {
    calls.push(target);
    return '';
  });
  const opened = await recording['agents:openFolder']({ agentId: 'claude-code' });
  assert.equal(opened.ok, true);
  assert.equal(opened.path, agentSkills('claude'));
  assert.deepEqual(calls, [agentSkills('claude')], '只打开该 Agent 配置的目录');

  const failing = makeHandlers(ctx, async () => '拒绝访问');
  const failed = await failing['agents:openFolder']({ agentId: 'codex' });
  assert.equal(failed.ok, false);
  assert.equal(failed.path, agentSkills('codex'));
  assert.equal(failed.error, '拒绝访问');

  await assert.rejects(
    () => failing['agents:openFolder']({ agentId: 'not-exist' }),
    (err) => err.code === 'BAD_REQUEST' && /未知的 Agent/.test(err.detail),
  );

  // 目录不存在时不调用系统外壳，直接回报原因
  const away = path.join(AGENTS, 'claude-away');
  fs.renameSync(agentSkills('claude'), away);
  try {
    const missing = await failing['agents:openFolder']({ agentId: 'claude-code' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, '目录不存在');
  } finally {
    fs.renameSync(away, agentSkills('claude'));
  }
});

test('Agents 冲突：查看中心库 → Agent 差异，覆盖只建链且不留备份', async () => {
  const row = handlers['agents:listSkills']({ agentId: 'claude-code' }).items.find((item) => item.dirName === 'conflict-skill');
  assert.equal(row.status, 'conflict');
  assert.equal(row.matchingSkillId, ids['conflict-skill']);
  const plan = await handlers['library:planSyncToAgents']({ skillIds: [row.matchingSkillId], agentIds: ['claude-code'] });
  const item = plan.items[0];
  assert.equal(item.status, 'conflict');
  const diff = await handlers['library:syncDiff']({ skillId: item.skillId, agentId: item.agentId, fingerprint: item.fingerprint, sourceHash: item.sourceHash });
  assert.ok(diff.files.some((file) => file.relPath === 'SKILL.md' && file.status === 'modified'));
  const target = path.join(agentSkills('claude'), 'conflict-skill');
  const skipped = await handlers['agents:resolveConflict']({ skillId: item.skillId, agentId: item.agentId, fingerprint: item.fingerprint, sourceHash: item.sourceHash, choice: 'skip' });
  assert.equal(skipped.status, 'skipped');
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  const result = await handlers['agents:resolveConflict']({ skillId: item.skillId, agentId: item.agentId, fingerprint: item.fingerprint, sourceHash: item.sourceHash, choice: 'overwrite' });
  assert.equal(result.status, 'deployed');
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(target), fs.realpathSync(path.join(SKILLS, 'conflict-skill')));
});
