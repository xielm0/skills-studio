// T03 自动验证（tests/test_cases.md C 组 C-12~C-16 + 幂等 / 递归防护 / Agent 配置 / 锁 / 状态叠加）
// 运行：cd backend && npm run build && node --no-warnings --test tests/t03.test.mjs
// 隔离纪律：本用例每次运行自建 tests/runtime/run-t03-* 私有目录（mkdtemp），库/数据/临时/
// 夹具/模拟 Agent 目录全在里面；不读写 lib-dev、data-dev、agents-mock
// —— 那些是开发态 GUI 在用的目录（backend/.env.development、main.ts:1938）。
// 所有 Agent 目录都指向本用例自建的模拟目录，绝不触碰 ~/.claude/skills、~/.codebuddy/skills 等真实目录。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME = path.join(PROJECT_ROOT, 'tests', 'runtime');
const RUN = fs.mkdtempSync(path.join(RUNTIME, 'run-t03-'));
const LIB = path.join(RUN, 'lib');
const SKILLS = path.join(LIB, 'skills');
const DATA = path.join(RUN, 'data');
const TMP = path.join(RUN, 'tmp');
const AGENTS = path.join(RUN, 'agents-mock');
const SRC = path.join(RUN, 'src');
const EXT = path.join(RUN, 'external');
const ASSETS = path.join(PROJECT_ROOT, 'tests', 'assets');

const {
  SkillLibraryService,
  SkillSourceService,
  AgentConfigService,
  SkillDeployService,
  selectBuiltinAgents,
  defaultSkillsDirFor,
  hashSkillDir,
} = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href);

// 基础设施层：跨进程锁（不属于领域服务出口）
const { WriteLock } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'infra', 'write-lock.js')).href
);

/**
 * 各 Agent 的模拟 skills 目录名。
 * 产品清单只有 2 个内置（CodeBuddy / Cursor）；本用例需要 4 个以上部署目标，
 * 其余 4 个在 before 里以「自定义 Agent」写入本机配置（合法用户态，不是第二份代码清单）。
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
const BUILTIN_IDS = ['codebuddy', 'cursor'];
const AGENT_IDS = Object.keys(AGENT_PLAIN);
const agentSkills = (id) => path.join(AGENTS, AGENT_PLAIN[id], 'skills');

/** 预置本机配置：2 个内置 + 4 个自定义 Agent（目录存在即「已安装」）。 */
function seedAgentsConfig() {
  fs.mkdirSync(DATA, { recursive: true });
  const records = AGENT_IDS.map((id) => ({
    id,
    name: AGENT_NAMES[id],
    skillsDir: agentSkills(id),
    enabled: true,
    builtin: BUILTIN_IDS.includes(id),
  }));
  fs.writeFileSync(
    path.join(DATA, 'agents.json'),
    JSON.stringify({ schemaVersion: 1, agents: records }, null, 2),
    'utf8',
  );
}

let library;
let sources;
let agents;
let lock;
let deploy;
let ids = {};

function writeSkill(dir, name, description, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  );
}

function readMeta(dirName) {
  return JSON.parse(fs.readFileSync(path.join(LIB, 'sync', `${dirName}.skill.json`), 'utf8'));
}

function writeMeta(dirName, mutate) {
  const meta = readMeta(dirName);
  mutate(meta);
  fs.mkdirSync(path.join(LIB, 'sync'), { recursive: true });
  fs.writeFileSync(path.join(LIB, 'sync', `${dirName}.skill.json`), JSON.stringify(meta, null, 2), 'utf8');
}

/** 目标是否是「指向 expected」的链接（lstat + readlink，大小写不敏感）。 */
function assertLinkTo(target, expected) {
  const st = fs.lstatSync(target);
  assert.equal(st.isSymbolicLink(), true, `lstat 判定为链接: ${target}`);
  const resolved = path.resolve(fs.readlinkSync(target));
  assert.equal(resolved.toLowerCase(), path.resolve(expected).toLowerCase(), `readlink 指向库内真身: ${target}`);
}

function listAgentNames(agentId) {
  return fs.readdirSync(agentSkills(agentId)).filter((n) => !n.startsWith('.'));
}

