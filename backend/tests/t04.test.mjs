// T04 自动验证（tests/test_cases.md C-17~C-21 + 协议标记 / pin / 结果树校验 / 纯函数决策）
// 运行：cd backend && npm run build && node --no-warnings --test tests/t04.test.mjs
// 隔离纪律：两台「机器」= tests/runtime/t04/{lib-a,lib-b} + 各自的 DATA_DIR；
// 远端只用 tests/runtime/t04/remote.git（本地 bare 仓库），绝无网络请求，
// 也绝不读写真实 Agent 技能目录或真实用户库。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME = path.join(PROJECT_ROOT, 'tests', 'runtime');
const BASE = path.join(RUNTIME, 't04');
const REMOTE = path.join(BASE, 'remote.git');
const SRC = path.join(BASE, 'src-skills');
const TMP = path.join(BASE, 'tmp');

const {
  SkillLibraryService,
  SkillSourceService,
  AgentConfigService,
  SkillDeployService,
  selectBuiltinAgents,
  BackupService,
  planMerge,
  validateMergePlan,
  metaComparableKey,
  hashSkillDir,
  parseProtocolFile,
  appCommitMessage,
  hasProtocolTrailer,
} = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href);

const { WriteLock } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'infra', 'write-lock.js')).href
);

// ───────────────────────────── 通用工具 ─────────────────────────────

function writeSkill(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的描述\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  );
}

function editSkillBody(lib, dirName, body) {
  const file = path.join(lib, 'skills', dirName, 'SKILL.md');
  const current = fs.readFileSync(file, 'utf8');
  const head = current.split('\n').slice(0, 6).join('\n');
  fs.writeFileSync(file, `${head}\n\n${body}\n`, 'utf8');
}

function readMeta(lib, dirName) {
  return JSON.parse(fs.readFileSync(path.join(lib, 'sync', `${dirName}.skill.json`), 'utf8'));
}

function writeMeta(lib, dirName, mutate) {
  const file = path.join(lib, 'sync', `${dirName}.skill.json`);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(meta);
  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return meta;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** 返回 git 退出码（不抛错），用于断言「未命中 / 未配置」。 */
function gitExit(args, cwd) {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : -1;
  }
}

function gitRaw(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function treeNames(cwd, rev = 'HEAD') {
  return git(['ls-tree', '-r', '--name-only', rev], cwd).split('\n').filter(Boolean);
}

function showAt(cwd, file, rev = 'HEAD') {
  return execFileSync('git', ['show', `${rev}:${file}`], { cwd, encoding: 'utf8' });
}

function commitBody(cwd, rev = 'HEAD') {
  return git(['log', '-1', '--format=%B', rev], cwd);
}

function linkSnapshot(file) {
  const st = fs.lstatSync(file);
  return {
    isSymbolicLink: st.isSymbolicLink(),
    readlink: st.isSymbolicLink() ? fs.readlinkSync(file) : null,
    size: st.size,
    mode: st.mode,
  };
}

/** 库内所有技能目录的内容哈希（按目录名）。 */
function skillHashMap(lib) {
  const out = {};
  const dir = path.join(lib, 'skills');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    out[entry.name] = hashSkillDir(path.join(dir, entry.name));
  }
  return out;
}

/** 库内所有评测报告（文件名 → 内容）。 */
function readReports(lib) {
  const dir = path.join(lib, 'reports');
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir)) out[file] = fs.readFileSync(path.join(dir, file), 'utf8');
  return out;
}

