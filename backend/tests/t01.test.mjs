// T01 自动验证（tests/test_cases.md A 组 C-01~C-04 + 已丢失恢复 + 名称清洗）
// 运行：cd backend && npm run build && npm test
// 隔离纪律：本用例每次运行自建 tests/runtime/run-t01-* 私有目录（mkdtemp），
// 不读写 lib-dev / data-dev —— 那两个是开发态 GUI 在用的目录（backend/.env.development）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE = process.execPath;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME = path.join(PROJECT_ROOT, 'tests', 'runtime');
const RUN = fs.mkdtempSync(path.join(RUNTIME, 'run-t01-'));
const LIB = path.join(RUN, 'lib');
const SKILLS = path.join(LIB, 'skills');
const DATA = path.join(RUN, 'data');
const ASSETS = path.join(PROJECT_ROOT, 'tests', 'assets');

const {
  SkillLibraryService,
  sanitizeName,
  validateNewDirName,
  isPathSafe,
  generateSkillId,
  countFiles,
} = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href);

/** 轮询等待条件成立；超时抛错。 */
async function waitFor(predicate, { timeoutMs = 5000, stepMs = 50, label = '' } = {}) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return Date.now() - start;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor 超时(${timeoutMs}ms): ${label}`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function copySkillTo(name, destName = name) {
  fs.cpSync(path.join(ASSETS, 'sample-skills', name), path.join(SKILLS, destName), {
    recursive: true,
  });
}

let service;
let firstScanList; // C-01：首扫清单（含 ID）
let firstScanEvents; // C-01：首扫后全部事件（含真实时间）
let helloSkillId;
let lowercaseSkillId;

before(() => {
  // 生成 72 文件样本（若缺失则自行生成，保证用例自足）
  const bigSkill = path.join(RUNTIME, 'big-skill');
  if (!fs.existsSync(bigSkill)) {
    execFileSync(NODE, [path.join(ASSETS, 'generate-big-skill.mjs')], { stdio: 'inherit' });
  }

  // 本次运行目录是 mkdtemp 新建的空目录，不需要删除任何既有数据
  fs.mkdirSync(SKILLS, { recursive: true });

  copySkillTo('hello-skill');
  copySkillTo('no-name-skill');
  copySkillTo('lowercase-skill');
  fs.cpSync(bigSkill, path.join(SKILLS, 'big-skill'), { recursive: true });

  service = SkillLibraryService.create({ libraryDir: LIB, dataDir: DATA });
});

after(() => {
  service?.close();
  // 只清理本用例本次自建的运行目录
  fs.rmSync(RUN, { recursive: true, force: true });
});

test('C-01 扫描入库：4 个技能、稳定 ID、事件记录', async () => {
  const result = await service.rescan();
  assert.equal(result.total, 4);
  assert.equal(result.added, 4);
  assert.equal(result.missing, 0);

  firstScanList = service.listSkills();
  assert.equal(firstScanList.length, 4);

  const byDir = Object.fromEntries(firstScanList.map((s) => [s.dirName, s]));
  assert.ok(byDir['hello-skill'], 'hello-skill 在列');
  assert.ok(byDir['no-name-skill'], 'no-name-skill 在列');
  assert.ok(byDir['lowercase-skill'], 'lowercase-skill 在列');
  assert.ok(byDir['big-skill'], 'big-skill 在列');

  for (const s of firstScanList) {
    assert.match(s.skillId, /^sk_[0-9a-z]{17}$/, `ID 格式: ${s.dirName}`);
    assert.equal(s.missing, false);
    assert.equal(s.source?.type, 'scan');
    assert.deepEqual(s.groups, []);
  }

  helloSkillId = byDir['hello-skill'].skillId;
  lowercaseSkillId = byDir['lowercase-skill'].skillId;

  // 首扫产生 4 条 imported 事件；近期动态每技能一条
  assert.equal(service.getActivityCount(), 4);
  assert.equal(service.getRecentActivity().length, 4);

  firstScanEvents = service.getActivityCount();
});

test('C-02 缺失 name：回退目录名并标记「缺少 name」', () => {
  const s = service.listSkills().find((x) => x.dirName === 'no-name-skill');
  assert.ok(s);
  assert.equal(s.name, 'no-name-skill'); // 回退目录名
  assert.equal(s.nameSource, 'dirname');
  assert.equal(s.missingName, true); // 「缺少 name」标记
  assert.equal(s.description.includes('缺少 frontmatter name'), true);

  // 正常技能不受影响
  const hello = service.listSkills().find((x) => x.dirName === 'hello-skill');
  assert.equal(hello.nameSource, 'frontmatter');
  assert.equal(hello.missingName, false);
});

test('C-04 72 文件：文件树完整且两次扫描 ID 稳定', async () => {
  const detail = service.getSkillDetail(
    service.listSkills().find((x) => x.dirName === 'big-skill').skillId,
  );
  assert.ok(detail.fileTree, '文件树存在');
  assert.equal(countFiles(detail.fileTree), 72, '文件树完整 72 项');
  const dirs = flatten(detail.fileTree).filter((n) => n.type === 'dir').map((n) => n.relPath);
  for (const expected of ['references', 'scripts', 'assets']) {
    assert.ok(dirs.includes(expected), `包含 ${expected}/ 目录`);
  }

  const idBefore = detail.skillId;
  await service.rescan(); // 第二次扫描
  const after = service.getSkillDetail(idBefore);
  assert.equal(after.skillId, idBefore, '两次扫描 ID 稳定不变');
  assert.equal(countFiles(after.fileTree), 72);
});

test('C-03 外部改动：服务运行中改 SKILL.md → ≤3 秒索引反映 + 事件', async () => {
  service.startWatching();
  await new Promise((r) => setTimeout(r, 300)); // 等监视器就绪

  const newDescription = '外部修改后的描述（C-03 验证）';
  const skillMd = path.join(SKILLS, 'hello-skill', 'SKILL.md');
  fs.writeFileSync(
    skillMd,
    `---\nname: hello-skill\ndescription: ${newDescription}\n---\n\n# Hello Skill\n\n外部修改后的内容。\n`,
    'utf8',
  );

  const elapsed = await waitFor(
    () => service.listSkills().find((x) => x.dirName === 'hello-skill')?.description === newDescription,
    { timeoutMs: 3500, label: '外部改动反映到索引' },
  );
  assert.ok(elapsed <= 3000, `应在 3 秒内反映，实际 ${elapsed}ms`);

  // 产生 content-changed 事件（按真实发生时间）
  const recent = service.getRecentActivity();
  const helloEvent = recent.find((e) => e.skillId === helloSkillId);
  assert.equal(helloEvent.type, 'content-changed');

  // 部署摘要 / 来源在列表中可读
  const hello = service.listSkills().find((x) => x.dirName === 'hello-skill');
  assert.deepEqual(hello.deployedAgents, []);
  assert.equal(hello.source?.type, 'scan');
});

