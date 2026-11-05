// T02 自动验证（tests/test_cases.md B 组导入用例 + Git/zip/扫描本机来源）
// 运行：cd backend && npm run build && node --no-warnings --test tests/t02.test.mjs
// 隔离纪律：本用例每次运行自建 tests/runtime/run-t02-* 私有目录（mkdtemp），库/数据/临时/
// 夹具/Git 仓库/模拟 Agent 目录全在里面；不读写 lib-dev、data-dev、agents-mock
// —— 那些是开发态 GUI 在用的目录（backend/.env.development、main.ts:1938）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

const NODE = process.execPath;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME = path.join(PROJECT_ROOT, 'tests', 'runtime');
const RUN = fs.mkdtempSync(path.join(RUNTIME, 'run-t02-'));
const LIB = path.join(RUN, 'lib');
const SKILLS = path.join(LIB, 'skills');
const DATA = path.join(RUN, 'data');
const TMP = path.join(RUN, 'tmp'); // TEMP_DIR
const ASSETS = path.join(PROJECT_ROOT, 'tests', 'assets');
const SRC = path.join(RUN, 'src');
const AGENTS = path.join(RUN, 'agents-mock');
const REPO_WORK = path.join(RUN, 'repo-work');
const BARE = path.join(RUN, 'repo.git');

const { SkillLibraryService, SkillSourceService, SourceError, hashSkillDir } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href
);

let library;
let sources;
let libCountBeforeBatch; // C-05 批量导入前库内数量
let sameNameSkillId; // 预先入库的 same-name v1

/** 构造一个最小合法技能目录。 */
function writeSkill(dir, name, description, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  );
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