/** 评测报告命名：`<技能名>_review_<yyyyMMdd-HHmmss>.md`。测试固定时间戳，保证两端指向同一份文件。 */
const REPORT_STAMP = '20260101-000000';
function reportRelPath(skillName, stamp = REPORT_STAMP) {
  return `reports/${skillName}_review_${stamp}.md`;
}
function reportPathOf(lib, skillName, stamp = REPORT_STAMP) {
  return path.join(lib, reportRelPath(skillName, stamp));
}
/** 写一份评测报告（覆盖同名文件，模拟「同一份报告被再次评测替换」）。 */
function writeReport(lib, skillName, text) {
  const file = reportPathOf(lib, skillName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}
/** 该技能当前唯一一份报告（没有则 null）。 */
function latestReport(lib, skillName) {
  const dir = path.join(lib, 'reports');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((file) => file.startsWith(`${skillName}_review_`)).sort();
  return files.length > 0 ? path.join(dir, files.at(-1)) : null;
}

function metaOf(skillId, dirName, over = {}) {
  return {
    schemaVersion: 1,
    dirName,
    name: dirName,
    nameSource: 'frontmatter',
    description: `${dirName} 的描述`,
    groups: [],
    source: { type: 'local-dir' },
    sync: { agents: [] },
    ...over,
  };
}

function snapSkill(id, dirName, content, report = null, over = {}) {
  return { skillId: id, meta: metaOf(id, dirName, over), contentTree: content, reportBlob: report };
}

function snap(commit, skills) {
  return { commit, skills: Object.fromEntries(skills.map((s) => [s.skillId, s])) };
}

// ───────────────────────────── 两台机器 ─────────────────────────────

function makeMachine(id) {
  const lib = path.join(BASE, `lib-${id}`);
  const data = path.join(BASE, `data-${id}`);
  const agents = path.join(BASE, `agents-${id}`);
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const library = SkillLibraryService.create({ libraryDir: lib, dataDir: data });
  const lock = new WriteLock({ dataDir: data });
  const backup = new BackupService({ library, dataDir: data, lock });
  const adapters = selectBuiltinAgents('codebuddy,cursor');
  // 先建 Agent 技能目录再建 agentConfig：create 时 enabled=isDir(skillsDir) 会持久化，
  // 目录晚建会让全部 Agent 永久停用（部署状态探针的 configuredAgents 因此为空）
  for (const def of adapters) {
    fs.mkdirSync(path.join(agents, def.skillsDirRel), { recursive: true });
  }
  const agentConfig = AgentConfigService.create({ dataDir: data, homeDir: agents, adapters });
  const sources = new SkillSourceService({ library, tempDir: TMP });
  const deploy = new SkillDeployService({ library, agents: agentConfig, lock, sources });
  library.setDeploymentProbe(deploy.createProbe());
  return { id, lib, data, agents, library, lock, backup, agentConfig, sources, deploy };
}

let A;
let B;
let ids = {};

before(async () => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(REMOTE, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', REMOTE], { stdio: 'pipe' });

  writeSkill(path.join(SRC, 'alpha'), 'alpha', 'alpha v1 body');
  writeSkill(path.join(SRC, 'beta'), 'beta', 'beta v1 body');
  writeSkill(path.join(SRC, 'gamma'), 'gamma', 'gamma v1 body');

  A = makeMachine('a');
  const imported = await A.sources.importSkills(A.sources.discoverFromLocalDir(SRC).items);
  for (const r of imported.results) {
    assert.equal(r.status, 'imported', `${r.name}: ${r.reason ?? ''}`);
    ids[r.name] = r.skillId;
  }
  assert.equal(A.library.listSkills().length, 3);

  B = makeMachine('b');
});

after(() => {
  A?.library.close();
  B?.library.close();
});

// ═════════════════════════ 纯函数：对象级三方合并 ═════════════════════════

test('纯函数 planMerge：单边改内容/元数据/报告、双边同改、双边异组件、双边删', () => {
  const S = (n) => `tree-${n}`;

  // ① 单边改内容（本机没改，远端改） → 取远端
  {
    const base = snap('b', [snapSkill('s1', 'one', S(1))]);
    const local = snap('l', [snapSkill('s1', 'one', S(1))]);
    const remote = snap('r', [snapSkill('s1', 'one', S(2))]);
    const plan = planMerge({ base, local, remote });
    assert.equal(plan.skills.s1.contentTree, S(2));
    assert.equal(plan.conflicts.length, 0);
    assert.deepEqual(plan.adoptedFromRemote, []);
  }

  // ② 单边改元数据（Group 按集合处理：顺序不同不算变化）
  {
    const base = snap('b', [snapSkill('s1', 'one', S(1), null, { groups: ['x', 'y'] })]);
    const local = snap('l', [snapSkill('s1', 'one', S(1), null, { groups: ['y', 'x'] })]);
    const remote = snap('r', [snapSkill('s1', 'one', S(1), null, { groups: ['x', 'y', 'z'], sync: { agents: ['b'] } })]);
    const plan = planMerge({ base, local, remote });
    assert.equal(plan.conflicts.length, 0, 'Group 集合顺序不同不算变化');
    assert.deepEqual(plan.skills.s1.meta.groups, ['x', 'y', 'z']);
    assert.deepEqual(plan.skills.s1.meta.sync.agents, ['b']);
  }

  // ③ 单边改评测报告
  {
    const base = snap('b', [snapSkill('s1', 'one', S(1), 'blob-1')]);
    const local = snap('l', [snapSkill('s1', 'one', S(1), 'blob-1')]);
    const remote = snap('r', [snapSkill('s1', 'one', S(1), 'blob-2')]);
    const plan = planMerge({ base, local, remote });
    assert.equal(plan.skills.s1.reportBlob, 'blob-2');
    assert.equal(plan.conflicts.length, 0);
  }

  // ④ 双边同改（内容完全一致） → 不冲突
  {
    const base = snap('b', [snapSkill('s1', 'one', S(1))]);
    const local = snap('l', [snapSkill('s1', 'one', S(2))]);
    const remote = snap('r', [snapSkill('s1', 'one', S(2))]);
    const plan = planMerge({ base, local, remote });
    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.skills.s1.contentTree, S(2));
  }

  // ⑤ 双边改不同组件（本机改内容、远端改元数据） → 自动合成，不冲突
  {
    const base = snap('b', [snapSkill('s1', 'one', S(1), 'blob-1', { groups: ['x'] })]);
    const local = snap('l', [snapSkill('s1', 'one', S(2), 'blob-1', { groups: ['x'] })]);
    const remote = snap('r', [
      snapSkill('s1', 'one', S(1), 'blob-1', { groups: ['x', 'new'], sync: { agents: ['codebuddy'] } }),
    ]);
    const plan = planMerge({ base, local, remote });
    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.skills.s1.contentTree, S(2));
    assert.deepEqual(plan.skills.s1.meta.groups, ['x', 'new']);
    assert.deepEqual(plan.skills.s1.meta.sync.agents, ['codebuddy']);
  }

  // ⑥ 双边同组件异改 → 冲突，保留本机
  {
    const base = snap('b', [snapSkill('s1', 'one', S(1))]);
    const local = snap('l', [snapSkill('s1', 'one', S(2))]);
    const remote = snap('r', [snapSkill('s1', 'one', S(3))]);
    const plan = planMerge({ base, local, remote });
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].skillId, 's1');
    assert.equal(plan.conflicts[0].kind, 'component');
    assert.deepEqual(plan.conflicts[0].components, ['content']);
    assert.equal(plan.skills.s1.contentTree, S(2), '冲突时保留本机版本');
    assert.deepEqual(plan.keptLocal, ['s1']);
  }

  // ⑦ 双边删除 → 结果里消失（无冲突）
  {
    const base = snap('b', [snapSkill('s1', 'one', S(1))]);
    const plan = planMerge({ base, local: snap('l', []), remote: snap('r', []) });
    assert.deepEqual(plan.removed, ['s1']);
    assert.equal(plan.skills.s1, undefined);
  }

  // ⑧ 删除 vs 修改 → 冲突（不静默复活）
  {
    const base = snap('b', [snapSkill('s1', 'one', S(1))]);
    const local = snap('l', [snapSkill('s1', 'one', S(2))]);
    const remote = snap('r', []);
    const plan = planMerge({ base, local, remote });
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].kind, 'deleted-remotely');
    assert.equal(plan.skills.s1.contentTree, S(2));

    const plan2 = planMerge({ base, local: snap('l', []), remote: snap('r', [snapSkill('s1', 'one', S(2))]) });
    assert.equal(plan2.conflicts.length, 1);
    assert.equal(plan2.conflicts[0].kind, 'deleted-locally');
    assert.equal(plan2.skills.s1, undefined, '本机删除保留');
  }

  // ⑨ 双新增不同内容 → 冲突；pin 固定本机并计入 stillPending
  {
    const local = snap('l', [snapSkill('s1', 'one', S(1))]);
    const remote = snap('r', [snapSkill('s1', 'one', S(2))]);
    const plan = planMerge({ base: snap('b', []), local, remote });
    assert.equal(plan.conflicts[0].kind, 'both-added');
    assert.equal(plan.skills.s1.contentTree, S(1));

    const pinned = planMerge({ base: snap('b', [snapSkill('s1', 'one', S(1))]), local, remote, pinnedSkillIds: ['s1'] });
    assert.deepEqual(pinned.stillPending, ['s1']);
    assert.equal(pinned.conflicts.length, 0, 'pin 期间不重复生成冲突');
    assert.equal(pinned.skills.s1.contentTree, S(1));
  }

  // ⑩ 确定性：同样的三方输入在不同调用里算出逐字段相同的计划（与对象枚举顺序无关）
  {
    const base = snap('b', [snapSkill('s2', 'two', S(1)), snapSkill('s1', 'one', S(1))]);
    const local = snap('l', [snapSkill('s1', 'one', S(2)), snapSkill('s2', 'two', S(1))]);
    const remote = snap('r', [snapSkill('s2', 'two', S(3)), snapSkill('s1', 'one', S(1))]);
    const p1 = planMerge({ base, local, remote });
    const p2 = planMerge({ base, local, remote });
    assert.equal(JSON.stringify(p1), JSON.stringify(p2));
    assert.deepEqual(Object.keys(p1.skills), ['s1', 's2']);
  }

  // ⑪ 目录名冲突（两个不同 Skill 同名）→ 确定性顺延，不越界
  {
    const oid = (n) => n.repeat(40);
    const local = snap('l', [snapSkill('sk_aaaaaaaaaaaaaaaaa', 'dup', oid('1'))]);
    const remote = snap('r', [snapSkill('sk_bbbbbbbbbbbbbbbbb', 'dup', oid('2'))]);
    const plan = planMerge({ base: snap('b', []), local, remote });
    const dirs = Object.values(plan.skills).map((s) => s.meta.dirName).sort();
    assert.deepEqual(dirs, ['dup', 'dup (2)']);
    validateMergePlan(plan);
  }
});