test('已丢失与恢复：删除目录 → 标丢失保留元数据；放回 → 复原且 ID 不变', async () => {
  // 外部删除技能目录（元数据是平级文件，应保留）
  fs.rmSync(path.join(SKILLS, 'lowercase-skill'), { recursive: true, force: true });

  await waitFor(
    () => service.listSkills().find((x) => x.dirName === 'lowercase-skill')?.missing === true,
    { timeoutMs: 3500, label: '外部删除 → 已丢失' },
  );
  const lost = service.listSkills().find((x) => x.dirName === 'lowercase-skill');
  assert.equal(lost.missing, true);
  assert.ok(lost.missingSince, '记录丢失时间');
  assert.equal(lost.skillId, lowercaseSkillId, '丢失时 ID 不变');
  assert.ok(
    fs.existsSync(path.join(LIB, 'sync', 'lowercase-skill.skill.json')),
    '元数据文件保留',
  );
  const lostDetail = service.getSkillDetail(lowercaseSkillId);
  assert.equal(lostDetail.fileTree, null, '丢失后无文件树');

  // 放回目录 → 状态自动复原、ID 不变
  copySkillTo('lowercase-skill');
  await waitFor(
    () => service.listSkills().find((x) => x.dirName === 'lowercase-skill')?.missing === false,
    { timeoutMs: 3500, label: '放回 → 状态复原' },
  );
  const restored = service.listSkills().find((x) => x.dirName === 'lowercase-skill');
  assert.equal(restored.missing, false);
  assert.equal(restored.skillId, lowercaseSkillId, '恢复后 ID 不变');
  assert.equal(restored.name, 'lowercase-skill');
});

