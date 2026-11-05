// T14 自动验证（tests/test_cases.md P0 双端双改 / 远端领先 / 快照恢复；ui.md「备份 Skills」）
// 运行：cd backend && npm run build && node --no-warnings --test tests/t14.test.mjs
// 隔离纪律：两台「机器」= tests/runtime/t14/{lib-a,lib-b} + 各自 DATA_DIR；
// 远端只用 tests/runtime/t14/remote.git（本地 bare），全程无网络、不触碰真实技能目录。
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
const ROOT = path.join(RUNTIME, 't14');
const REMOTE = path.join(ROOT, 'remote.git');
const SRC = path.join(ROOT, 'src-skills');
const TMP = path.join(ROOT, 'tmp');

const { AppContext } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'context.js')).href);
const { selectBuiltinAgents } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'agents.js')).href
);
const { createIpcHandlers } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'ipc', 'handlers.js')).href
);

function writeSkill(dir, name, description, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  );
}

/** 只改正文，保留 frontmatter（模拟用户在应用内编辑 SKILL.md）。 */
function editSkillBody(lib, dirName, body) {
  const file = path.join(lib, 'skills', dirName, 'SKILL.md');
  const current = fs.readFileSync(file, 'utf8');
  const end = current.indexOf('\n---', 4);
  const head = end > 0 ? current.slice(0, end + 4) : current.split('\n').slice(0, 4).join('\n');
  fs.writeFileSync(file, `${head}\n\n${body}\n`, 'utf8');
}

function readSkill(lib, dirName) {
  return fs.readFileSync(path.join(lib, 'skills', dirName, 'SKILL.md'), 'utf8');
}

function silentLogger() {
  return { info: () => undefined, error: () => undefined };
}