test('纯函数 validateMergePlan：目录与元数据不一一对应、目录越界、重名 → 整体拒绝', () => {
  const oid = (n) => n.repeat(40);
  const base = planMerge({
    base: snap('b', [snapSkill('sk_aaaaaaaaaaaaaaaaa', 'one', oid('1'))]),
    local: snap('l', [snapSkill('sk_aaaaaaaaaaaaaaaaa', 'one', oid('1'))]),
    remote: snap('r', [snapSkill('sk_aaaaaaaaaaaaaaaaa', 'one', oid('1'))]),
  });
  validateMergePlan(base); // 合法计划不抛错

  const noMeta = structuredClone(base);
  noMeta.skills.sk_aaaaaaaaaaaaaaaaa.meta = null;
  assert.throws(
    () => validateMergePlan(noMeta),
    (err) => err.code === 'GIT_MERGE_RESULT_INVALID' && err.reasons.some((r) => r.includes('缺少元数据')),
  );

  const escaped = structuredClone(base);
  escaped.skills.sk_aaaaaaaaaaaaaaaaa.meta.dirName = '../outside';
  assert.throws(
    () => validateMergePlan(escaped),
    (err) => err.code === 'GIT_MERGE_RESULT_INVALID' && err.reasons.some((r) => r.includes('越界')),
  );

  const duplicate = structuredClone(base);
  duplicate.skills.sk_bbbbbbbbbbbbbbbbb = {
    ...structuredClone(base.skills.sk_aaaaaaaaaaaaaaaaa),
    skillId: 'sk_bbbbbbbbbbbbbbbbb',
  };
  assert.throws(
    () => validateMergePlan(duplicate),
    (err) => err.code === 'GIT_MERGE_RESULT_INVALID' && err.reasons.some((r) => r.includes('目录名冲突')),
  );

  // T01「已丢失」语义：元数据在、目录不在（contentTree = null）是合法的
  const missing = structuredClone(base);
  missing.skills.sk_aaaaaaaaaaaaaaaaa.contentTree = null;
  validateMergePlan(missing);

  // 协议标记纯函数
  assert.deepEqual(parseProtocolFile('{"protocolVersion": 1}'), { protocolVersion: 1 });
  assert.equal(parseProtocolFile('{"protocolVersion": 0}'), null);
  assert.equal(parseProtocolFile('not json'), null);
  const msg = appCommitMessage('备份技能库', { 'Skills-Sync-Protocol': '1' });
  assert.equal(msg, '备份技能库\n\nSkills-Sync-Protocol: 1');
  assert.equal(hasProtocolTrailer(msg), true);
  assert.equal(hasProtocolTrailer('备份技能库'), false);
});

// ═════════════════════════ 初始化 / 推送 / 历史 ═════════════════════════

test('初始化与 Push：提交树含协议文件、提交带协议 trailer、远端地址只存 DATA_DIR', async () => {
  const status = await A.backup.init({ remoteUrl: REMOTE });
  assert.equal(status.gitAvailable, true);
  assert.equal(status.initialized, true);
  assert.equal(status.remoteUrl, REMOTE);

  const pushed = await A.backup.push({ message: '首次备份' });
  assert.equal(pushed.status, 'pushed');
  assert.match(pushed.commitId, /^[0-9a-f]{40}$/);
  assert.equal(git(['rev-parse', 'HEAD'], A.lib), pushed.commitId);
  assert.ok(pushed.snapshotRef?.startsWith('refs/skills-sync/snapshots/'), pushed.snapshotRef ?? '');
  assert.equal(git(['rev-parse', pushed.snapshotRef], A.lib), pushed.commitId, '每次 Push 打快照 ref');

  const names = treeNames(A.lib);
  assert.ok(names.includes('.skills-sync/protocol.json'), '提交树含协议标记文件');
  assert.ok(names.includes('library.json'));
  assert.ok(names.includes('skills/alpha/SKILL.md'));
  assert.ok(names.includes('sync/alpha.skill.json'));
  assert.equal(parseProtocolFile(showAt(A.lib, '.skills-sync/protocol.json')).protocolVersion, 1);
  assert.match(commitBody(A.lib), /Skills-Sync-Protocol: 1/);
  assert.equal(hasProtocolTrailer(commitBody(A.lib)), true);

  // 远端地址只在 DATA_DIR（不进库、也不写进库内 git 配置）
  const cfg = JSON.parse(fs.readFileSync(path.join(A.data, 'backup-config.json'), 'utf8'));
  assert.equal(cfg.remoteUrl, REMOTE);
  assert.equal(fs.existsSync(path.join(A.lib, 'backup-config.json')), false);
  assert.equal(gitExit(['config', '--get', 'remote.origin.url'], A.lib), 1, '库内 git 配置不含远端地址');

  // 历史：时间 / 变更技能数 / 说明
  const history = A.backup.listHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].commitId, pushed.commitId);
  assert.ok(history[0].committedAt);
  assert.equal(history[0].changedSkillCount, 3);
  assert.deepEqual(history[0].changedSkills, ['alpha', 'beta', 'gamma']);
  assert.match(history[0].message, /首次备份/);

  // 差异：某次提交对某技能的文件级摘要
  const diff = A.backup.getCommitSkillDiff(history[0].commitId, 'alpha');
  assert.equal(diff.skillId, ids.alpha);
  assert.deepEqual(diff.files.added.sort(), ['skills/alpha/SKILL.md', 'sync/alpha.skill.json'].sort());

  // 本机绝对来源路径已抽到 DATA_DIR；库内元数据（提交树）不含绝对路径
  const origins = JSON.parse(fs.readFileSync(path.join(A.data, 'source-origins.json'), 'utf8'));
  assert.equal(origins.origins[ids.alpha], SRC);
  assert.equal(readMeta(A.lib, 'alpha').source.origin, SRC, '工作树元数据保留本机来源');
  const committedMeta = JSON.parse(showAt(A.lib, 'sync/alpha.skill.json'));
  assert.equal(committedMeta.source.origin, undefined, '提交树元数据无本机绝对路径');
  assert.equal(committedMeta.source.type, 'local-dir');
  assert.equal(committedMeta.source.sourceRelPath, 'alpha');

  // B 初始化并拉取（bootstrap）：拿到三份技能，且没有本机来源路径
  await B.backup.init({ remoteUrl: REMOTE });
  const pulled = await B.backup.pull();
  assert.equal(pulled.status, 'initialized');
  assert.equal(B.library.listSkills().length, 3);
  assert.deepEqual(pulled.adopted.sort(), [ids.alpha, ids.beta, ids.gamma].sort());
  assert.equal(readMeta(B.lib, 'alpha').source.origin, undefined, 'B 没有该技能的本地映射');

  // 再次 Pull 应为 up-to-date，不制造噪声提交
  const before = git(['rev-parse', 'HEAD'], B.lib);
  const again = await B.backup.pull();
  assert.equal(again.status, 'up-to-date');
  assert.equal(git(['rev-parse', 'HEAD'], B.lib), before);
});