before(async () => {
  // 本次运行目录是 mkdtemp 新建的空目录，不需要删除任何既有数据
  fs.mkdirSync(SKILLS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(EXT, { recursive: true });

  // 6 个模拟 Agent 目录（建在本用例私有目录内）
  for (const id of AGENT_IDS) {
    fs.mkdirSync(agentSkills(id), { recursive: true });
  }

  // 被导入的样本技能（库内真身；adopt-skill 故意不预置，留给灰灯入库场景）
  writeSkill(path.join(SRC, 'hello-skill'), 'hello-skill', 'T03 部署与传播样本', 'hello v1 body');
  writeSkill(path.join(SRC, 'conflict-skill'), 'conflict-skill', 'T03 实体冲突样本', 'conflict body');
  writeSkill(path.join(SRC, 'guard-skill'), 'guard-skill', 'T03 递归防护样本', 'guard body');
  writeSkill(path.join(SRC, 'replace-skill'), 'replace-skill', 'T03 撤下被替换样本', 'replace body');
  writeSkill(path.join(SRC, 'vanish-skill'), 'vanish-skill', 'T03 已丢失样本', 'vanish body');

  library = SkillLibraryService.create({ libraryDir: LIB, dataDir: DATA });
  sources = new SkillSourceService({ library, tempDir: TMP });

  const imported = await sources.importSkills(sources.discoverFromLocalDir(SRC).items);
  for (const r of imported.results) {
    assert.equal(r.status, 'imported', `样本导入成功: ${r.name} → ${r.reason ?? ''}`);
    ids[r.name] = r.skillId;
  }
  // 5 个样本技能已导入（逐项状态见上），库内不应出现重复条目
  assert.equal(
    library.listSkills().filter((s) => Object.values(ids).includes(s.skillId)).length,
    5,
  );

  seedAgentsConfig();
  agents = AgentConfigService.create({
    dataDir: DATA,
    homeDir: AGENTS,
    adapters: selectBuiltinAgents('codebuddy,cursor'),
  });
  lock = new WriteLock({ dataDir: DATA });
  deploy = new SkillDeployService({ library, agents, lock, sources });
  library.setDeploymentProbe(deploy.createProbe());
});

after(() => {
  library?.close();
  // 只清理本用例本次自建的运行目录
  fs.rmSync(RUN, { recursive: true, force: true });
});

// ───────────────────────────── Agent 配置 ─────────────────────────────

test('Agent 配置：6 内置 + 检测 + 自定义增删改 + 设置只落 DATA_DIR', () => {
  const list = agents.list();
  assert.deepEqual(
    list.map((a) => a.id),
    ['cursor', 'codebuddy', 'claude-code', 'codex', 'windsurf', 'cline'],
    '内置 2 个 + 预置自定义 4 个',
  );
  assert.deepEqual(list.filter((a) => a.builtin).map((a) => a.id), ['cursor', 'codebuddy'], '内置 2 个（按清单序）');
  assert.ok(list.every((a) => a.installed === true), '模拟目录存在 → 已安装');
  // 所有目录都在隔离区（默认路径工厂接受 baseDir，绝不取 homedir）
  assert.ok(list.every((a) => a.skillsDir.startsWith(AGENTS)), 'Agent 目录全部位于 agents-mock');

  // 目录被删除 → 重新检测为未安装；恢复后回归
  const clineDir = agentSkills('cline');
  fs.rmSync(clineDir, { recursive: true, force: true });
  assert.equal(agents.redetect().find((a) => a.id === 'cline').installed, false);
  fs.mkdirSync(clineDir, { recursive: true });
  assert.equal(agents.redetect().find((a) => a.id === 'cline').installed, true);

  // 自定义 Agent：新增 / 改目录 / 启停 / 删除
  const customDir = path.join(AGENTS, 'mytool', 'skills');
  const custom = agents.addCustom({ name: 'My Tool', skillsDir: customDir });
  assert.equal(custom.id, 'custom-my-tool', 'id 由名称派生，不带随机编号');
  // 名称唯一：同名（含大小写差异）直接拒绝，不再靠编号区分
  assert.throws(
    () => agents.addCustom({ name: 'my tool', skillsDir: path.join(AGENTS, 'other', 'skills') }),
    (e) => e.code === 'AGENT_NAME_DUPLICATED',
  );
  assert.throws(
    () => agents.addCustom({ name: 'CodeBuddy', skillsDir: path.join(AGENTS, 'other2', 'skills') }),
    (e) => e.code === 'AGENT_NAME_DUPLICATED',
  );
  assert.equal(custom.builtin, false);
  assert.equal(custom.installed, false, '目录不存在 → 未安装');
  fs.mkdirSync(customDir, { recursive: true });
  assert.equal(agents.redetect().find((a) => a.id === custom.id).installed, true);

  const moved = agents.updateDir(custom.id, path.join(AGENTS, 'mytool2', 'skills'));
  assert.equal(moved.skillsDir, path.join(AGENTS, 'mytool2', 'skills'));
  assert.equal(agents.setEnabled(custom.id, false).enabled, false);
  assert.ok(!agents.syncTargets().some((a) => a.id === custom.id), '停用后不是同步目标');
  assert.throws(() => agents.updateDir(custom.id, 'relative/dir'), (e) => e.code === 'AGENT_INVALID_DIR');
  assert.equal(agents.removeCustom(custom.id), true);
  assert.equal(agents.get(custom.id), null);
  assert.throws(() => agents.removeCustom('codebuddy'), (e) => e.code === 'AGENT_BUILTIN_IMMUTABLE');

  // 本机设置不进库、不进 Git
  assert.ok(fs.existsSync(path.join(DATA, 'agents.json')));
  assert.ok(!fs.existsSync(path.join(LIB, 'agents.json')));

  // 默认路径工厂：目录只由 homeDir + adapter 自带的相对目录决定
  assert.equal(defaultSkillsDirFor('codebuddy', AGENTS), agentSkills('codebuddy'));
  assert.equal(
    defaultSkillsDirFor('codebuddy', path.join(RUN, 'home-mock')),
    path.join(RUN, 'home-mock', '.codebuddy', 'skills'),
  );
});

// ───────────────────────── C-12 部署与兜底 ─────────────────────────

test('C-12 部署：symlink 优先，失败后 junction 兜底；lstat + readlink 判定正确', async () => {
  const res = await deploy.syncToAgents([ids['hello-skill']], ['codebuddy']);
  assert.equal(res.items.length, 1);
  const item = res.items[0];
  assert.equal(item.status, 'deployed', item.reason ?? '');
  assert.ok(['symlink', 'junction'].includes(item.linkType), `实际链接形态: ${item.linkType}`);
  assert.equal(res.summary.deployed, 1);

  const target = item.targetPath;
  assert.equal(target, path.join(agentSkills('codebuddy'), 'hello-skill'));
  assertLinkTo(target, path.join(SKILLS, 'hello-skill'));

  // 本机实测：未开开发者模式 → symlink 抛 EPERM 后 junction 成功（两种都算通过，但要如实记录）
  if (item.linkType === 'junction') {
    assert.ok(item.symlinkErrorCode, 'junction 兜底必须记录 symlink 的失败错误码');
    assert.throws(
      () => {
        const probePath = path.join(RUN, 'symlink-probe');
        fs.rmSync(probePath, { recursive: true, force: true });
        fs.symlinkSync(path.join(SKILLS, 'hello-skill'), probePath, 'dir');
        fs.rmSync(probePath, { force: true });
      },
      (err) => err.code === item.symlinkErrorCode,
      '同环境直接 symlink 应复现同一错误码',
    );
  }

  // 通过链接读到的就是库内真身内容
  assert.equal(
    fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(SKILLS, 'hello-skill', 'SKILL.md'), 'utf8'),
  );

  // 意图写入元数据（随库进 Git），并发过 deploy-status 事件
  assert.ok(readMeta('hello-skill').sync.agents.includes('codebuddy'), '同步意图已记录');
  assert.equal(library.getRecentActivity().find((e) => e.skillId === ids['hello-skill']).type, 'deploy-status');

  // 部署状态叠加：deployedAgents = 意图 ∩ 实际链接
  const summary = library.listSkills().find((s) => s.dirName === 'hello-skill');
  assert.deepEqual(summary.deployedAgents, ['codebuddy']);
  assert.deepEqual(summary.configuredAgents, ['codebuddy']);
  assert.equal(summary.configuredNotDeployed, false);
});