function makeMachine(id) {
  const lib = path.join(ROOT, `lib-${id}`);
  const data = path.join(ROOT, `data-${id}`);
  const agents = path.join(ROOT, `agents-${id}`);
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  const ctx = AppContext.create({
    libraryDir: lib,
    dataDir: data,
    tempDir: TMP,
    homeDir: agents,
    adapters: selectBuiltinAgents('codebuddy,cursor'),
    appEnv: 'development',
    version: '0.1.0',
    logger: silentLogger(),
  });
  const handlers = createIpcHandlers({
    context: ctx,
    appInfo: () => ({
      productName: 'Skills 工作台',
      version: '0.1.0',
      appEnv: 'development',
      libraryDir: ctx.libraryDir,
      dataDir: ctx.dataDir,
      logDir: path.join(ROOT, `logs-${id}`),
      electron: '',
      chrome: '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    }),
    version: '0.1.0',
    mode: 'development',
    pickDirectory: async () => null,
    pickFile: async () => null,
    openPath: async () => '',
    logger: silentLogger(),
  });
  return { id, lib, data, ctx, handlers };
}

let A;
let B;
const ids = {};

/** 统一调用：IPC 处理器直接调用（与 Electron 主进程同一份装配）。 */
async function call(machine, channel, payload) {
  return machine.handlers[channel](payload);
}

before(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(REMOTE, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', REMOTE], { stdio: 'pipe' });

  writeSkill(path.join(SRC, 'alpha'), 'alpha', 'alpha 技能', 'alpha v1');
  writeSkill(path.join(SRC, 'beta'), 'beta', 'beta 技能', 'beta v1');
  writeSkill(path.join(SRC, 'gamma'), 'gamma', 'gamma 技能', 'gamma v1');

  A = makeMachine('a');
  const imported = await A.ctx.sources.importSkills(A.ctx.sources.discoverFromLocalDir(SRC).items);
  for (const result of imported.results) {
    assert.equal(result.status, 'imported', `${result.name}: ${result.reason ?? ''}`);
    ids[result.name] = result.skillId;
  }
  assert.equal(A.ctx.library.listSkills().length, 3);

  B = makeMachine('b');
});

after(() => {
  A?.ctx.dispose();
  B?.ctx.dispose();
});

// ═════════════════════════ 未连接 / 连接 ═════════════════════════

test('未连接：status 如实报告未连接、无最近 Pull/Push、无冲突', async () => {
  const status = await call(A, 'sync:status');
  assert.equal(status.connected, false);
  assert.equal(status.remoteUrl, null);
  assert.equal(status.gitAvailable, true);
  assert.equal(status.lastPull, null);
  assert.equal(status.lastPush, null);
  assert.deepEqual(status.pendingConflicts, []);
  assert.ok(status.notice && status.notice.includes('本机中心库'), '有连接引导说明');
  assert.ok(status.libraryDir.endsWith(path.join('t14', 'lib-a')), status.libraryDir);
});

test('本地备份：未连接远端也能 commit（git add -A + commit），无变更时报告无变化', async () => {
  const before = await call(A, 'sync:status');
  assert.equal(before.lastCommit, null, '从未备份时没有最近提交');

  editSkillBody(A.lib, 'beta', 'beta 本地编辑（未推送）');
  await A.ctx.library.rescan();

  const committed = await call(A, 'sync:commit', {});
  assert.equal(committed.status, 'committed');
  assert.ok(committed.commitId);
  assert.match(committed.message, /已备份到本地/);

  const status = await call(A, 'sync:status');
  assert.ok(status.lastCommit, '状态带出最近一次提交');
  assert.equal(status.lastCommit.commitId, committed.commitId);
  assert.equal(status.lastCommit.shortSha, committed.commitId.slice(0, 8));
  assert.ok(!Number.isNaN(Date.parse(status.lastCommit.time)), status.lastCommit.time);
  assert.ok(status.lastCommit.message.length > 0);
  assert.equal(status.connected, false, '本地备份不要求连接远端');

  const remoteHeads = execFileSync('git', ['ls-remote', REMOTE, 'refs/heads/main'], { encoding: 'utf8' }).trim();
  assert.equal(remoteHeads, '', '本地备份不会写远端');

  const again = await call(A, 'sync:commit', {});
  assert.equal(again.status, 'up-to-date');
  assert.match(again.message, /没有需要备份/);
});

test('连接：非法地址被拒并给可读原因（不改配置）', async () => {
  await assert.rejects(
    () => call(A, 'sync:connect', { url: '-oops' }),
    (err) => err.code === 'BAD_REQUEST' && /Git 远端地址/.test(err.message),
  );
  await assert.rejects(
    () => call(A, 'sync:connect', { url: 'https://user:token@example.com/repo.git' }),
    (err) => err.code === 'BAD_REQUEST' && /凭据/.test(err.message),
  );
  const status = await call(A, 'sync:status');
  assert.equal(status.connected, false);
});

test('连接：可达远端写入配置并提示；空远端 Pull 为 up-to-date', async () => {
  const connected = await call(A, 'sync:connect', { url: REMOTE });
  assert.equal(connected.connected, true);
  assert.equal(connected.remoteUrl, REMOTE);
  assert.match(connected.notice ?? '', /空远端|Pull/);

  const pulled = await call(A, 'sync:pull');
  assert.equal(pulled.status, 'up-to-date');
  assert.equal(pulled.commits, 0);
  assert.deepEqual(pulled.conflicts, []);
  assert.match(pulled.message, /没有可拉取/);

  const status = await call(A, 'sync:status');
  assert.equal(status.lastPull?.status, 'up-to-date');
  assert.ok(status.lastPull?.at);
});

// ═════════════════════════ Push / 另一台机器 Pull ═════════════════════════

test('A 改技能 Push → 另一台机器 B Pull 拉到；再次 Push 报告无变化', async () => {
  const pushed = await call(A, 'sync:push');
  assert.equal(pushed.status, 'pushed');
  assert.ok(pushed.commitId);
  assert.match(pushed.message, /已 Push/);

  const again = await call(A, 'sync:push');
  assert.equal(again.status, 'up-to-date', '没有新提交时不误报为推送成功');

  const connected = await call(B, 'sync:connect', { url: REMOTE });
  assert.equal(connected.connected, true);

  const pulled = await call(B, 'sync:pull');
  assert.equal(pulled.status, 'pulled');
  assert.equal(pulled.adopted.length, 3, '空库从远端初始化 3 个技能');
  assert.equal(pulled.conflicts.length, 0);
  assert.equal(B.ctx.library.listSkills().length, 3);
  assert.match(readSkill(B.lib, 'alpha'), /alpha v1/);

  const status = await call(B, 'sync:status');
  assert.equal(status.lastPull?.status, 'pulled');
  const history = await call(B, 'sync:history');
  assert.ok(history.items.length >= 1);
  assert.ok(history.items[0].sha && history.items[0].time);
});

test('单边改动可合并：A 改 alpha → B Pull 快进拿到', async () => {
  editSkillBody(A.lib, 'alpha', 'alpha v2 by A');
  await A.ctx.library.rescan();
  const pushed = await call(A, 'sync:push');
  assert.equal(pushed.status, 'pushed');
  alphaPushSha = pushed.commitId;

  const pulled = await call(B, 'sync:pull');
  assert.equal(pulled.status, 'pulled');
  assert.equal(pulled.commits, 1, '拉取到 1 个新版本');
  assert.equal(pulled.conflicts.length, 0);
  assert.match(readSkill(B.lib, 'alpha'), /alpha v2 by A/);

  const history = await call(B, 'sync:history');
  const item = history.items.find((row) => row.sha === pushed.commitId);
  assert.ok(item, '历史里有这次提交');
  assert.deepEqual(item.changedSkills, ['alpha']);
  assert.equal(item.changedSkillCount, 1);
  assert.ok(item.note.length > 0);
  assert.ok(!item.summary.includes('Skills-Sync'), '协议 trailer 不出现在说明里');
});

// ═════════════════════════ 同技能双改冲突 ═════════════════════════

let alphaPushSha = '';

/** 评测报告命名：`<技能名>_review_<yyyyMMdd-HHmmss>.md`；测试固定时间戳，保证两端指向同一份文件。 */
const REPORT_STAMP = '20260101-000000';
function reportRelPath(skillName, stamp = REPORT_STAMP) {
  return `reports/${skillName}_review_${stamp}.md`;
}
function writeReport(lib, skillName, text) {
  const dir = path.join(lib, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${skillName}_review_${REPORT_STAMP}.md`), text, 'utf8');
}
function latestReport(lib, skillName) {
  const dir = path.join(lib, 'reports');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((file) => file.startsWith(`${skillName}_review_`)).sort();
  return files.length > 0 ? path.join(dir, files.at(-1)) : null;
}

/** 制造分叉：A 改 gamma 并推送；B 改 gamma（不 Pull）→ B 下次 Pull 必然与本机改动冲突。 */
async function makeConflict(round, aBody, bBody) {
  editSkillBody(A.lib, 'gamma', aBody);
  writeReport(A.lib, 'gamma', `A 报告 ${round}\n`);
  await A.ctx.library.rescan();
  assert.equal((await call(A, 'sync:push')).status, 'pushed');

  editSkillBody(B.lib, 'gamma', bBody);
  writeReport(B.lib, 'gamma', `B 报告 ${round}\n`);
  await B.ctx.library.rescan();
}

test('P0 双端双改：Pull 整次失败、远端改动不落地，报出冲突技能并提示用 git 处理', async () => {
  await makeConflict('round1', 'gamma A round1', 'gamma B round1');

  await assert.rejects(
    () => call(B, 'sync:pull'),
    (err) => {
      assert.match(err.message, /gamma/, '报出冲突技能名');
      assert.match(err.message, /git/i, '提示用 git 命令自行处理');
      assert.match(err.message, /未修改任何内容|已中止/, '说明本次未落地');
      return true;
    },
  );

  // 零落地：本机版本仍在库里，远端改动未应用
  assert.match(readSkill(B.lib, 'gamma'), /gamma B round1/);
  assert.doesNotMatch(readSkill(B.lib, 'gamma'), /gamma A round1/);

  // 不产生待决冲突记录（页面已无冲突处理入口）
  const status = await call(B, 'sync:status');
  assert.equal(status.pendingConflicts.length, 0);
  assert.ok(status.lastCommit, 'Pull 前的本机变更已保存为本地提交，不丢历史');
});

// ═════════════════════════ 远端领先 / 历史 / 恢复 ═════════════════════════

let betaPushSha = '';

test('远端领先：B Push 被拒（原因 + Pull 入口），本机变更完整保留', async () => {
  editSkillBody(A.lib, 'beta', 'beta v2 by A');
  await A.ctx.library.rescan();
  const pushed = await call(A, 'sync:push');
  assert.equal(pushed.status, 'pushed');
  betaPushSha = pushed.commitId;

  editSkillBody(B.lib, 'beta', 'beta v2 by B');
  await B.ctx.library.rescan();

  const rejected = await call(B, 'sync:push');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.remoteAhead, true);
  assert.ok(rejected.reason && rejected.reason.length > 0);
  assert.match(rejected.message, /先 Pull/);
  assert.match(readSkill(B.lib, 'beta'), /beta v2 by B/, '本机变更未被覆盖');

  const status = await call(B, 'sync:status');
  assert.equal(status.lastPush?.status, 'rejected');
});

test('版本历史与版本详情：时间 / 变更数 / 说明 / 文件级差异', async () => {
  const history = await call(A, 'sync:history');
  assert.ok(history.items.length >= 4, `历史版本数 ${history.items.length}`);
  for (const item of history.items) {
    assert.match(item.sha, /^[0-9a-f]{40}$/);
    assert.ok(!Number.isNaN(Date.parse(item.time)));
    assert.equal(item.changedSkillCount, item.changedSkills.length);
  }
  const betaCommit = history.items.find((row) => row.sha === betaPushSha);
  assert.ok(betaCommit, '含 A 的 beta 提交');
  assert.ok(betaCommit.note.length > 0);
  assert.deepEqual(betaCommit.changedSkills, ['beta']);

  const alphaCommit = history.items.find((row) => row.sha === alphaPushSha);
  assert.ok(alphaCommit, '含 A 的 alpha 提交');
  assert.deepEqual(alphaCommit.changedSkills, ['alpha']);

  const detail = await call(A, 'sync:versionDetail', { sha: betaPushSha });
  assert.equal(detail.sha, betaPushSha);
  assert.equal(detail.shortSha, betaPushSha.slice(0, 8));
  assert.equal(detail.changedSkills.length, 1);
  const changed = detail.changedSkills[0];
  assert.equal(changed.dirName, 'beta');
  assert.equal(changed.name, 'beta');
  assert.ok(changed.modified.includes('skills/beta/SKILL.md'), changed.modified.join(','));
  assert.ok(detail.changedFileCount >= 1);
});

test('恢复：必须二次确认；恢复后库内容回到该版本，恢复前状态可找回', async () => {
  await assert.rejects(
    () => call(A, 'sync:restore', { sha: alphaPushSha }),
    (err) => err.code === 'BAD_REQUEST' && /确认/.test(err.message),
  );
  await assert.rejects(
    () => call(A, 'sync:restore', { sha: 'not-a-sha', confirm: true }),
    (err) => err.code === 'BAD_REQUEST',
  );

  const restored = await call(A, 'sync:restore', { sha: alphaPushSha, confirm: true });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.scope, 'library');
  assert.ok(restored.snapshotRef, '恢复前留下可回退快照');
  assert.ok(restored.changedSkills.length > 0, '恢复确实改动了库内容');
  assert.ok(restored.changedSkills.includes('beta'), restored.changedSkills.join(','));
  assert.match(readSkill(A.lib, 'gamma'), /gamma v1/, 'gamma 回到 alpha 提交时的版本');
  assert.match(restored.message, /已恢复/);

  const history = await call(A, 'sync:history');
  assert.ok(
    history.items.some((row) => row.note.startsWith('恢复整库')),
    history.items.map((row) => row.note).join(' | '),
  );
});

test('未知版本 / 空决议被拒绝（IPC 参数校验可读）', async () => {
  await assert.rejects(
    () => call(B, 'sync:versionDetail', { sha: 'abcdef1234' }),
    (err) => err.code === 'BAD_REQUEST' && /未找到版本/.test(err.message),
  );
  await assert.rejects(
    () => call(B, 'sync:resolve', { decisions: [] }),
    (err) => err.code === 'BAD_REQUEST',
  );
  await assert.rejects(
    () => call(B, 'sync:resolve', { decisions: [{ conflictId: 'x', choice: 'nope' }] }),
    (err) => err.code === 'BAD_REQUEST' && /未知/.test(err.message),
  );
});