// ═════════════════════════ C-17 双端改不同技能 ═════════════════════════

test('C-17 双端改不同技能：A→B、B→A 互见变化，无冲突、无覆盖，最终树一致', async () => {
  // A 改 alpha（内容 + Group + 同步意图）
  editSkillBody(A.lib, 'alpha', 'alpha v2 by A');
  writeMeta(A.lib, 'alpha', (m) => {
    m.groups = ['frontend', 'shared'];
    m.sync = { agents: ['codebuddy'] };
  });
  await A.library.rescan();
  const pushA = await A.backup.push({ message: 'A 改 alpha' });
  assert.equal(pushA.status, 'pushed');

  const pullB = await B.backup.pull();
  assert.equal(pullB.status, 'fast-forward');
  assert.equal(pullB.conflicts.length, 0);
  assert.ok(fs.readFileSync(path.join(B.lib, 'skills', 'alpha', 'SKILL.md'), 'utf8').includes('alpha v2 by A'));
  assert.deepEqual(readMeta(B.lib, 'alpha').groups.sort(), ['frontend', 'shared']);

  // 拉取只同步「同步意图」，不自动向本机 Agent 目录部署
  const alphaOnB = B.library.listSkills().find((s) => s.skillId === ids.alpha);
  assert.deepEqual(alphaOnB.deployedAgents, [], 'Pull 后不自动建链接');
  assert.ok(alphaOnB.configuredAgents.includes('codebuddy'), '同步配置作为意图存在');
  assert.equal(alphaOnB.configuredNotDeployed, true, '显示为「已配置、未执行」');
  assert.equal(fs.existsSync(path.join(B.agents, '.codebuddy', 'skills', 'alpha')), false);

  // B 改 beta（内容 + Group）
  editSkillBody(B.lib, 'beta', 'beta v2 by B');
  writeMeta(B.lib, 'beta', (m) => {
    m.groups = ['b-only'];
  });
  await B.library.rescan();
  const pushB = await B.backup.push({ message: 'B 改 beta' });
  assert.equal(pushB.status, 'pushed');

  const pullA = await A.backup.pull();
  assert.equal(pullA.status, 'fast-forward');
  assert.equal(pullA.conflicts.length, 0);
  assert.ok(fs.readFileSync(path.join(A.lib, 'skills', 'beta', 'SKILL.md'), 'utf8').includes('beta v2 by B'));
  assert.deepEqual(readMeta(A.lib, 'beta').groups, ['b-only']);
  assert.ok(fs.readFileSync(path.join(A.lib, 'skills', 'alpha', 'SKILL.md'), 'utf8').includes('alpha v2 by A'), 'A 的改动未被覆盖');

  // 两端最终树一致（提交树内元数据不含本机 origin，因此 tree 可逐字节比较）
  assert.equal(git(['rev-parse', 'HEAD^{tree}'], A.lib), git(['rev-parse', 'HEAD^{tree}'], B.lib));
  assert.equal(A.backup.listConflicts().length, 0);
  assert.equal(B.backup.listConflicts().length, 0);

  // 真实的内容变更事件（不制造噪声：未变化的技能不产生事件）
  const alphaEvent = B.library.getRecentActivity().find((e) => e.skillId === ids.alpha);
  assert.equal(alphaEvent.type, 'content-changed');
  const gammaEvent = B.library.getRecentActivity().find((e) => e.skillId === ids.gamma);
  assert.ok(!gammaEvent || gammaEvent.type === 'imported', 'gamma 没变化，不应有 content-changed');
});

// ═════════════════════════ C-18 同技能双改冲突与三种选择 ═════════════════════════