// ───────────────────────── C-13 即时传播 ─────────────────────────

test('C-13 即时传播：改库内 SKILL.md → Agent 路径立即读到新内容（同源）', () => {
  const libFile = path.join(SKILLS, 'hello-skill', 'SKILL.md');
  const agentFile = path.join(agentSkills('codebuddy'), 'hello-skill', 'SKILL.md');
  const before = hashSkillDir(path.join(SKILLS, 'hello-skill'));

  const updated = '---\nname: hello-skill\ndescription: T03 传播后的描述\n---\n\n# hello-skill\n\n传播后内容 v2\n';
  fs.writeFileSync(libFile, updated, 'utf8');
  assert.equal(fs.readFileSync(agentFile, 'utf8'), updated, 'Agent 目录读到新内容（无拷贝、无重新部署）');
  assert.notEqual(hashSkillDir(path.join(SKILLS, 'hello-skill')), before);
  assertLinkTo(agentFile.replace(/[\\/]SKILL\.md$/, ''), path.join(SKILLS, 'hello-skill'));
});

// ───────────────────────── C-14 实体冲突零改动 ─────────────────────────

test('C-14 冲突零改动：实体目录 / 指向别处的链接 → conflict，双方内容零变化', async () => {
  // ① 实体目录
  const realDir = path.join(agentSkills('claude-code'), 'conflict-skill');
  writeSkill(realDir, 'conflict-skill', 'Agent 侧实体目录', 'agent local body');
  fs.writeFileSync(path.join(realDir, 'notes.txt'), 'local note', 'utf8');
  const targetHashBefore = hashSkillDir(realDir);
  const libHashBefore = hashSkillDir(path.join(SKILLS, 'conflict-skill'));
  const eventsBefore = library.getActivityCount();

  const conflict = await deploy.deployOne(ids['conflict-skill'], 'claude-code');
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.code, 'TARGET_CONFLICT');
  assert.deepEqual(conflict.conflict, { targetType: 'dir', actualTarget: null });
  assert.equal(fs.lstatSync(realDir).isSymbolicLink(), false, '目标仍是实体目录');
  assert.equal(hashSkillDir(realDir), targetHashBefore, '目标内容零改动');
  assert.equal(hashSkillDir(path.join(SKILLS, 'conflict-skill')), libHashBefore, '库内零改动');
  assert.equal(library.getActivityCount(), eventsBefore, '冲突不产生事件');
  assert.ok(!readMeta('conflict-skill').sync.agents.includes('claude-code'), '冲突不写意图');

  // ② 指向别处的链接（外部目录，绝不能被删/被覆盖）
  const externalDir = path.join(EXT, 'external-skill');
  writeSkill(externalDir, 'external-skill', '外部目录技能', 'external body');
  const elsewhere = path.join(agentSkills('cursor'), 'conflict-skill');
  fs.symlinkSync(externalDir, elsewhere, 'junction');
  const externalHash = hashSkillDir(externalDir);

  const conflict2 = await deploy.deployOne(ids['conflict-skill'], 'cursor');
  assert.equal(conflict2.status, 'conflict');
  assert.equal(conflict2.conflict.targetType, 'link-elsewhere');
  assert.equal(
    path.resolve(conflict2.conflict.actualTarget).toLowerCase(),
    path.resolve(externalDir).toLowerCase(),
    '冲突结果给出实际指向',
  );
  assert.equal(hashSkillDir(externalDir), externalHash, '外部目标内容零改动');
  assertLinkTo(elsewhere, externalDir);
});

// ───────────────────────── C-15 撤下只删链接 ─────────────────────────