before(async () => {
  // 本次运行目录是 mkdtemp 新建的空目录，不需要删除任何既有数据
  fs.mkdirSync(SKILLS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  // ── C-05：5 项目录（3 合法 + 1 同名异内容 + 1 无 SKILL.md）──
  writeSkill(path.join(SRC, 'batch5', 'alpha-skill'), 'alpha-skill', 'Alpha（含可执行脚本与 __pycache__ 干扰项）', 'alpha body');
  fs.mkdirSync(path.join(SRC, 'batch5', 'alpha-skill', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(SRC, 'batch5', 'alpha-skill', 'scripts', 'run.py'), 'print("alpha")\n', 'utf8');
  fs.mkdirSync(path.join(SRC, 'batch5', 'alpha-skill', '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(SRC, 'batch5', 'alpha-skill', '__pycache__', 'run.cpython-312.pyc'), 'junk', 'utf8');
  writeSkill(path.join(SRC, 'batch5', 'beta-skill'), 'beta-skill', 'Beta', 'beta body');
  writeSkill(path.join(SRC, 'batch5', 'gamma-skill'), 'gamma-skill', 'Gamma', 'gamma body');
  fs.cpSync(path.join(ASSETS, 'sample-skills', 'same-name', 'v2'), path.join(SRC, 'batch5', 'same-name-skill'), { recursive: true });
  fs.mkdirSync(path.join(SRC, 'batch5', 'not-a-skill'), { recursive: true });
  fs.writeFileSync(path.join(SRC, 'batch5', 'not-a-skill', 'README.md'), 'no SKILL.md here\n', 'utf8');

  // ── 其余夹具 ──
  fs.cpSync(path.join(ASSETS, 'sample-skills', 'hello-skill'), path.join(SRC, 'hello-src', 'hello-skill'), { recursive: true });
  fs.cpSync(path.join(ASSETS, 'sample-skills', 'same-name', 'v1'), path.join(SRC, 'pre', 'same-name-skill'), { recursive: true });
  writeSkill(path.join(SRC, 'dirA', 'a1-skill'), 'a1-skill', '来自父目录 A', 'a1 body');
  writeSkill(path.join(SRC, 'dirB', 'b1-skill'), 'b1-skill', '来自父目录 B', 'b1 body');

  // ── Git 场景：隔离区内自建 bare + 工作仓库（绝不发真实网络请求）──
  const repoWork = REPO_WORK;
  execFileSync('git', ['init', '-b', 'main', repoWork], { stdio: 'pipe' });
  writeSkill(path.join(repoWork, 'git-skill-a'), 'git-skill-a', 'Git 来源技能 A', 'git a body');
  writeSkill(path.join(repoWork, 'git-skill-b'), 'git-skill-b', 'Git 来源技能 B', 'git b body');
  git(['add', '-A'], repoWork);
  git(['-c', 'user.name=t02', '-c', 'user.email=t02@test.local', 'commit', '-m', 'skills for t02'], repoWork);
  execFileSync('git', ['init', '--bare', '-b', 'main', BARE], { stdio: 'pipe' });
  git(['push', BARE, 'main'], repoWork);

  // ── zip 夹具（含 3 个技能；测试内用 Node 生成）──
  const zipSrc = path.join(SRC, 'zip-src');
  for (const n of ['z1-skill', 'z2-skill', 'z3-skill']) {
    writeSkill(path.join(zipSrc, n), n, `zip 来源技能 ${n}`, `${n} body`);
  }
  fs.mkdirSync(path.join(SRC, 'zips'), { recursive: true });
  const zip = new AdmZip();
  zip.addLocalFolder(zipSrc);
  zip.writeZip(path.join(SRC, 'zips', 'three.zip'));
  // 非 zip：gzip 魔数（tar.gz）与纯文本伪装
  fs.writeFileSync(path.join(SRC, 'zips', 'fake.tar.gz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 1, 2, 3]));
  fs.writeFileSync(path.join(SRC, 'zips', 'fake.zip'), Buffer.from('this is definitely not a zip archive'));

  // ── 扫描本机：本用例自建的模拟 Agent 目录（run-t02-*/agents-mock）──
  writeSkill(path.join(AGENTS, 'codebuddy', 'skills', 'codebuddy-skill'), 'codebuddy-skill', 'CodeBuddy 模拟目录技能', 'cb body');
  writeSkill(path.join(AGENTS, 'claude', 'skills', 'claude-skill'), 'claude-skill', 'Claude 模拟目录技能', 'claude body');

  library = SkillLibraryService.create({ libraryDir: LIB, dataDir: DATA });
  sources = new SkillSourceService({ library, tempDir: TMP });

  // 预置：same-name v1 已入库（C-05/C-07 的同名冲突基线）
  const pre = await sources.importSkills([
    { path: path.join(SRC, 'pre', 'same-name-skill'), source: { type: 'local-dir', origin: path.join(SRC, 'pre') } },
  ]);
  assert.equal(pre.results[0].status, 'imported', '预置 same-name v1 入库');
  sameNameSkillId = pre.results[0].skillId;
  libCountBeforeBatch = library.listSkills().length;
});

after(() => {
  library?.close();
  // 只清理本用例本次自建的运行目录
  fs.rmSync(RUN, { recursive: true, force: true });
});

// ───────────────────────── C-05 批量导入部分成功 ─────────────────────────

test('C-05 批量导入：3 imported + 同名异内容失败 + 非技能目录失败，互不影响', async () => {
  const disc = sources.discoverFromLocalDir(path.join(SRC, 'batch5'));
  assert.equal(disc.items.length, 5, '发现列表含全部 5 项（含无效项）');

  const byName = Object.fromEntries(disc.items.map((i) => [i.dirName, i]));
  assert.equal(byName['not-a-skill'].isValid, false);
  assert.ok(byName['not-a-skill'].invalidReason.includes('SKILL.md'));
  assert.equal(byName['alpha-skill'].isValid, true);
  assert.equal(byName['alpha-skill'].hasExecutableScripts, true, '检测 scripts/run.py');
  assert.deepEqual(byName['alpha-skill'].executableScripts, ['scripts/run.py']);
  assert.ok(byName['alpha-skill'].sizeBytes > 0, '发现项带大小');
  // 发现是临时列表：不形成来源记录（库内数量不变）
  assert.equal(library.listSkills().length, libCountBeforeBatch);

  // __pycache__/*.pyc 不计入发现大小（与内容哈希同款忽略清单）
  const pycPath = path.join(SRC, 'batch5', 'alpha-skill', '__pycache__', 'run.cpython-312.pyc');
  const sizeBefore = byName['alpha-skill'].sizeBytes;
  fs.writeFileSync(pycPath, 'even more junk bytes to change pyc size');
  assert.equal(
    sources.discoverFromLocalDir(path.join(SRC, 'batch5')).items.find((i) => i.dirName === 'alpha-skill').sizeBytes,
    sizeBefore,
    '__pycache__/*.pyc 被忽略',
  );

  const batch = await sources.importSkills(disc.items);
  assert.equal(batch.aborted, false);

  const alpha = batch.results.find((r) => r.name === 'alpha-skill');
  const beta = batch.results.find((r) => r.name === 'beta-skill');
  const gamma = batch.results.find((r) => r.name === 'gamma-skill');
  const conflict = batch.results.find((r) => r.name === 'same-name-skill');
  const notSkill = batch.results.find((r) => r.name === 'not-a-skill');

  assert.equal(alpha.status, 'imported');
  assert.equal(beta.status, 'imported');
  assert.equal(gamma.status, 'imported');
  for (const r of [alpha, beta, gamma]) assert.match(r.skillId, /^sk_[0-9a-z]{17}$/);

  assert.equal(conflict.status, 'failed');
  assert.equal(conflict.code, 'NAME_CONFLICT');
  assert.equal(conflict.reason, '中心库已存在同名但内容不同的 Skill');
  assert.equal(conflict.skillId, null);

  assert.equal(notSkill.status, 'failed');
  assert.equal(notSkill.code, 'NOT_A_SKILL');

  // 精确新增 3 个；同名项与无效项互不影响
  assert.equal(library.listSkills().length, libCountBeforeBatch + 3);
  const dirNames = library.listSkills().map((s) => s.dirName);
  assert.ok(dirNames.includes('alpha-skill'));
  assert.ok(dirNames.includes('beta-skill'));
  assert.ok(dirNames.includes('gamma-skill'));

  // 元数据：来源按父目录归并 + sizeBytes + scripts 复制干净（__pycache__ 剥离）
  const alphaSummary = library.listSkills().find((s) => s.dirName === 'alpha-skill');
  assert.equal(alphaSummary.source.type, 'local-dir');
  assert.equal(alphaSummary.source.origin, path.join(SRC, 'batch5'));
  assert.equal(alphaSummary.source.sourceRelPath, 'alpha-skill');
  const alphaDetail = library.getSkillDetail(alphaSummary.skillId);
  assert.ok(alphaDetail.sizeBytes > 0, 'sizeBytes 已入索引/详情');
  assert.ok(fs.existsSync(path.join(SKILLS, 'alpha-skill', 'scripts', 'run.py')));
  assert.ok(!fs.existsSync(path.join(SKILLS, 'alpha-skill', '__pycache__')), '__pycache__ 不入库');

  // 库内无暂存残留
  assert.ok(fs.readdirSync(SKILLS).every((e) => !e.startsWith('.staging-')));
});

// ───────────────────────── C-06 同名同内容跳过 ─────────────────────────

test('C-06 同名同内容：再次导入 → already-in-library，库内总数不变', async () => {
  const item = {
    path: path.join(SRC, 'hello-src', 'hello-skill'),
    source: { type: 'local-dir', origin: path.join(SRC, 'hello-src') },
  };
  const first = await sources.importSkills([item]);
  assert.equal(first.results[0].status, 'imported');
  const helloId = first.results[0].skillId;
  const countAfterFirst = library.listSkills().length;

  const again = await sources.importSkills([item]);
  assert.equal(again.results[0].status, 'already-in-library');
  assert.equal(again.results[0].skillId, helloId, '返回既有 skillId');
  assert.equal(library.listSkills().length, countAfterFirst, '库内总数不变');
  assert.ok(!fs.existsSync(path.join(SKILLS, 'hello-skill', 'hello-skill')), '未产生嵌套/重复目录');
});

// ───────────────────────── C-07 同名不同内容零改动 ─────────────────────────

test('C-07 同名不同内容：单项失败，库内原技能内容哈希零变化', async () => {
  const before = hashSkillDir(path.join(SKILLS, 'same-name-skill'));
  const v2 = await sources.importSkills([
    { path: path.join(SRC, 'batch5', 'same-name-skill'), source: { type: 'local-dir', origin: path.join(SRC, 'batch5') } },
  ]);
  assert.equal(v2.results[0].status, 'failed');
  assert.equal(v2.results[0].reason, '中心库已存在同名但内容不同的 Skill');
  const after = hashSkillDir(path.join(SKILLS, 'same-name-skill'));
  assert.equal(after, before, '库内 v1 内容零改动');

  const summary = library.listSkills().find((s) => s.dirName === 'same-name-skill');
  assert.equal(summary.skillId, sameNameSkillId, 'skillId 不变（不覆盖、不改名、不另存）');
  assert.equal(library.getSkillDetail(sameNameSkillId).contentHash, before);
});

// ───────────────────────── C-08 取消零残留 ─────────────────────────

test('C-08 取消零残留：导入中 abort → 无新增半成品、TEMP_DIR 清空、已成功项保留', async () => {
  const countBefore = library.listSkills().length;
  const disc = sources.discoverFromZip(path.join(SRC, 'zips', 'three.zip'));
  assert.equal(disc.items.length, 3);
  assert.ok(disc.sessionDir, 'zip 发现带会话临时目录');

  const seen = [];
  const batch = await sources.importSkills(disc.items, {
    sessionDir: disc.sessionDir,
    onProgress: (r) => {
      seen.push(r);
      if (r.status === 'imported') sources.abort(); // 首项成功后取消
    },
  });
  assert.equal(batch.aborted, true);
  assert.equal(seen.length, 1, '只处理了一项');

  const statuses = batch.results.map((r) => `${r.status}:${r.code ?? ''}`);
  assert.equal(batch.results.filter((r) => r.status === 'imported').length, 1);
  assert.equal(batch.results.filter((r) => r.code === 'ABORTED').length, 2, '剩余项如实标记取消');

  // 库内：恰新增 1 个 zip 技能；无 z2/z3 半成品；无暂存目录
  assert.equal(library.listSkills().length, countBefore + 1);
  const dirs = fs.readdirSync(SKILLS);
  assert.ok(dirs.includes('z1-skill'), '首项已保留');
  assert.ok(!dirs.some((d) => d.startsWith('z2-skill') || d.startsWith('z3-skill')));
  assert.ok(dirs.every((d) => !d.startsWith('.staging-')), '库内无暂存目录');

  // TEMP_DIR 清空
  assert.equal(fs.readdirSync(TMP).length, 0, `TEMP_DIR 应为空，实际: ${fs.readdirSync(TMP).join(',')}`);
});

// ───────────────────────── Git 仓库来源 ─────────────────────────

test('Git 来源：bare 克隆导入成功，source.origin=仓库路径；失败克隆报结构化错误', async () => {
  const countBefore = library.listSkills().length;

  const disc = sources.discoverFromGit(BARE);
  assert.equal(disc.items.length, 2);
  assert.deepEqual(disc.items.map((i) => i.name).sort(), ['git-skill-a', 'git-skill-b']);
  assert.equal(disc.items[0].source.type, 'git');
  assert.equal(disc.items[0].source.origin, BARE);

  const batch = await sources.importSkills(disc.items, { sessionDir: disc.sessionDir });
  assert.equal(batch.results.filter((r) => r.status === 'imported').length, 2);
  assert.equal(library.listSkills().length, countBefore + 2);

  const gitSkills = library.listSkills({ sourceType: 'git', origin: BARE });
  assert.equal(gitSkills.length, 2);
  for (const s of gitSkills) {
    assert.equal(s.source.type, 'git');
    assert.equal(s.source.origin, BARE);
    assert.ok(fs.existsSync(path.join(SKILLS, s.dirName, 'SKILL.md')));
  }
  assert.equal(fs.readdirSync(TMP).length, 0, '导入后 TEMP 会话清空');

  // 克隆失败：结构化错误（code + detail），明确原因
  assert.throws(
    () => sources.discoverFromGit('E:/definitely/not/exist.git'),
    (err) => err instanceof SourceError && err.code === 'GIT_CLONE_FAILED' && err.detail.length > 0,
  );
  // git URL 安全校验：拒绝 ext:: 传输与 '-' 开头
  assert.throws(
    () => sources.discoverFromGit('ext::sh -c dir'),
    (err) => err instanceof SourceError && err.code === 'GIT_INVALID_URL',
  );
});

// ───────────────────────── 压缩包来源 ─────────────────────────

test('zip 来源：导入成功；tar.gz 与非 zip 明确报「暂不支持」', async () => {
  const countBefore = library.listSkills().length;
  const disc = sources.discoverFromZip(path.join(SRC, 'zips', 'three.zip'));
  assert.equal(disc.items.length, 3);

  const batch = await sources.importSkills([disc.items[2]], { sessionDir: disc.sessionDir });
  assert.equal(batch.results[0].status, 'imported');
  assert.equal(library.listSkills().length, countBefore + 1);
  const z3 = library.listSkills().find((s) => s.dirName === 'z3-skill');
  assert.equal(z3.source.type, 'zip');
  assert.equal(z3.source.origin, path.join(SRC, 'zips', 'three.zip'));
  assert.equal(fs.readdirSync(TMP).length, 0);

  // tar.gz：明确不支持（不是空列表、不是吞错）
  assert.throws(
    () => sources.discoverFromZip(path.join(SRC, 'zips', 'fake.tar.gz')),
    (err) => err instanceof SourceError && err.code === 'ARCHIVE_UNSUPPORTED' && err.detail.includes('暂不支持'),
  );
  // 伪 zip（文本内容）：明确不支持
  assert.throws(
    () => sources.discoverFromZip(path.join(SRC, 'zips', 'fake.zip')),
    (err) => err instanceof SourceError && err.code === 'ARCHIVE_UNSUPPORTED' && err.detail.includes('暂不支持'),
  );
});

// ───────────────────────── 扫描本机（模拟 Agent 目录） ─────────────────────────

test('扫描本机：agent 目录枚举技能，machine-scan 入库 + inLibrary 提示', async () => {
  const cbDir = path.join(AGENTS, 'codebuddy', 'skills');
  const claudeDir = path.join(AGENTS, 'claude', 'skills');

  const disc = sources.discoverFromAgentDirs([cbDir, claudeDir]);
  // 私有模拟目录里只有本用例写入的两个技能
  const owned = disc.items.filter((i) => i.dirName === 'codebuddy-skill' || i.dirName === 'claude-skill');
  assert.equal(owned.length, 2);
  const cb = disc.items.find((i) => i.dirName === 'codebuddy-skill');
  const claude = disc.items.find((i) => i.dirName === 'claude-skill');
  assert.equal(cb.source.type, 'machine-scan');
  assert.equal(cb.source.origin, cbDir);
  assert.equal(cb.inLibrary, false, '未入库技能可被发现');
  assert.equal(claude.inLibrary, false);

  const batch = await sources.importSkills([cb]);
  assert.equal(batch.results[0].status, 'imported');
  const cbSkill = library.listSkills().find((s) => s.dirName === 'codebuddy-skill');
  assert.equal(cbSkill.source.type, 'machine-scan');
  assert.equal(cbSkill.source.origin, cbDir);

  // 再次扫描：入库项被标记
  const again = sources.discoverFromAgentDirs([cbDir, claudeDir]);
  assert.equal(again.items.find((i) => i.dirName === 'codebuddy-skill').inLibrary, true);
  assert.equal(again.items.find((i) => i.dirName === 'claude-skill').inLibrary, false);
  assert.equal(library.listSkills({ sourceType: 'machine-scan' }).length, 1);
});

// ───────────────────────── C-11 来源筛选 ─────────────────────────

test('C-11 来源筛选：两个不同父目录导入后，按 origin 与 source.type 过滤正确', async () => {
  const dirA = path.join(SRC, 'dirA');
  const dirB = path.join(SRC, 'dirB');

  // 两个不同父目录分别导入（PRD 5.2：本地批量导入按父目录归并）
  const a = await sources.importSkills(sources.discoverFromLocalDir(dirA).items);
  const b = await sources.importSkills(sources.discoverFromLocalDir(dirB).items);
  assert.equal(a.results[0].status, 'imported');
  assert.equal(b.results[0].status, 'imported');
  const a1 = library.listSkills().find((s) => s.dirName === 'a1-skill');
  const b1 = library.listSkills().find((s) => s.dirName === 'b1-skill');
  assert.equal(a1.source.origin, dirA, '来源记录按父目录归并');
  assert.equal(b1.source.origin, dirB);
  assert.notEqual(a1.source.origin, b1.source.origin);

  const all = library.listSkills();
  assert.ok(all.some((s) => s.source?.type === 'git'));
  assert.ok(all.some((s) => s.source?.type === 'zip'));
  assert.ok(all.some((s) => s.source?.type === 'machine-scan'));
  assert.ok(all.some((s) => s.source?.type === 'local-dir'));

  // local-dir 过滤不含 git/zip/machine-scan
  const locals = library.listSkills({ sourceType: 'local-dir' });
  assert.ok(locals.every((s) => s.source.type === 'local-dir'));
  assert.ok(!locals.some((s) => s.dirName === 'git-skill-a'));
  assert.ok(!locals.some((s) => s.dirName === 'z3-skill'));
  assert.ok(!locals.some((s) => s.dirName === 'codebuddy-skill'));

  // 本机路径大小写不敏感的 origin 归并（PRD 5.2：按父目录筛出）
  const aList = library.listSkills({ sourceType: 'local-dir', origin: dirA });
  assert.deepEqual(aList.map((s) => s.dirName), ['a1-skill']);
  const bList = library.listSkills({ sourceType: 'local-dir', origin: dirB });
  assert.deepEqual(bList.map((s) => s.dirName), ['b1-skill']);
  const mixed = library.listSkills({ origin: dirA });
  assert.deepEqual(mixed.map((s) => s.dirName), ['a1-skill']);
});