test('C-18a 同技能双改：冲突待处理（本机/远端摘要正确、库内不被静默覆盖）→ 保留本机', async () => {
  // A、B 同时改 gamma，并各自写一份评测报告
  editSkillBody(A.lib, 'gamma', 'gamma A round1');
  fs.mkdirSync(path.join(A.lib, 'reports'), { recursive: true });
  writeReport(A.lib, 'gamma', 'A 的报告 round1\n');
  await A.library.rescan();
  assert.equal((await A.backup.push({ message: 'A 改 gamma round1' })).status, 'pushed');

  editSkillBody(B.lib, 'gamma', 'gamma B round1');
  fs.mkdirSync(path.join(B.lib, 'reports'), { recursive: true });
  writeReport(B.lib, 'gamma', 'B 的报告 round1\n');
  await B.library.rescan();

  const pulled = await B.backup.pull();
  assert.equal(pulled.status, 'merged');
  assert.equal(pulled.conflicts.length, 1);
  const conflict = pulled.conflicts[0];
  assert.equal(conflict.skillId, ids.gamma);
  assert.equal(conflict.kind, 'component');
  assert.deepEqual(conflict.components, ['content', 'report']);

  // 摘要：本机 / 远端各自的变化文件与内容标识
  assert.equal(conflict.local.present, true);
  assert.equal(conflict.remote.present, true);
  assert.equal(conflict.local.dirName, 'gamma');
  assert.equal(conflict.remote.dirName, 'gamma');
  assert.ok(conflict.local.changedFiles.includes('skills/gamma/SKILL.md'), conflict.local.changedFiles.join(','));
  assert.ok(conflict.remote.changedFiles.includes('skills/gamma/SKILL.md'));
  assert.ok(conflict.local.changedFiles.includes(reportRelPath('gamma')));
  assert.notEqual(conflict.local.contentTree, conflict.remote.contentTree);
  assert.equal(conflict.local.commit, pulled.commitId ? git(['rev-parse', 'HEAD^1'], B.lib) : null);

  // 库内不被静默覆盖：工作树与合并提交里都是本机版本
  assert.ok(fs.readFileSync(path.join(B.lib, 'skills', 'gamma', 'SKILL.md'), 'utf8').includes('gamma B round1'));
  assert.ok(showAt(B.lib, 'skills/gamma/SKILL.md').includes('gamma B round1'));
  assert.equal(fs.readFileSync(latestReport(B.lib, 'gamma'), 'utf8'), 'B 的报告 round1\n');
  assert.equal(B.backup.listConflicts().length, 1);
  assert.match(commitBody(B.lib), /Skills-Sync-Conflicts:/);

  // 有冲突时 Push 被明确拒绝（不把未决冲突推给远端）
  await assert.rejects(
    () => B.backup.push(),
    (err) => err.code === 'SYNC_CONFLICTS_PENDING',
  );

  // keep-local：本机版本保留，冲突清空，解决动作形成提交
  const resolved = await B.backup.resolveConflict(ids.gamma, 'keep-local');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.newSkillId, null);
  assert.equal(resolved.dirName, 'gamma');
  assert.equal(B.backup.listConflicts().length, 0);
  assert.ok(showAt(B.lib, 'skills/gamma/SKILL.md').includes('gamma B round1'));
  assert.match(commitBody(B.lib), /Skills-Sync-Resolved:/);
  assert.ok(B.backup.listSnapshots().some((s) => s.kind.startsWith('pre-resolve')), '解决前留下可回退快照');

  assert.equal((await B.backup.push({ message: 'B 解决冲突（保留本机）' })).status, 'pushed');
  assert.equal((await A.backup.pull()).status, 'fast-forward');
  assert.ok(fs.readFileSync(path.join(A.lib, 'skills', 'gamma', 'SKILL.md'), 'utf8').includes('gamma B round1'));
});

test('C-18b take-remote：显式采用远端版本（内容与报告都换成远端）', async () => {
  editSkillBody(A.lib, 'gamma', 'gamma A round2');
  writeReport(A.lib, 'gamma', 'A 的报告 round2\n');
  await A.library.rescan();
  assert.equal((await A.backup.push({ message: 'A 改 gamma round2' })).status, 'pushed');

  editSkillBody(B.lib, 'gamma', 'gamma B round2');
  writeReport(B.lib, 'gamma', 'B 的报告 round2\n');
  await B.library.rescan();
  const pulled = await B.backup.pull();
  assert.equal(pulled.conflicts.length, 1);

  const resolved = await B.backup.resolveConflict(ids.gamma, 'take-remote');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.dirName, 'gamma');
  assert.ok(fs.readFileSync(path.join(B.lib, 'skills', 'gamma', 'SKILL.md'), 'utf8').includes('gamma A round2'));
  assert.equal(fs.readFileSync(latestReport(B.lib, 'gamma'), 'utf8'), 'A 的报告 round2\n');
  assert.equal(B.backup.listConflicts().length, 0);

  assert.equal((await B.backup.push({ message: 'B 采用远端' })).status, 'pushed');
  assert.equal((await A.backup.pull()).status, 'fast-forward');
  assert.ok(fs.readFileSync(path.join(A.lib, 'skills', 'gamma', 'SKILL.md'), 'utf8').includes('gamma A round2'));
});

test('C-18c keep-both：远端版本以新 Skill ID 入库、目录名冲突安全、报告换新 ID；pin 语义正确', async () => {
  editSkillBody(A.lib, 'gamma', 'gamma A round3');
  writeReport(A.lib, 'gamma', 'A 的报告 round3\n');
  await A.library.rescan();
  assert.equal((await A.backup.push({ message: 'A 改 gamma round3' })).status, 'pushed');

  editSkillBody(B.lib, 'gamma', 'gamma B round3');
  writeReport(B.lib, 'gamma', 'B 的报告 round3\n');
  await B.library.rescan();
  const first = await B.backup.pull();
  assert.equal(first.conflicts.length, 1);
  const pinnedRemoteTree = first.conflicts[0].remote.contentTree;

  // 冲突未解决时远端再次变动 → 不重复生成冲突、不误判已解决，只推进远端摘要
  editSkillBody(A.lib, 'gamma', 'gamma A round3 v2');
  writeReport(A.lib, 'gamma', 'A 的报告 round3 v2\n');
  await A.library.rescan();
  assert.equal((await A.backup.push({ message: 'A 再改 gamma round3' })).status, 'pushed');

  const second = await B.backup.pull();
  assert.equal(second.status, 'merged');
  assert.equal(second.conflicts.length, 0, 'pin 期间不重复生成冲突');
  assert.deepEqual(second.updatedPins, [ids.gamma]);
  const pins = B.backup.listConflicts();
  assert.equal(pins.length, 1, '冲突仍然待决，没有被误判为已解决');
  assert.equal(pins[0].skillId, ids.gamma);
  assert.notEqual(pins[0].remote.contentTree, pinnedRemoteTree, '远端摘要已推进');
  assert.ok(pins[0].remote.changedFiles.includes('skills/gamma/SKILL.md'));
  assert.ok(pins[0].remoteAdvancedAt, '记录远端再次变动时间');
  assert.ok(fs.readFileSync(path.join(B.lib, 'skills', 'gamma', 'SKILL.md'), 'utf8').includes('gamma B round3'), '本机版本未被远端覆盖');
  assert.equal(fs.readFileSync(latestReport(B.lib, 'gamma'), 'utf8'), 'B 的报告 round3\n');

  // keep-both
  const resolved = await B.backup.resolveConflict(ids.gamma, 'keep-both');
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.newSkillId && resolved.newSkillId !== ids.gamma);
  assert.match(resolved.newSkillId, /^sk_[0-9a-z]{17}$/);
  assert.equal(resolved.newDirName, 'gamma (2)', '目录名冲突安全处理');
  assert.equal(B.backup.listConflicts().length, 0);

  // 旧技能保留本机版本，新技能保存远端版本（内容 + 报告换新 ID）
  assert.ok(fs.readFileSync(path.join(B.lib, 'skills', 'gamma', 'SKILL.md'), 'utf8').includes('gamma B round3'));
  assert.equal(fs.readFileSync(latestReport(B.lib, 'gamma'), 'utf8'), 'B 的报告 round3\n');
  assert.ok(fs.readFileSync(path.join(B.lib, 'skills', 'gamma (2)', 'SKILL.md'), 'utf8').includes('gamma A round3 v2'));
  assert.equal(fs.readFileSync(latestReport(B.lib, 'gamma (2)'), 'utf8'), 'A 的报告 round3 v2\n');
  assert.equal(readMeta(B.lib, 'gamma (2)').skillId, resolved.newSkillId);

  const bSkills = B.library.listSkills();
  assert.equal(bSkills.length, 4, 'B 库中 4 个技能（3 个原有 + keep-both 新增）');
  assert.ok(bSkills.some((s) => s.dirName === 'gamma (2)' && s.skillId === resolved.newSkillId));

  // 提交树里两个技能各自独立
  const names = treeNames(B.lib);
  assert.ok(names.includes('skills/gamma/SKILL.md'));
  assert.ok(names.includes('skills/gamma (2)/SKILL.md'));
  assert.ok(names.some((name) => name.startsWith('reports/gamma (2)_review_')));

  assert.equal((await B.backup.push({ message: 'B 解决冲突（两份都保留）' })).status, 'pushed');
  assert.equal((await A.backup.pull()).status, 'fast-forward');
  // B 的选择是「保留本机（B 版本）」，因此 A 侧的 gamma 变成 B 版本，A 的版本以新 Skill 保存
  assert.ok(fs.readFileSync(path.join(A.lib, 'skills', 'gamma', 'SKILL.md'), 'utf8').includes('gamma B round3'));
  assert.ok(fs.readFileSync(path.join(A.lib, 'skills', 'gamma (2)', 'SKILL.md'), 'utf8').includes('gamma A round3 v2'));
  assert.equal(A.library.listSkills().length, 4, 'A 也收到 keep-both 新增的技能');
});