test('C-15 撤下：只删链接、库内真身完好；被替换为实体目录时拒绝删除', async () => {
  const libDir = path.join(SKILLS, 'hello-skill');
  const libHashBefore = hashSkillDir(libDir);
  const target = path.join(agentSkills('codebuddy'), 'hello-skill');

  const removed = await deploy.undeploy(ids['hello-skill'], 'codebuddy');
  assert.equal(removed.status, 'removed', removed.reason ?? '');
  assert.ok(['unlink', 'rmdir'].includes(removed.removedVia), `实际删除方式: ${removed.removedVia}`);
  assert.equal(fs.existsSync(target), false, '链接已消失');
  assert.equal(hashSkillDir(libDir), libHashBefore, '库内真身零影响');
  assert.ok(fs.existsSync(path.join(libDir, 'SKILL.md')));
  assert.ok(!readMeta('hello-skill').sync.agents.includes('codebuddy'), '撤下同步移除意图');

  // 目标已被替换为实体目录 → 不删、如实报告
  const replaceTarget = path.join(agentSkills('cline'), 'replace-skill');
  const first = await deploy.deployOne(ids['replace-skill'], 'cline');
  assert.equal(first.status, 'deployed');
  fs.unlinkSync(replaceTarget); // 模拟用户替换（先移除链接）
  writeSkill(replaceTarget, 'replace-skill', '用户自己换成了实体目录', 'user replaced body');
  const replacedHash = hashSkillDir(replaceTarget);

  const replaced = await deploy.undeploy(ids['replace-skill'], 'cline');
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.code, 'TARGET_REPLACED');
  assert.ok(replaced.reason.includes('需人工处理'));
  assert.equal(hashSkillDir(replaceTarget), replacedHash, '实体目录原样保留');
  assert.ok(readMeta('replace-skill').sync.agents.includes('cline'), '未真正撤下，保留意图供人工处理');

  // 指向别处的链接 → 同样拒绝删除并提示（绝不删掉别人建的东西）
  const otherDir = path.join(EXT, 'other-target');
  writeSkill(otherDir, 'other-target', '别人建的链接目标', 'other body');
  const otherLink = path.join(agentSkills('windsurf'), 'replace-skill');
  fs.symlinkSync(otherDir, otherLink, 'junction');
  const otherHash = hashSkillDir(otherDir);
  const replaced2 = await deploy.undeploy(ids['replace-skill'], 'windsurf');
  assert.equal(replaced2.status, 'replaced');
  assertLinkTo(otherLink, otherDir);
  assert.equal(hashSkillDir(otherDir), otherHash, '别人的链接目标零改动');
  fs.unlinkSync(otherLink);

  // 不存在目标 → 幂等 no-op
  const noop = await deploy.undeploy(ids['replace-skill'], 'codex');
  assert.equal(noop.status, 'noop');
});

// ───────────────────────── 幂等 / 递归防护 ─────────────────────────

test('幂等：重复部署 → already，不产生第二份链接；重复撤下 → no-op', async () => {
  const first = await deploy.deployOne(ids['hello-skill'], 'codex');
  assert.equal(first.status, 'deployed');
  const second = await deploy.deployOne(ids['hello-skill'], 'codex');
  assert.equal(second.status, 'already');
  assert.equal(
    listAgentNames('codex').filter((n) => n === 'hello-skill').length,
    1,
    '只有一份链接',
  );
  assertLinkTo(path.join(agentSkills('codex'), 'hello-skill'), path.join(SKILLS, 'hello-skill'));

  assert.equal((await deploy.undeploy(ids['hello-skill'], 'codex')).status, 'removed');
  assert.equal((await deploy.undeploy(ids['hello-skill'], 'codex')).status, 'noop');
});

test('递归防护：目标等于源 / 位于源内部 → 拒绝建链', async () => {
  // 目标 = 源（把 Agent skillsDir 指成库 skills 目录本身）
  const sameDir = agents.addCustom({ name: 'Self Same', skillsDir: SKILLS });
  const r1 = await deploy.deployOne(ids['guard-skill'], sameDir.id);
  assert.equal(r1.status, 'failed');
  assert.equal(r1.code, 'RECURSIVE_TARGET');

  // 目标位于源内部（skillsDir 指到技能目录里面）
  const inner = path.join(SKILLS, 'guard-skill', 'inner');
  fs.mkdirSync(inner, { recursive: true });
  const innerAgent = agents.addCustom({ name: 'Self Inner', skillsDir: inner });
  const r2 = await deploy.deployOne(ids['guard-skill'], innerAgent.id);
  assert.equal(r2.status, 'failed');
  assert.equal(r2.code, 'RECURSIVE_TARGET');
  assert.equal(fs.existsSync(r2.targetPath), false, '拒绝后不留下任何链接');
  fs.rmSync(inner, { recursive: true, force: true });

  assert.equal(agents.removeCustom(sameDir.id), true);
  assert.equal(agents.removeCustom(innerAgent.id), true);
  // 库内技能未被污染
  assert.equal(fs.existsSync(path.join(SKILLS, 'guard-skill', 'inner')), false);
});

// ───────────────────────── 部署状态叠加 / 未执行意图 / 停用 ─────────────────────────