test('C-01 索引重建：删 DB → 全量重建 → 清单/ID 完全一致、事件不变', async () => {
  // 在当前状态（含 C-03 的描述变更、丢失恢复）下捕获清单与事件
  const listBefore = service.listSkills().map((s) => ({ ...s }));
  const eventsBefore = service.getRecentActivity(); // 含真实时间
  const countBefore = service.getActivityCount();
  service.stopWatching();
  service.close();

  // 删除索引 DB（含 WAL/SHM）——索引必须是纯派生物
  for (const f of ['index.db', 'index.db-wal', 'index.db-shm']) {
    fs.rmSync(path.join(DATA, f), { force: true });
  }
  assert.ok(!fs.existsSync(path.join(DATA, 'index.db')), 'DB 已删除');

  service = SkillLibraryService.create({ libraryDir: LIB, dataDir: DATA });
  const rebuild = await service.rescan();
  assert.equal(rebuild.added, 0, '重建不重新登记任何技能');
  assert.equal(rebuild.changed, 0, '重建不产生内容变更');
  assert.deepEqual(rebuild.events, [], '重建不产生新事件');

  const after = service.listSkills();
  assert.deepEqual(after, listBefore, '重建前后技能清单（含 ID/名称/描述/时间）完全一致');
  assert.equal(after.length, 4);

  // 事件：数量不变、内容（含真实时间）不变
  assert.equal(service.getActivityCount(), countBefore);
  assert.deepEqual(service.getRecentActivity(), eventsBefore);
  assert.equal(firstScanEvents, 4);
});

test('名称清洗：非法字符/穿越/超长/保留名 → 不产生非法 Windows 路径', () => {
  // 非法字符剔除
  assert.equal(sanitizeName('a<b>c:d"e/f\\g|h?i*j'), 'abcdefghij');
  // 点序列折叠与穿越拒绝
  assert.equal(sanitizeName('foo..bar'), 'foo.bar');
  assert.equal(sanitizeName('..'), 'unnamed');
  assert.equal(validateNewDirName('..'), null, '拒绝 ..');
  assert.equal(validateNewDirName('...'), null, '拒绝 ...');
  assert.equal(validateNewDirName('.'), null, '拒绝 .');
  assert.equal(validateNewDirName('   '), null, '拒绝空白');
  assert.equal(validateNewDirName('<>:'), null, '全非法字符拒绝');
  // 首尾点与空白
  assert.equal(sanitizeName('  .hidden. '), 'hidden');
  // Windows 保留设备名
  assert.equal(sanitizeName('CON'), '_CON');
  assert.equal(sanitizeName('com1.txt'), '_com1.txt');
  // 超长截断（码点安全）
  const long = sanitizeName('啊'.repeat(150));
  assert.ok([...long].length <= 200);
  assert.ok(sanitizeName('a'.repeat(300)).length <= 200);
  // 空回退
  assert.equal(sanitizeName(''), 'unnamed');

  // 任意恶意输入经清洗后 join 出的路径不含非法字符与 .. 段
  const hostile = [
    '../../../etc/passwd',
    'a<b>c:d"e/f\\g|h?i*j',
    '....',
    'x.'.repeat(50),
    'NUL',
    'skill\r\nname',
  ];
  for (const input of hostile) {
    const cleaned = validateNewDirName(input) ?? sanitizeName(input);
    // 清洗结果本身必须是合法的单段 Windows 名（不含非法字符、控制符与 .. 段）
    assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(cleaned), `无非法字符: ${JSON.stringify(input)} → ${cleaned}`);
    assert.ok(cleaned !== '.' && cleaned !== '..', `不产生相对段: ${JSON.stringify(input)}`);
    assert.ok(cleaned.length > 0);
    const joined = path.join(SKILLS, cleaned);
    assert.ok(!joined.split(path.sep).includes('..'), `join 后无 .. 段: ${JSON.stringify(input)}`);
    assert.ok(path.isAbsolute(joined));
  }

  // 路径边界校验
  assert.equal(isPathSafe(SKILLS, path.join(SKILLS, 'a', 'b')), true);
  assert.equal(isPathSafe(SKILLS, path.join(SKILLS, '..', 'escape')), false);
  assert.equal(isPathSafe(SKILLS, SKILLS), true);
});

test('稳定 ID：格式、唯一性、时间可排序', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(generateSkillId());
  assert.equal(ids.size, 1000, '1000 次 generation 无碰撞');
  const a = generateSkillId(1000);
  const b = generateSkillId(2000);
  assert.ok(a < b, '时间晚的 ID 字典序更大');
});

function flatten(node) {
  const out = [node];
  for (const c of node.children ?? []) out.push(...flatten(c));
  return out;
}