// ═════════════════════════ C-19 远端领先拒绝 Push ═════════════════════════

test('C-19 远端领先：Push 被拒（PUSH_REJECTED/PULL_REQUIRED），本机变更完整保留，Pull 后可再 Push', async () => {
  // 远端先推
  editSkillBody(A.lib, 'alpha', 'alpha by A ahead');
  await A.library.rescan();
  assert.equal((await A.backup.push({ message: 'A 领先提交' })).status, 'pushed');
  const remoteHead = git(['rev-parse', 'HEAD'], A.lib);

  // 本机随后改另一个技能再 Push
  editSkillBody(B.lib, 'beta', 'beta by B ahead');
  await B.library.rescan();
  const rejected = await B.backup.push({ message: 'B 落后提交' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.code, 'GIT_PUSH_REJECTED');
  assert.equal(rejected.hint, 'PULL_REQUIRED');
  assert.match(rejected.reason, /Pull/);
  assert.equal(git(['rev-parse', 'HEAD'], B.lib), rejected.commitId, '本机提交已保留');
  assert.ok(fs.readFileSync(path.join(B.lib, 'skills', 'beta', 'SKILL.md'), 'utf8').includes('beta by B ahead'), '本机变更零丢失');
  assert.notEqual(git(['rev-parse', 'HEAD'], B.lib), remoteHead);

  const pulled = await B.backup.pull();
  assert.equal(pulled.status, 'merged');
  assert.equal(pulled.conflicts.length, 0);
  assert.ok(fs.readFileSync(path.join(B.lib, 'skills', 'beta', 'SKILL.md'), 'utf8').includes('beta by B ahead'));
  assert.ok(fs.readFileSync(path.join(B.lib, 'skills', 'alpha', 'SKILL.md'), 'utf8').includes('alpha by A ahead'));

  assert.equal((await B.backup.push({ message: 'B 处理后再 Push' })).status, 'pushed');
  assert.equal((await A.backup.pull()).status, 'fast-forward');
  assert.ok(fs.readFileSync(path.join(A.lib, 'skills', 'beta', 'SKILL.md'), 'utf8').includes('beta by B ahead'));
});

// ═════════════════════════ 合并结果树校验 ═════════════════════════

test('结果树校验：构造 skills/元数据不一一对应的合并结果 → 整体中止、零改动', async () => {
  // 制造分叉：A 改 beta，B 改 alpha（都未同步）
  editSkillBody(A.lib, 'beta', 'beta before invalid merge');
  await A.library.rescan();
  assert.equal((await A.backup.push({ message: 'A 为校验用例分叉' })).status, 'pushed');

  editSkillBody(B.lib, 'alpha', 'alpha before invalid merge');
  await B.library.rescan();
  // B 先试 Push（被远端领先拒绝），本机变更已形成提交 → 后续 Pull 的「保存本机变更」是空操作
  const rejected = await B.backup.push({ message: 'B 为校验用例分叉' });
  assert.equal(rejected.status, 'rejected');

  const headBefore = git(['rev-parse', 'HEAD'], B.lib);
  const headTreeBefore = git(['rev-parse', 'HEAD^{tree}'], B.lib);
  const alphaHashBefore = hashSkillDir(path.join(B.lib, 'skills', 'alpha'));
  const betaHashBefore = hashSkillDir(path.join(B.lib, 'skills', 'beta'));

  await assert.rejects(
    () =>
      B.backup.pull({
        mergePlanHook: (plan) => {
          const first = Object.keys(plan.skills).sort()[0];
          plan.skills[first].meta = null; // 技能目录没有元数据
          return plan;
        },
      }),
    (err) => err.code === 'GIT_MERGE_RESULT_INVALID',
  );

  assert.equal(git(['rev-parse', 'HEAD'], B.lib), headBefore, '校验失败不产生新提交');
  assert.equal(git(['rev-parse', 'HEAD^{tree}'], B.lib), headTreeBefore, '工作树内容零改动');
  assert.equal(hashSkillDir(path.join(B.lib, 'skills', 'alpha')), alphaHashBefore);
  assert.equal(hashSkillDir(path.join(B.lib, 'skills', 'beta')), betaHashBefore);
  assert.equal(B.backup.listConflicts().length, 0, '校验失败不产生冲突记录');

  // 正常 Pull 仍可成功（校验失败没有破坏仓库状态）
  const ok = await B.backup.pull();
  assert.equal(ok.status, 'merged');
  assert.ok(fs.readFileSync(path.join(B.lib, 'skills', 'beta', 'SKILL.md'), 'utf8').includes('beta before invalid merge'));
  assert.ok(fs.readFileSync(path.join(B.lib, 'skills', 'alpha', 'SKILL.md'), 'utf8').includes('alpha before invalid merge'));
  assert.equal((await B.backup.push({ message: 'B 正常合并' })).status, 'pushed');
  assert.equal((await A.backup.pull()).status, 'fast-forward');
});

// ═════════════════════════ C-20 快照恢复 ═════════════════════════

test('C-20 快照恢复：恢复前先快照可回退；单技能恢复只回滚该技能、部署链接零变化', async () => {
  const history = A.backup.listHistory({ limit: 100 });
  const firstPush = history[history.length - 1];
  assert.match(firstPush.message, /首次备份/);
  assert.ok(history.length >= 4, `应有多次备份，实际 ${history.length}`);

  // 部署一个技能，记录链接形态（单技能恢复时用于 lstat 对比）
  const deployed = await A.deploy.deployOne(ids.gamma, 'codebuddy');
  assert.equal(deployed.status, 'deployed', deployed.reason ?? '');
  const linkPath = path.join(A.agents, '.codebuddy', 'skills', 'gamma');
  const linkBefore = linkSnapshot(linkPath);
  const syncBefore = [...readMeta(A.lib, 'gamma').sync.agents];

  const snapshotsBefore = A.backup.listSnapshots().length;
  const contentBeforeRestore = skillHashMap(A.lib);
  const gammaBeforeRestore = fs.readFileSync(path.join(A.lib, 'skills', 'gamma', 'SKILL.md'), 'utf8');
  const reportsBeforeRestore = readReports(A.lib);

  // ── 整库恢复到首次备份 ──
  const restored = await A.backup.restore({ commitId: firstPush.commitId });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.scope, 'library');
  assert.ok(restored.snapshotRef.startsWith('refs/skills-sync/snapshots/'));
  assert.equal(A.backup.listSnapshots().length, snapshotsBefore + 1, '恢复前先保存当前状态为新快照');
  assert.equal(git(['rev-parse', restored.snapshotRef], A.lib), git(['rev-parse', 'HEAD^'], A.lib), '快照指向恢复前提交');

  assert.ok(fs.readFileSync(path.join(A.lib, 'skills', 'alpha', 'SKILL.md'), 'utf8').includes('alpha v1 body'));
  assert.ok(fs.readFileSync(path.join(A.lib, 'skills', 'gamma', 'SKILL.md'), 'utf8').includes('gamma v1 body'));
  assert.equal(fs.existsSync(path.join(A.lib, 'skills', 'gamma (2)')), false, '该提交中不存在的技能被移出工作树');
  assert.match(commitBody(A.lib), /恢复整库到/);

  // 恢复前状态可找回：按快照提交再恢复一次（内容与报告都回到恢复前）
  const back = await A.backup.restore({ commitId: git(['rev-parse', restored.snapshotRef], A.lib) });
  assert.equal(back.status, 'restored');
  assert.deepEqual(skillHashMap(A.lib), contentBeforeRestore, '恢复到快照后技能内容与恢复前一致');
  assert.deepEqual(readReports(A.lib), reportsBeforeRestore, '报告也恢复到恢复前');
  assert.equal(fs.readFileSync(path.join(A.lib, 'skills', 'gamma', 'SKILL.md'), 'utf8'), gammaBeforeRestore);

  // ── 单技能恢复：只回滚 gamma，部署关系不动 ──
  // 先把 gamma 改成新内容并提交，再回滚到首次备份
  editSkillBody(A.lib, 'gamma', 'gamma local edit before single restore');
  writeReport(A.lib, 'gamma', 'gamma 报告（恢复前）\n');
  await A.library.rescan();
  assert.equal((await A.backup.push({ message: 'A 改 gamma（单技能恢复前）' })).status, 'pushed');
  const betaHashBeforeSingle = hashSkillDir(path.join(A.lib, 'skills', 'beta'));
  const alphaBodyBeforeSingle = fs.readFileSync(path.join(A.lib, 'skills', 'alpha', 'SKILL.md'), 'utf8');

  const single = await A.backup.restore({ commitId: firstPush.commitId, skillId: ids.gamma });
  assert.equal(single.scope, 'skill');
  assert.equal(single.skillId, ids.gamma);
  assert.equal(single.dirName, 'gamma');
  assert.deepEqual(single.changedSkills, ['gamma']);
  assert.ok(fs.readFileSync(path.join(A.lib, 'skills', 'gamma', 'SKILL.md'), 'utf8').includes('gamma v1 body'));
  // 首次备份时没有该报告 → 报告被移除
  assert.equal(latestReport(A.lib, 'gamma'), null, '报告回滚到该提交的状态');

  // 其他技能零改动
  assert.equal(hashSkillDir(path.join(A.lib, 'skills', 'beta')), betaHashBeforeSingle);
  assert.equal(fs.readFileSync(path.join(A.lib, 'skills', 'alpha', 'SKILL.md'), 'utf8'), alphaBodyBeforeSingle);

  // 部署链接零变化（lstat 对比），同步配置保持不变
  assert.deepEqual(linkSnapshot(linkPath), linkBefore);
  assert.deepEqual(readMeta(A.lib, 'gamma').sync.agents, syncBefore);
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.ok(fs.readFileSync(path.join(linkPath, 'SKILL.md'), 'utf8').includes('gamma v1 body'), '经链接读到回滚后的内容');
});