test('部署状态叠加：意图 ∩ 实际链接；链接缺失 → configuredNotDeployed + 待执行意图', async () => {
  // 部署到 codebuddy，再外部删掉链接 → 意图在、链接缺失
  assert.equal((await deploy.deployOne(ids['hello-skill'], 'codebuddy')).status, 'deployed');
  fs.unlinkSync(path.join(agentSkills('codebuddy'), 'hello-skill'));

  const s1 = library.listSkills().find((s) => s.dirName === 'hello-skill');
  assert.deepEqual(s1.deployedAgents, [], '实际链接缺失 → 不算已部署');
  assert.ok(s1.configuredAgents.includes('codebuddy'), '意图仍在本机有效配置中');
  assert.equal(s1.configuredNotDeployed, true, 'UI 显示「已配置、未执行」');

  const pending = deploy.listPendingIntents();
  const cb = pending.find((p) => p.agentId === 'codebuddy');
  assert.ok(cb, '待执行意图列出');
  assert.ok(cb.skills.some((s) => s.skillId === ids['hello-skill']));

  // 跨机意图：直接写元数据模拟从远端拉取 → 只显示不自动部署
  writeMeta('conflict-skill', (m) => {
    m.sync = { agents: ['windsurf'] };
  });
  const remoteLink = path.join(agentSkills('windsurf'), 'conflict-skill');
  assert.equal(fs.existsSync(remoteLink), false, '本机不自动部署远端意图');
  const s2 = library.listSkills().find((s) => s.dirName === 'conflict-skill');
  assert.deepEqual(s2.deployedAgents, []);
  assert.deepEqual(s2.configuredAgents, ['windsurf']);
  assert.equal(s2.configuredNotDeployed, true);
  assert.ok(deploy.listPendingIntents().some((p) => p.agentId === 'windsurf' && p.skills.some((x) => x.dirName === 'conflict-skill')));
  writeMeta('conflict-skill', (m) => {
    m.sync = { agents: [] };
  });

  // 一键执行后待执行为空
  const executed = await deploy.deployOne(ids['hello-skill'], 'codebuddy');
  assert.equal(executed.status, 'deployed');
  const s3 = library.listSkills().find((s) => s.dirName === 'hello-skill');
  assert.deepEqual(s3.deployedAgents, ['codebuddy']);
  assert.equal(s3.configuredNotDeployed, false);
  assert.equal(
    deploy.listPendingIntents().some((p) => p.agentId === 'codebuddy' && p.skills.some((x) => x.dirName === 'hello-skill')),
    false,
  );
});

test('停用 Agent：已有链接保留，但不再是同步目标（部署被 skipped）', async () => {
  const target = path.join(agentSkills('codebuddy'), 'hello-skill');
  assert.ok(fs.existsSync(target));

  agents.setEnabled('codebuddy', false);
  assert.ok(!agents.syncTargets().some((a) => a.id === 'codebuddy'));

  const skipped = await deploy.deployOne(ids['hello-skill'], 'codebuddy');
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.code, 'AGENT_DISABLED');
  assert.ok(fs.existsSync(target), '停用不撤下已有链接');
  assertLinkTo(target, path.join(SKILLS, 'hello-skill'));

  // 链接仍在 → Agent 视图仍为绿灯；但中心库部署摘要不再把停用 Agent 算作有效配置
  const entries = deploy.listAgentSkills('codebuddy');
  assert.equal(entries.find((e) => e.name === 'hello-skill').entryType, 'link-to-library');
  const summary = library.listSkills().find((s) => s.dirName === 'hello-skill');
  assert.deepEqual(summary.deployedAgents, ['codebuddy'], '链接真实存在');
  assert.ok(!summary.configuredAgents.includes('codebuddy'), '停用后不算有效配置');

  agents.setEnabled('codebuddy', true);
});

// ───────────────────────── Agent Tab 数据（绿 / 灰灯） ─────────────────────────

test('Agent 视图：绿/灰灯分类 + 外部增删实时反映 + 库内丢失标记', () => {
  const cbDir = agentSkills('codebuddy');
  writeSkill(path.join(cbDir, 'gray-skill'), 'gray-skill', '灰灯实体目录', 'gray body');
  fs.writeFileSync(path.join(cbDir, 'notes.txt'), 'not a skill', 'utf8');
  const elsewhereDir = path.join(EXT, 'elsewhere-skill');
  writeSkill(elsewhereDir, 'elsewhere-skill', '指向外部', 'elsewhere body');
  fs.symlinkSync(elsewhereDir, path.join(cbDir, 'elsewhere-link'), 'junction');

  let entries = deploy.listAgentSkills('codebuddy');
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

  assert.equal(byName['hello-skill'].entryType, 'link-to-library');
  assert.equal(byName['hello-skill'].isLibraryLink, true);
  assert.equal(byName['hello-skill'].skillId, ids['hello-skill']);
  assert.equal(byName['hello-skill'].missing, false);

  assert.equal(byName['gray-skill'].entryType, 'real-dir');
  assert.equal(byName['gray-skill'].isLibraryLink, false);
  assert.equal(byName['notes.txt'].entryType, 'real-file');
  assert.equal(byName['elsewhere-link'].entryType, 'link-elsewhere');
  assert.equal(byName['elsewhere-link'].isLibraryLink, false);
  assert.ok(!entries.some((e) => e.name.startsWith('.adopt-old-')), '暂存位不出现在视图');

  // 外部增删在调用时实时反映（无缓存）
  writeSkill(path.join(cbDir, 'appeared-skill'), 'appeared-skill', '外部新增', 'new body');
  assert.ok(deploy.listAgentSkills('codebuddy').some((e) => e.name === 'appeared-skill'));
  fs.rmSync(path.join(cbDir, 'appeared-skill'), { recursive: true, force: true });
  assert.ok(!deploy.listAgentSkills('codebuddy').some((e) => e.name === 'appeared-skill'));

  // 撤下时清理测试用灰灯项
  fs.rmSync(path.join(cbDir, 'gray-skill'), { recursive: true, force: true });
  fs.rmSync(path.join(cbDir, 'notes.txt'), { force: true });
  fs.unlinkSync(path.join(cbDir, 'elsewhere-link'));
});