// ═════════════════════════ C-21 备份内容规则 ═════════════════════════

test('C-21 备份无密钥/绝对路径；>100MB 技能留在库中但不进备份，且有排除清单', async () => {
  // 本机存在密钥与模型配置（DATA_DIR，不进库）
  fs.writeFileSync(
    path.join(A.data, 'settings.json'),
    JSON.stringify({ provider: 'openai', apiKey: 'sk-live-SECRET-DO-NOT-BACKUP', model: 'gpt-4o' }, null, 2),
  );
  const agentsCfg = JSON.parse(fs.readFileSync(path.join(A.data, 'agents.json'), 'utf8'));

  // 构造 >100MB 技能（截断快速创建真实大文件）
  const bigDir = path.join(A.lib, 'skills', 'big-skill');
  writeSkill(bigDir, 'big-skill', 'big body');
  const payload = path.join(bigDir, 'payload.bin');
  const fd = fs.openSync(payload, 'w');
  fs.writeSync(fd, 'x');
  fs.ftruncateSync(fd, 101 * 1024 * 1024);
  fs.closeSync(fd);
  assert.ok(fs.statSync(payload).size > 100 * 1024 * 1024);

  await A.library.rescan();
  const pushed = await A.backup.push({ message: '含大技能与报告' });
  assert.equal(pushed.status, 'pushed');

  // 排除清单：名称 + 大小
  const excluded = A.backup.listExcludedSkills();
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].dirName, 'big-skill');
  assert.ok(excluded[0].sizeBytes > 100 * 1024 * 1024);
  assert.deepEqual(pushed.excluded.map((e) => e.dirName), ['big-skill']);

  // 库内保留，提交树不含（目录与元数据都不进备份）
  assert.ok(fs.existsSync(path.join(bigDir, 'SKILL.md')));
  const names = treeNames(A.lib);
  assert.ok(!names.some((n) => n.startsWith('skills/big-skill/')), '大技能目录不进备份');
  assert.ok(!names.includes('sync/big-skill.skill.json'), '大技能元数据也不进备份');

  // 排除后仍按协议提交
  assert.ok(names.includes('.skills-sync/protocol.json'));

  // 提交树：没有绝对路径、没有密钥、没有模型配置与本机配置
  for (const pattern of ['[A-Za-z]:[\\\\/]', 'apiKey', 'API_KEY', 'sk-live', 'Bearer ', 'gpt-4o']) {
    const out = gitExit(['grep', '-n', '-I', '-E', '-e', pattern, 'HEAD'], A.lib);
    assert.equal(out, 1, `提交树不得包含 ${pattern}（git grep 退出码应为 1，实际 ${out}）`);
  }
  for (const forbidden of [
    'settings.json',
    'agents.json',
    'backup-config.json',
    'source-origins.json',
    'pending-conflicts.json',
  ]) {
    assert.ok(!names.some((n) => n.endsWith(`/${forbidden}`) || n === forbidden), `不得备份本机配置 ${forbidden}`);
  }
  assert.ok(!JSON.stringify(agentsCfg).includes('sk-live'), '测试夹具前提：本机 Agent 配置里没有密钥');

  // 评测报告随备份（本次 gamma 的报告在更早的提交里）
  const allReports = A.backup
    .listHistory({ limit: 100 })
    .flatMap((c) => treeNames(A.lib, c.commitId).filter((n) => n.startsWith('reports/') && n.endsWith('.md')));
  assert.ok(allReports.length > 0, '提交树包含 reports/ 下的评测报告');

  // 每个应用提交都带协议 trailer
  const bodies = git(['log', '--format=%B%x00'], A.lib).split('\0').filter((b) => b.trim());
  assert.ok(bodies.length > 0);
  for (const body of bodies) assert.equal(hasProtocolTrailer(body), true, `提交缺少协议 trailer：${body.slice(0, 60)}`);
});

// ═════════════════════════ 协议不匹配 ═════════════════════════

test('协议不匹配：远端 protocolVersion 不同 → Pull 中止、零改动、错误可读', async () => {
  const remoteP = path.join(BASE, 'remote-p.git');
  const rogue = path.join(BASE, 'rogue');
  fs.mkdirSync(remoteP, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', remoteP], { stdio: 'pipe' });

  const P = makeMachine('p');
  writeSkill(path.join(P.lib, 'skills', 'only'), 'only', 'only v1');
  await P.library.rescan();
  await P.backup.init({ remoteUrl: remoteP });
  assert.equal((await P.backup.push({ message: 'P 首次备份' })).status, 'pushed');

  // 第三方客户端（模拟旧/新协议）直接向远端写入 protocolVersion=2 的提交
  execFileSync('git', ['clone', remoteP, rogue], { stdio: 'pipe' });
  fs.writeFileSync(path.join(rogue, '.skills-sync', 'protocol.json'), '{\n  "protocolVersion": 2\n}\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: rogue, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', 'user.name=rogue', '-c', 'user.email=rogue@test.local', 'commit', '-m', 'protocol 2'],
    { cwd: rogue, stdio: 'pipe' },
  );
  execFileSync('git', ['push', 'origin', 'main'], { cwd: rogue, stdio: 'pipe' });

  const headBefore = git(['rev-parse', 'HEAD'], P.lib);
  const hashBefore = hashSkillDir(path.join(P.lib, 'skills', 'only'));

  await assert.rejects(
    () => P.backup.pull(),
    (err) => {
      assert.equal(err.code, 'GIT_PROTOCOL_MISMATCH');
      assert.match(err.message, /协议版本/);
      assert.match(err.detail, /仅支持 1/);
      return true;
    },
  );

  assert.equal(git(['rev-parse', 'HEAD'], P.lib), headBefore, '协议不匹配时零改动');
  assert.equal(hashSkillDir(path.join(P.lib, 'skills', 'only')), hashBefore);
  assert.equal(P.backup.listConflicts().length, 0);
  P.library.close();
});

// ═════════════════════════ 凭据脱敏与远端地址校验 ═════════════════════════

test('凭据脱敏：错误信息与地址校验不泄露 URL 内嵌 token，拒绝 ext:: 传输', async () => {
  const { redactGitOutput, validateRemoteUrl } = await import(
    pathToFileURL(path.join(BACKEND, 'dist', 'infra', 'git.js')).href
  );

  const raw =
    "fatal: could not read Username for 'https://alice:ghp_abcdefghijklmnopqrstuvwxyz0123@git.example.com/repo': terminal prompts disabled";
  const redacted = redactGitOutput(raw);
  assert.ok(redacted.includes('://***@'), redacted);
  assert.ok(!redacted.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), 'token 被抹掉');
  assert.ok(!redacted.includes('alice:'), '用户名与密码一起抹掉');

  assert.throws(
    () => validateRemoteUrl('https://alice:secret@git.example.com/repo.git'),
    (err) => err.code === 'GIT_INVALID_URL' && /凭据/.test(err.detail),
  );
  assert.throws(() => validateRemoteUrl('ext::sh -c whoami'), (err) => err.code === 'GIT_INVALID_URL');
  assert.throws(() => validateRemoteUrl('--upload-pack=calc'), (err) => err.code === 'GIT_INVALID_URL');
  assert.equal(validateRemoteUrl('  https://git.example.com/repo.git  '), 'https://git.example.com/repo.git');
  assert.equal(validateRemoteUrl('git@github.com:me/repo.git'), 'git@github.com:me/repo.git');
});

// ═════════════════════════ 并发与隔离 ═════════════════════════

test('并发与隔离：并发 Push 排队串行（不损坏、无 git 残留），测试数据不出 tests/runtime/t04', async () => {
  // 所有测试数据都在 tests/runtime/t04 下
  for (const dir of [A.lib, B.lib, A.data, B.data, REMOTE]) {
    assert.ok(path.resolve(dir).startsWith(path.resolve(BASE)), dir);
  }

  // 并发 Push：同一队列排队，最终状态一致
  const [r1, r2] = await Promise.all([
    A.backup.push({ message: '并发 Push 1' }),
    A.backup.push({ message: '并发 Push 2' }),
  ]);
  assert.ok(['pushed', 'up-to-date'].includes(r1.status), r1.status);
  assert.ok(['pushed', 'up-to-date'].includes(r2.status), r2.status);
  assert.equal(git(['status', '--porcelain'], A.lib).split('\n').filter((l) => l.includes('.tmp')).length, 0);
});