test('库内技能被删除：Agent 视图标已丢失（复用 T01 语义）', async () => {
  assert.equal((await deploy.deployOne(ids['vanish-skill'], 'cline')).status, 'deployed');
  const backup = path.join(SRC, 'vanish-skill');
  fs.rmSync(path.join(SKILLS, 'vanish-skill'), { recursive: true, force: true });
  await library.rescan();

  const entry = deploy.listAgentSkills('cline').find((e) => e.name === 'vanish-skill');
  assert.equal(entry.entryType, 'link-to-library');
  assert.equal(entry.missing, true, '库内真身丢失 → 视图标记');
  assert.equal(entry.skillId, ids['vanish-skill'], 'ID 保留');

  // 复原（外部放回）后状态自动回归
  fs.cpSync(backup, path.join(SKILLS, 'vanish-skill'), { recursive: true });
  await library.rescan();
  assert.equal(deploy.listAgentSkills('cline').find((e) => e.name === 'vanish-skill').missing, false);
});

// ───────────────────────── C-16 灰灯入库 ─────────────────────────

test('C-16 灰灯入库：实体技能目录 → 入库 + 原位置变受管理链接 + 内容经链接可读', async () => {
  const agentDir = agentSkills('cursor');
  const src = path.join(agentDir, 'adopt-skill');
  writeSkill(src, 'adopt-skill', '灰灯入库样本', 'adopt body');
  fs.mkdirSync(path.join(src, 'references'), { recursive: true });
  fs.writeFileSync(path.join(src, 'references', 'ref.md'), 'ref content', 'utf8');
  const srcHash = hashSkillDir(src);
  const countBefore = library.listSkills().length;

  const results = await deploy.adoptExisting('cursor', ['adopt-skill']);
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.status, 'adopted', r.reason ?? '');
  assert.equal(r.reused, false);
  assert.ok(r.skillId);

  // 库内新增且内容一致、来源记具体 Agent
  assert.equal(library.listSkills().length, countBefore + 1);
  const adopted = library.getSkillDetail(r.skillId);
  assert.equal(adopted.dirName, 'adopt-skill');
  assert.equal(adopted.contentHash, srcHash);
  assert.equal(adopted.source.type, 'agent:cursor');
  assert.equal(adopted.source.origin, agentDir);
  assert.equal(adopted.source.sourceRelPath, 'adopt-skill');

  // 原位置变成指向库内的受管理链接，内容经链接可读
  const target = path.join(agentDir, 'adopt-skill');
  assertLinkTo(target, path.join(SKILLS, 'adopt-skill'));
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(SKILLS, 'adopt-skill', 'SKILL.md'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(target, 'references', 'ref.md'), 'utf8'), 'ref content');
  // 暂存位已清理
  assert.ok(!fs.readdirSync(agentDir).some((n) => n.startsWith('.adopt-old-')));
  // 意图已记录（入库即部署）
  assert.ok(readMeta('adopt-skill').sync.agents.includes('cursor'));
  assert.equal(library.listSkills().find((s) => s.dirName === 'adopt-skill').deployedAgents.includes('cursor'), true);
});

test('C-16 同名同内容：复用库内技能，不复制、不新增', async () => {
  const agentDir = agentSkills('windsurf');
  fs.cpSync(path.join(SKILLS, 'adopt-skill'), path.join(agentDir, 'adopt-skill'), { recursive: true });
  const countBefore = library.listSkills().length;

  const [r] = await deploy.adoptExisting('windsurf', ['adopt-skill']);
  assert.equal(r.status, 'adopted', r.reason ?? '');
  assert.equal(r.reused, true, '复用已有技能');
  assert.equal(library.listSkills().length, countBefore, '库内数量不变');
  assertLinkTo(path.join(agentDir, 'adopt-skill'), path.join(SKILLS, 'adopt-skill'));
  assert.ok(!fs.readdirSync(agentDir).some((n) => n.startsWith('.adopt-old-')));
});

test('C-16 同名异内容：直接失败，库与 Agent 原位置零改动', async () => {
  const agentDir = agentSkills('cline');
  const src = path.join(agentDir, 'adopt-skill');
  writeSkill(src, 'adopt-skill', '同名但内容不同', 'totally different body');
  const srcHash = hashSkillDir(src);
  const libHash = hashSkillDir(path.join(SKILLS, 'adopt-skill'));
  const countBefore = library.listSkills().length;

  const [r] = await deploy.adoptExisting('cline', ['adopt-skill']);
  assert.equal(r.status, 'failed');
  assert.equal(r.code, 'NAME_CONFLICT');
  assert.ok(r.reason.includes('中心库已存在同名但内容不同的 Skill'), r.reason);
  assert.equal(hashSkillDir(src), srcHash, 'Agent 原位置零改动');
  assert.equal(fs.lstatSync(src).isSymbolicLink(), false, '仍是实体目录');
  assert.equal(hashSkillDir(path.join(SKILLS, 'adopt-skill')), libHash, '库内零改动');
  assert.equal(library.listSkills().length, countBefore);
});

test('C-16 失败注入（暂存后建链失败）→ 恢复原位置 + 撤销库内新增，且恢复经校验', async () => {
  const failing = new SkillDeployService({
    library,
    agents,
    lock,
    sources,
    adoptFailPoint: 'after-stage',
  });

  const agentDir = agentSkills('claude-code');
  const src = path.join(agentDir, 'inject-skill');
  writeSkill(src, 'inject-skill', '失败注入样本', 'inject body');
  const srcHash = hashSkillDir(src);
  const countBefore = library.listSkills().length;

  const [r] = await failing.adoptExisting('claude-code', ['inject-skill']);
  assert.equal(r.status, 'failed');
  assert.equal(r.restored, true, '回滚必须经过校验并确认恢复');
  assert.equal(r.code, 'ADOPT_FAILED', `code=${r.code} reason=${r.reason}`);

  // 原位置恢复为实体目录，内容一致
  assert.equal(fs.lstatSync(src).isSymbolicLink(), false);
  assert.equal(hashSkillDir(src), srcHash, '原位置内容恢复');
  // 库内无残留（目录 + 元数据 + 索引）
  assert.equal(library.listSkills().length, countBefore);
  assert.ok(!fs.existsSync(path.join(SKILLS, 'inject-skill')));
  assert.ok(!fs.existsSync(path.join(LIB, 'sync', 'inject-skill.skill.json')));
  // 无暂存残留
  assert.ok(!fs.readdirSync(agentDir).some((n) => n.startsWith('.adopt-old-')));

  // ── 建链成功后失败（after-link）：链接被撤、原位置恢复 ──
  const failing2 = new SkillDeployService({ library, agents, lock, sources, adoptFailPoint: 'after-link' });
  const src2 = path.join(agentDir, 'inject-link-skill');
  writeSkill(src2, 'inject-link-skill', '建链后失败样本', 'inject link body');
  const hash2 = hashSkillDir(src2);
  const count2 = library.listSkills().length;

  const [r2] = await failing2.adoptExisting('claude-code', ['inject-link-skill']);
  assert.equal(r2.status, 'failed');
  assert.equal(r2.restored, true);
  assert.equal(fs.lstatSync(src2).isSymbolicLink(), false, '失败时已建的链接被撤销');
  assert.equal(hashSkillDir(src2), hash2);
  assert.equal(library.listSkills().length, count2);
  assert.ok(!fs.existsSync(path.join(SKILLS, 'inject-link-skill')));
  assert.ok(!fs.readdirSync(agentDir).some((n) => n.startsWith('.adopt-old-')));
});

test('C-16 原位置是指向外部目录的链接：只替换链接本身，绝不删除其目标内容', async () => {
  const externalDir = path.join(EXT, 'linked-skill');
  writeSkill(externalDir, 'linked-skill', '外部链接目标', 'linked body');
  const agentDir = agentSkills('codex');
  const linkPath = path.join(agentDir, 'linked-skill');
  fs.symlinkSync(externalDir, linkPath, 'junction');

  const [r] = await deploy.adoptExisting('codex', ['linked-skill']);
  assert.equal(r.status, 'adopted', r.reason ?? '');

  // 外部目标内容原地完好
  assert.equal(fs.readFileSync(path.join(externalDir, 'SKILL.md'), 'utf8').includes('linked body'), true);
  assert.equal(fs.lstatSync(externalDir).isSymbolicLink(), false);
  // 原位置变成指向库内的链接
  assertLinkTo(linkPath, path.join(SKILLS, 'linked-skill'));
  assert.ok(!fs.readdirSync(agentDir).some((n) => n.startsWith('.adopt-old-')));

  // 失败注入下的同一场景：原链接必须恢复（而不是被删成空位）
  const externalDir2 = path.join(EXT, 'linked-fail-skill');
  writeSkill(externalDir2, 'linked-fail-skill', '外部链接目标（失败注入）', 'linked fail body');
  const linkPath2 = path.join(agentSkills('windsurf'), 'linked-fail-skill');
  fs.symlinkSync(externalDir2, linkPath2, 'junction');
  const countBefore = library.listSkills().length;

  const failing = new SkillDeployService({ library, agents, lock, sources, adoptFailPoint: 'after-stage' });
  const [r2] = await failing.adoptExisting('windsurf', ['linked-fail-skill']);
  assert.equal(r2.status, 'failed');
  assert.equal(r2.restored, true);
  assertLinkTo(linkPath2, externalDir2);
  assert.equal(fs.readFileSync(path.join(externalDir2, 'SKILL.md'), 'utf8').includes('linked fail body'), true);
  assert.equal(library.listSkills().length, countBefore);
  assert.ok(!fs.existsSync(path.join(SKILLS, 'linked-fail-skill')));
});

// ───────────────────────── 锁 ─────────────────────────

test('同进程并发部署排队串行：无损坏、只有一份链接', async () => {
  const target = path.join(agentSkills('windsurf'), 'guard-skill');
  const [a, b] = await Promise.all([
    deploy.deployOne(ids['guard-skill'], 'windsurf'),
    deploy.deployOne(ids['guard-skill'], 'windsurf'),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['already', 'deployed'], '两次并发：一次建链、一次幂等');
  assertLinkTo(target, path.join(SKILLS, 'guard-skill'));
  assert.equal(listAgentNames('windsurf').filter((n) => n === 'guard-skill').length, 1);

  // 队列不会因为并发而卡死：后续写操作照常
  assert.equal((await deploy.undeploy(ids['guard-skill'], 'windsurf')).status, 'removed');
});

test('库内真身零影响：全流程结束后库内容与导入时一致（除 C-13 的显式修改）', () => {
  // 除 hello-skill 在 C-13 被显式改过，其余技能的目录内容必须与源一致
  for (const dirName of ['conflict-skill', 'guard-skill', 'replace-skill', 'vanish-skill']) {
    assert.equal(
      hashSkillDir(path.join(SKILLS, dirName)),
      hashSkillDir(path.join(SRC, dirName)),
      `${dirName} 库内内容未被部署/撤下/入库流程改动`,
    );
  }
  // 库内没有暂存残留 / 链接形态的伪技能
  assert.ok(fs.readdirSync(SKILLS).every((n) => !n.startsWith('.adopt-old-') && !n.startsWith('.staging-')));
});

test('中心库同步冲突：相同内容自动接管，异内容逐项覆盖或跳过，不保留持久备份', async () => {
  const name = 'sync-choice-skill';
  const source = path.join(SRC, name);
  writeSkill(source, name, '同步选择样本', 'center version');
  const imported = await sources.importSkills([{ path: source, source: { type: 'local-dir', origin: SRC } }]);
  assert.equal(imported.results[0].status, 'imported');
  const skillId = imported.results[0].skillId;
  const libDir = path.join(SKILLS, name);
  fs.writeFileSync(path.join(libDir, 'center-only.md'), 'center only');
  fs.writeFileSync(path.join(libDir, 'blob.bin'), Buffer.from([0, 1, 2]));
  const addAgent = (label) => {
    const skillsDir = path.join(AGENTS, `choice-${label}`, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const agent = agents.addCustom({ name: `Choice ${label}`, skillsDir });
    agents.redetect();
    return { id: agent.id, target: path.join(skillsDir, name) };
  };
  const same = addAgent('same');
  const changed = addAgent('changed');
  const skipped = addAgent('skipped');
  fs.cpSync(libDir, same.target, { recursive: true });
  writeSkill(changed.target, name, 'Agent 版本', 'changed version');
  fs.writeFileSync(path.join(changed.target, 'agent-only.md'), 'agent only');
  fs.writeFileSync(path.join(changed.target, 'blob.bin'), Buffer.from([0, 3, 4]));
  writeSkill(skipped.target, name, 'Agent 版本', 'skip version');

  const plan = await deploy.planSyncToAgents([skillId], [same.id, changed.id, skipped.id]);
  assert.deepEqual(plan.map((item) => item.status), ['same-content', 'conflict', 'conflict']);
  const diffRequest = { skillId, agentId: changed.id, fingerprint: plan[1].fingerprint, sourceHash: plan[1].sourceHash };
  const diff = await deploy.syncDiff(diffRequest);
  assert.equal(diff.stale, false);
  assert.deepEqual(diff.files.map((file) => [file.relPath, file.status]), [
    ['SKILL.md', 'modified'], ['agent-only.md', 'removed'], ['blob.bin', 'modified'], ['center-only.md', 'added'],
  ]);
  const binary = await deploy.syncDiff({ ...diffRequest, relPath: 'blob.bin' });
  assert.equal(binary.source.reason, 'BINARY');
  assert.equal(binary.target.reason, 'BINARY');
  const changedFile = await deploy.syncDiff({ ...diffRequest, relPath: 'SKILL.md' });
  assert.match(changedFile.source.content, /center version/);
  assert.match(changedFile.target.content, /changed version/);
  const addedFile = await deploy.syncDiff({ ...diffRequest, relPath: 'center-only.md' });
  assert.equal(addedFile.target, null);
  assert.equal(addedFile.source.content, 'center only');
  const staleChoice = {
    skillId, agentId: changed.id, choice: 'overwrite',
    fingerprint: plan[1].fingerprint, sourceHash: plan[1].sourceHash,
  };
  writeSkill(changed.target, name, 'Agent 新修改', 'newer version');
  assert.equal((await deploy.syncDiff(diffRequest)).stale, true);
  const newerHash = hashSkillDir(changed.target);
  const stale = await deploy.syncToAgentsResolved([skillId], [changed.id], [staleChoice]);
  assert.equal(stale.items[0].status, 'conflict');
  assert.equal(hashSkillDir(changed.target), newerHash);
  assert.equal(fs.lstatSync(changed.target).isSymbolicLink(), false);

  const fresh = await deploy.planSyncToAgents([skillId], [same.id, changed.id, skipped.id]);
  const skippedHash = hashSkillDir(skipped.target);
  const result = await deploy.syncToAgentsResolved([skillId], [same.id, changed.id, skipped.id], [
    { skillId, agentId: changed.id, choice: 'overwrite', fingerprint: fresh[1].fingerprint, sourceHash: fresh[1].sourceHash },
    { skillId, agentId: skipped.id, choice: 'skip', fingerprint: fresh[2].fingerprint, sourceHash: fresh[2].sourceHash },
  ]);
  assert.deepEqual(result.items.map((item) => item.status), ['deployed', 'deployed', 'skipped']);
  assertLinkTo(same.target, libDir);
  assertLinkTo(changed.target, libDir);
  assert.equal(hashSkillDir(skipped.target), skippedHash);
  assert.equal(fs.lstatSync(skipped.target).isSymbolicLink(), false);
  // 覆盖不保留持久备份：结果不带备份路径，DATA 下也不产生 deploy-backups 目录
  assert.equal(result.items[1].backupPath, undefined);
  assert.equal(fs.existsSync(path.join(DATA, 'deploy-backups')), false);
});
