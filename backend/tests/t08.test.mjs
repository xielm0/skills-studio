// T08 自动验证：CLI 与并发锁（prd.md §5.14 M14、§5.1 删除语义；tec.md §5.14/§7.2/§8；
// tests/test_cases.md C-30/C-31/C-32）。
// 运行：cd backend && npm run build && node --no-warnings --test tests/t08.test.mjs
//
// 隔离纪律：所有 CLI 子进程只操作 tests/runtime/t08 下的库 / 本机数据 / 模拟 Agent 目录，
// 远端是同目录的本地 bare 仓库，绝无网络访问；凭据只用测试前缀键（结束后删除）。
// 真实交付形态：dist/cli.js 为 CJS，纯 Node 运行（不加载 Electron）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME = path.join(PROJECT_ROOT, 'tests', 'runtime');
const ROOT = path.join(RUNTIME, 't08');
const LIB = path.join(ROOT, 'lib');
const DATA = path.join(ROOT, 'data');
const TMP = path.join(ROOT, 'tmp');
const LOGS = path.join(ROOT, 'logs');
const AGENTS = path.join(ROOT, 'agents-mock');
const SAMPLES = path.join(ROOT, 'samples');
const PUBLISH = path.join(ROOT, 'cli-publish');
const SYNC = path.join(ROOT, 'sync');
const REMOTE = path.join(SYNC, 'remote.git');

const CLI = path.join(BACKEND, 'dist', 'cli.js');
const NODE_ABS = 'C:/Users/xielm/.workbuddy/binaries/node/versions/22.22.2-6/node.exe';
/** 绝对路径 node（任务硬约束）；环境不同则回退到当前解释器 */
const NODE = fs.existsSync(NODE_ABS) ? NODE_ABS : process.execPath;

const TEST_KEY = 'sk-test-T08-abcdef1234567890';
const CREDENTIAL_PREFIX = 'skills-studio-test/';

const DOMAIN = pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href;
const {
  SkillLibraryService,
  SkillSourceService,
  BackupService,
  AgentConfigService,
  SkillDeployService,
  ProviderConfigService,
  CredentialVault,
  selectBuiltinAgents,
} = await import(DOMAIN);
const { WriteLock } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'infra', 'write-lock.js')).href
);
const { WindowsCredentialStore } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'infra', 'win-credential.js')).href
);
const { publishCli, readCliVersionStamp } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'cli-publish.js')).href
);

// ── 工具 ──────────────────────────────────────────────────────────────────

function writeSkill(dir, name, description, body = 'v1 body') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf8',
  );
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function envFor(overrides = {}) {
  return {
    ...process.env,
    LIBRARY_ROOT: LIB,
    DATA_DIR: DATA,
    TEMP_DIR: TMP,
    LOG_DIR: LOGS,
    HOME_DIR: AGENTS,
    ADAPTERS: 'codebuddy,cursor',
    SKILLS_CREDENTIAL_PREFIX: CREDENTIAL_PREFIX,
    NODE_NO_WARNINGS: '1',
    ...overrides,
  };
}

/** 同步执行 CLI（真实子进程），返回退出码与解析后的 JSON。 */
function runCli(args, opts = {}) {
  const res = spawnSync(NODE, [CLI, ...args], {
    cwd: BACKEND,
    encoding: 'utf8',
    env: envFor(opts.env),
    timeout: 180_000,
  });
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    json: parseJson(res.stdout ?? ''),
    args,
  };
}

/** 异步执行 CLI（并发用例需要同时启动两个进程）。 */
function runCliAsync(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [CLI, ...args], { cwd: BACKEND, env: envFor(opts.env), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ status: code, stdout, stderr, json: parseJson(stdout), args }));
  });
}

/** 目录名映射：产品内置清单只有 codebuddy / cursor，其余由 before 写成本机自定义 Agent。 */
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
const CUSTOM_AGENT_IDS = ['claude-code', 'codex', 'windsurf', 'cline'];

function agentSkillsDir(id) {
  const plain = AGENT_PLAIN[id];
  assert.ok(plain, `未知 Agent：${id}`);
  return path.join(AGENTS, plain, 'skills');
}

function lsNames(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readMeta(dirName) {
  return JSON.parse(fs.readFileSync(path.join(LIB, 'sync',`${dirName}.skill.json`), 'utf8'));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return Date.now() - started;
    if (Date.now() - started >= timeoutMs) throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    await sleep(100);
  }
}

/** 用领域服务初始化一个可同步的库（模拟 GUI 侧；CLI 只负责后续命令）。 */
async function initBackupMachine(libDir, dataDir, remoteUrl) {
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const library = SkillLibraryService.create({ libraryDir: libDir, dataDir });
  const lock = new WriteLock({ dataDir });
  const backup = new BackupService({ library, dataDir, lock });
  const status = await backup.init({ remoteUrl });
  library.close();
  return status;
}

// ── 环境 ──────────────────────────────────────────────────────────────────

before(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const dir of [LIB, DATA, TMP, LOGS, AGENTS, SAMPLES, SYNC]) fs.mkdirSync(dir, { recursive: true });
  for (const id of Object.keys(AGENT_PLAIN)) fs.mkdirSync(agentSkillsDir(id), { recursive: true });
  // 产品内置清单只有 codebuddy / cursor；CLI 用例需要更多部署目标，写成本机自定义 Agent
  fs.writeFileSync(
    path.join(DATA, 'agents.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        agents: CUSTOM_AGENT_IDS.map((id) => ({
          id,
          name: AGENT_NAMES[id],
          skillsDir: agentSkillsDir(id),
          enabled: true,
          builtin: false,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.mkdirSync(path.join(LIB, 'reports'), { recursive: true });

  // 主链路样本（本地目录安装）
  writeSkill(path.join(SAMPLES, 'hello-skill'), 'hello-skill', 'T08 全链路样本', 'hello v1');
  writeSkill(path.join(SAMPLES, 'leak-skill'), 'leak-skill', 'T08 脱敏样本', 'leak v1');
  writeSkill(path.join(SAMPLES, 'watch-skill'), 'watch-skill', 'T08 监视样本', 'watch v1');

  // 并发/锁用例样本
  writeSkill(path.join(SAMPLES, 'conc-skill'), 'conc-skill', 'T08 并发样本', 'conc v1');
  writeSkill(path.join(SAMPLES, 'locked-skill'), 'locked-skill', 'T08 锁样本', 'locked v1');

  // 同步用例：本地 bare 远端 + 两台「机器」
  spawnSync('git', ['init', '--bare', '-b', 'main', REMOTE], { stdio: 'pipe' });
  writeSkill(path.join(SYNC, 'src', 'alpha'), 'alpha', '同步样本 alpha', 'alpha v1');
});

after(() => {
  try {
    const vault = new CredentialVault(new WindowsCredentialStore(), CREDENTIAL_PREFIX);
    vault.delete('openai-compatible');
  } catch {
    /* 清理失败不掩盖测试结果 */
  }
});

// ═════════════════════════ C-30 JSON 契约与退出码 ═════════════════════════

test('C-30a --json 契约：version/list/agents list 输出可解析，成功为 {ok:true}', () => {
  const version = runCli(['version', '--json']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.json?.ok, true);
  assert.match(String(version.json.data.version), /^\d+\.\d+\.\d+/);
  assert.equal(version.json.data.node, process.version);

  const list = runCli(['skills', 'list', '--json']);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.json?.ok, true);
  assert.equal(list.json.data.count, 0);
  assert.deepEqual(list.json.data.skills, []);

  const agents = runCli(['agents', 'list', '--json']);
  assert.equal(agents.status, 0, agents.stderr);
  assert.equal(agents.json?.ok, true);
  assert.equal(agents.json.data.count, selectBuiltinAgents('codebuddy,cursor').length + CUSTOM_AGENT_IDS.length);
  assert.equal(agents.json.data.agents.every((a) => a.installed === true), true);

  // 人类可读模式同样成功（不输出 JSON，但仍要有可读行）
  const human = runCli(['skills', 'list']);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(parseJson(human.stdout), null);
  assert.match(human.stdout, /没有匹配的技能/);
});

test('C-30b 参数错误：未知命令/未知选项/缺参数 → 退出码 2 且含错误码', () => {
  const unknownCmd = runCli(['skills', 'nope', '--json']);
  assert.equal(unknownCmd.status, 2);
  assert.equal(unknownCmd.json?.ok, false);
  assert.equal(unknownCmd.json.error.code, 'UNKNOWN_COMMAND');

  const unknownOption = runCli(['skills', 'list', '--nope', '--json']);
  assert.equal(unknownOption.status, 2);
  assert.equal(unknownOption.json.error.code, 'UNKNOWN_OPTION');

  const missingArg = runCli(['skills', 'show', '--json']);
  assert.equal(missingArg.status, 2);
  assert.equal(missingArg.json.error.code, 'MISSING_ARG');

  const badSource = runCli(['skills', 'install', 'ftp', 'x', '--json']);
  assert.equal(badSource.status, 2);
  assert.equal(badSource.json.error.code, 'INVALID_SOURCE_TYPE');

  const bare = runCli(['--json']);
  assert.equal(bare.status, 2);
  assert.equal(bare.json.error.code, 'UNKNOWN_COMMAND');
});

// ═════════════════════════ 安装 → 部署 → 删除全链路 ═════════════════════════

let helloId = '';

test('C-31a 安装（dir）→ list 可见 → show 含 Group/来源/部署/评测状态', () => {
  const installed = runCli(['skills', 'install', 'dir', path.join(SAMPLES, 'hello-skill'), '--json']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.json.ok, true);
  assert.equal(installed.json.data.imported, 1);
  assert.equal(installed.json.data.failed, 0);
  helloId = installed.json.data.results[0].skillId;
  assert.match(helloId, /^sk_/);

  const list = runCli(['skills', 'list', '--json']);
  const item = list.json.data.skills.find((s) => s.skillId === helloId);
  assert.ok(item, 'list 应包含刚安装的技能');
  assert.equal(item.name, 'hello-skill');
  assert.equal(item.hasReport, false);
  assert.equal(item.source.type, 'local-dir');

  // 按名称查询与按 ID 查询结果一致
  const byName = runCli(['skills', 'show', 'hello-skill', '--json']);
  assert.equal(byName.status, 0, byName.stderr);
  const byId = runCli(['skills', 'show', helloId, '--json']);
  assert.equal(byId.status, 0, byId.stderr);
  assert.equal(byName.json.data.skillId, byId.json.data.skillId);
  assert.equal(byId.json.data.groups.length, 0);
  assert.equal(byId.json.data.reportPath, null);
  assert.ok(Array.isArray(byId.json.data.fileTree?.children));

  // 同内容重复安装 → already-in-library，不产生第二份
  const again = runCli(['skills', 'install', 'dir', path.join(SAMPLES, 'hello-skill'), '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.data.skipped, 1);
  assert.equal(again.json.data.imported, 0);

  // 不存在的技能：业务错误退出码 1
  const missing = runCli(['skills', 'show', 'no-such-skill', '--json']);
  assert.equal(missing.status, 1);
  assert.equal(missing.json.error.code, 'SKILL_NOT_FOUND');
});

test('C-31b deploy 建链接且幂等；list 反映真实部署状态', () => {
  const target = path.join(agentSkillsDir('codebuddy'), 'hello-skill');
  const deployed = runCli(['skills', 'deploy', 'hello-skill', '--agents', 'codebuddy', '--json']);
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.equal(deployed.json.data.summary.deployed, 1);
  assert.ok(fs.lstatSync(target).isSymbolicLink(), '目标应为链接（symlink/junction）');
  assert.equal(fs.existsSync(path.join(target, 'SKILL.md')), true, '链接应读到库内真身');

  // 幂等：再部署一次不新增条目
  const again = runCli(['skills', 'deploy', 'hello-skill', '--agents', 'codebuddy', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.data.summary.already, 1);
  assert.equal(lsNames(agentSkillsDir('codebuddy')).filter((n) => n === 'hello-skill').length, 1);

  const list = runCli(['skills', 'list', '--json']);
  const item = list.json.data.skills.find((s) => s.skillId === helloId);
  assert.deepEqual(item.deployedAgents, ['codebuddy']);
  // 查询路径也必须走真实链接探针，而不是只回显同步意图
  assert.deepEqual(item.configuredAgents, ['codebuddy']);
});

test('C-31c remove 无 --yes：拒绝、非零退出、说明将撤下的链接数，且零改动', () => {
  const target = path.join(agentSkillsDir('codebuddy'), 'hello-skill');
  const refused = runCli(['skills', 'remove', 'hello-skill', '--json']);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.error.code, 'CONFIRMATION_REQUIRED');
  assert.match(refused.json.error.detail, /1 个受管理链接/);

  // 零改动：链接、库目录、元数据都还在
  assert.ok(fs.lstatSync(target).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(LIB, 'skills', 'hello-skill', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(LIB, 'sync','hello-skill.skill.json')));

  // 人类可读模式同样以非零退出并打印错误码
  const human = runCli(['skills', 'remove', 'hello-skill']);
  assert.equal(human.status, 1);
  assert.match(human.stderr, /CONFIRMATION_REQUIRED/);
});

test('C-31d remove --yes：链接消失、库/元数据/报告全清、非归属实体目录原样保留', () => {
  const managed = path.join(agentSkillsDir('codebuddy'), 'hello-skill');
  // 预置 1：同一批 Agent 目录里放一个**非归属实体目录**（同名，代表别人手动装的）
  const foreign = path.join(agentSkillsDir('claude-code'), 'hello-skill');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'SKILL.md'), '---\nname: hello-skill\n---\n外人所有\n', 'utf8');
  const foreignHash = sha256File(path.join(foreign, 'SKILL.md'));

  // 预置 2：指向别处的链接（同样不属于本技能，删除时必须保留）
  const external = path.join(ROOT, 'external-skill');
  writeSkill(external, 'hello-skill', '外部目录', 'external own');
  const externalHash = sha256File(path.join(external, 'SKILL.md'));
  const elsewhere = path.join(agentSkillsDir('codex'), 'hello-skill');
  try {
    fs.symlinkSync(external, elsewhere, 'junction');
  } catch {
    fs.symlinkSync(external, elsewhere, 'dir');
  }

  // 预置评测报告（reports/<技能名>_review_<时间戳>.md）
  const reportPath = path.join(LIB, 'reports', 'hello-skill_review_20260101-000000.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, '# 评测报告\n\n旧报告\n', 'utf8');
  assert.equal(runCli(['skills', 'show', 'hello-skill', '--json']).json.data.hasReport, true);

  const removed = runCli(['skills', 'remove', 'hello-skill', '--yes', '--json']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.json.ok, true);
  const data = removed.json.data;

  assert.equal(data.removedLinks, 1);
  assert.equal(data.removedLinkDetails[0].agentId, 'codebuddy');
  assert.equal(data.reportDeleted, true);
  assert.equal(data.metadataDeleted, true);
  assert.equal(data.libraryDirDeleted, true);
  assert.equal(data.remainingSkills, 0);

  // 非归属实体目录：保留、内容不变，并出现在 skippedTargets
  const skipped = data.skippedTargets.find((s) => s.agentId === 'claude-code');
  assert.ok(skipped, `skippedTargets 应包含实体目录：${JSON.stringify(data.skippedTargets)}`);
  assert.equal(skipped.targetKind, 'dir');
  assert.ok(fs.existsSync(foreign));
  assert.equal(sha256File(path.join(foreign, 'SKILL.md')), foreignHash);

  // 指向别处的链接：保留、目标内容不变
  const skippedLink = data.skippedTargets.find((s) => s.agentId === 'codex');
  assert.ok(skippedLink, 'skippedTargets 应包含指向别处的链接');
  assert.equal(skippedLink.targetKind, 'link-elsewhere');
  assert.equal(skippedLink.code, 'TARGET_REPLACED');
  assert.ok(fs.lstatSync(elsewhere).isSymbolicLink());
  assert.equal(sha256File(path.join(external, 'SKILL.md')), externalHash);

  // 受管理侧清理干净：无空壳、无残留链接
  assert.equal(lsNames(agentSkillsDir('codebuddy')).includes('hello-skill'), false);
  assert.equal(fs.existsSync(managed), false);
  assert.equal(fs.existsSync(path.join(LIB, 'skills', 'hello-skill')), false);
  assert.equal(fs.existsSync(path.join(LIB, 'sync','hello-skill.skill.json')), false);
  assert.equal(fs.existsSync(reportPath), false);

  // 索引同步清理（不是只删文件）
  const list = runCli(['skills', 'list', '--json']);
  assert.equal(list.json.data.count, 0);
  assert.equal(runCli(['skills', 'show', 'hello-skill', '--json']).status, 1);
});

test('skills install zip：压缩包来源复用同一入库流程；list 筛选（group/source-type/origin）', async () => {
  const AdmZip = (await import('adm-zip')).default;
  const src = path.join(SAMPLES, 'zip-skill');
  writeSkill(src, 'zip-skill', 'T08 压缩包样本', 'zip v1');
  const zipPath = path.join(SAMPLES, 'zip-skill.zip');
  const zip = new AdmZip();
  zip.addLocalFolder(src);
  zip.writeZip(zipPath);

  const installed = runCli(['skills', 'install', 'zip', zipPath, '--json']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.json.data.imported, 1);
  const skillId = installed.json.data.results[0].skillId;

  const byType = runCli(['skills', 'list', '--source-type', 'zip', '--json']);
  assert.equal(byType.json.data.count, 1);
  assert.equal(byType.json.data.skills[0].skillId, skillId);
  assert.equal(byType.json.data.skills[0].source.type, 'zip');

  const byOrigin = runCli(['skills', 'list', '--origin', zipPath, '--json']);
  assert.equal(byOrigin.json.data.count, 1);
  assert.equal(byOrigin.json.data.skills[0].skillId, skillId);

  const byGroup = runCli(['skills', 'list', '--group', '不存在的组', '--json']);
  assert.equal(byGroup.json.data.count, 0);

  const localOnly = runCli(['skills', 'list', '--source-type', 'local-dir', '--json']);
  assert.equal(localOnly.json.data.count, 0);
});

test('agents add-custom：新增自定义 Agent 并可被 list 看到', () => {
  const customDir = path.join(ROOT, 'agents-extra', 'my-agent', 'skills');
  fs.mkdirSync(customDir, { recursive: true });
  const added = runCli(['agents', 'add-custom', '--name', 'My Agent', '--skills-dir', customDir, '--json']);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.json.data.builtin, false);
  assert.equal(added.json.data.installed, true);

  const list = runCli(['agents', 'list', '--json']);
  assert.equal(list.json.data.count, selectBuiltinAgents('codebuddy,cursor').length + CUSTOM_AGENT_IDS.length + 1);
  assert.ok(list.json.data.agents.some((a) => a.name === 'My Agent'));

  // 非绝对路径 → 业务错误（领域服务校验，不静默改相对路径）
  const bad = runCli(['agents', 'add-custom', '--name', 'Bad', '--skills-dir', 'relative/dir', '--json']);
  assert.equal(bad.status, 1);
  assert.equal(bad.json.error.code, 'AGENT_INVALID_DIR');
});

// ═════════════════════════ 密钥不泄露（C-27 延伸） ═════════════════════════

test('CLI 输出不含 API Key 明文（含调用失败的错误路径）', () => {
  const providers = new ProviderConfigService({
    dataDir: DATA,
    credentialPrefix: CREDENTIAL_PREFIX,
  });
  providers.addProvider({
    preset: 'openai-compatible',
    name: '本地死端口',
    baseUrl: 'http://127.0.0.1:9',
  });
  providers.addModel('openai-compatible', 'fake-model');
  providers.setActiveProvider('openai-compatible');
  providers.setApiKey('openai-compatible', TEST_KEY);

  // 落盘配置本身不含明文 Key（Key 在凭据管理器）
  const configRaw = fs.readFileSync(path.join(DATA, 'agent-providers.json'), 'utf8');
  assert.equal(configRaw.includes(TEST_KEY), false, 'agent-providers.json 不得包含明文 Key');

  const outputs = [];
  const leakCheck = runCli(['skills', 'check', 'leak-skill', '--json']);
  outputs.push(leakCheck);
  outputs.push(runCli(['agents', 'list', '--json']));
  outputs.push(runCli(['sync', 'status', '--json']));
  outputs.push(runCli(['version', '--json']));
  outputs.push(runCli(['skills', 'show', 'leak-skill', '--json']));

  for (const out of outputs) {
    const text = `${out.stdout}\n${out.stderr}`;
    assert.equal(text.includes(TEST_KEY), false, `${out.args.join(' ')} 输出泄露了 Key`);
    assert.equal(text.includes(TEST_KEY.slice(0, 12)), false, `${out.args.join(' ')} 输出泄露了 Key 片段`);
  }

  // 失败路径必须是结构化错误而不是崩溃/裸文本
  assert.notEqual(leakCheck.status, 0);
  assert.equal(leakCheck.json?.ok, false);
  assert.ok(typeof leakCheck.json.error.code === 'string' && leakCheck.json.error.code.length > 0);

  // 清掉供应商配置，避免影响后续用例（凭据在 after 中删除）
  fs.rmSync(path.join(DATA, 'agent-providers.json'), { force: true });
});

// ═════════════════════════ 同步 status / push / pull / 冲突 ═════════════════════════

const SYNC_A = { lib: path.join(SYNC, 'a', 'lib'), data: path.join(SYNC, 'a', 'data'), agents: path.join(SYNC, 'a', 'agents') };
const SYNC_B = { lib: path.join(SYNC, 'b', 'lib'), data: path.join(SYNC, 'b', 'data'), agents: path.join(SYNC, 'b', 'agents') };

function syncEnv(machine) {
  return { LIBRARY_ROOT: machine.lib, DATA_DIR: machine.data, HOME_DIR: machine.agents, ADAPTERS: 'codebuddy,cursor' };
}

test('sync status/push：未初始化与已推送的结构化输出', async () => {
  const beforeInit = runCli(['sync', 'status', '--json'], { env: syncEnv(SYNC_A) });
  assert.equal(beforeInit.status, 0, beforeInit.stderr);
  assert.equal(beforeInit.json.ok, true);
  assert.equal(beforeInit.json.data.gitAvailable, true);
  assert.equal(beforeInit.json.data.initialized, false);
  assert.equal(beforeInit.json.data.remoteUrl, null);

  // 未配置远端 → 结构化业务错误（不是崩溃）
  const noRemote = runCli(['sync', 'push', '--json'], { env: syncEnv(SYNC_A) });
  assert.equal(noRemote.status, 1);
  assert.equal(noRemote.json.error.code, 'GIT_REMOTE_NOT_CONFIGURED');

  // 模拟 GUI 侧完成 init（CLI 不提供 init/remote 配置命令，符合 PRD 命令分组）
  const status = await initBackupMachine(SYNC_A.lib, SYNC_A.data, REMOTE);
  assert.equal(status.remoteUrl, REMOTE);

  const installed = runCli(['skills', 'install', 'dir', path.join(SYNC, 'src', 'alpha'), '--json'], {
    env: syncEnv(SYNC_A),
  });
  assert.equal(installed.status, 0, installed.stderr);

  const pushed = runCli(['sync', 'push', '--message', 'T08 A 首次备份', '--json'], { env: syncEnv(SYNC_A) });
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(pushed.json.data.status, 'pushed');
  assert.match(pushed.json.data.commitId, /^[0-9a-f]{40}$/);

  const afterPush = runCli(['sync', 'status', '--json'], { env: syncEnv(SYNC_A) });
  assert.equal(afterPush.json.data.initialized, true);
  assert.equal(afterPush.json.data.pendingConflictCount, 0);
  assert.equal(afterPush.json.data.headCommit, pushed.json.data.commitId);

  // 远端已是最新：再次 push 不误报失败
  const again = runCli(['sync', 'push', '--json'], { env: syncEnv(SYNC_A) });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.data.status, 'up-to-date');
});

test('sync pull：另一库拉到内容（bootstrap），本机不认识本机路径', async () => {
  await initBackupMachine(SYNC_B.lib, SYNC_B.data, REMOTE);
  const pulled = runCli(['sync', 'pull', '--json'], { env: syncEnv(SYNC_B) });
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.equal(pulled.json.data.status, 'initialized');
  assert.deepEqual(pulled.json.data.adopted.length, 1);

  const list = runCli(['skills', 'list', '--json'], { env: syncEnv(SYNC_B) });
  assert.equal(list.json.data.count, 1);
  assert.equal(list.json.data.skills[0].name, 'alpha');
  assert.equal(fs.existsSync(path.join(SYNC_B.lib, 'skills', 'alpha', 'SKILL.md')), true);

  // 远端来源路径不落 B 的本机副本（跨机可移植）
  const bMeta = JSON.parse(fs.readFileSync(path.join(SYNC_B.lib, 'sync', 'alpha.skill.json'), 'utf8'));
  assert.equal(bMeta.source.origin, undefined, 'B 不应写入 A 的本机绝对来源路径');
});

test('C-32a 同技能双改：pull 返回冲突清单、退出码非 0、code=SYNC_CONFLICT_PENDING', async () => {
  // 双端改同一技能（内容不同）
  const aFile = path.join(SYNC_A.lib, 'skills', 'alpha', 'SKILL.md');
  const bFile = path.join(SYNC_B.lib, 'skills', 'alpha', 'SKILL.md');
  fs.writeFileSync(aFile, '---\nname: alpha\ndescription: 同步样本 alpha\n---\n\nA 的改动\n', 'utf8');
  fs.writeFileSync(bFile, '---\nname: alpha\ndescription: 同步样本 alpha\n---\n\nB 的改动\n', 'utf8');

  const pushA = runCli(['sync', 'push', '--message', 'A 改 alpha', '--json'], { env: syncEnv(SYNC_A) });
  assert.equal(pushA.status, 0, pushA.stderr);

  const pulled = runCli(['sync', 'pull', '--json'], { env: syncEnv(SYNC_B) });
  assert.equal(pulled.status, 1, '冲突未决必须非零退出');
  assert.equal(pulled.json.ok, false);
  assert.equal(pulled.json.error.code, 'SYNC_CONFLICT_PENDING');
  assert.ok(Array.isArray(pulled.json.error.conflicts) && pulled.json.error.conflicts.length >= 1);
  const conflict = pulled.json.error.conflicts.find((c) => c.dirName === 'alpha');
  assert.ok(conflict, `冲突清单应包含 alpha：${JSON.stringify(pulled.json.error.conflicts)}`);
  assert.ok(typeof conflict.kind === 'string');

  // 本机内容不被静默覆盖
  assert.match(fs.readFileSync(bFile, 'utf8'), /B 的改动/);
  const status = runCli(['sync', 'status', '--json'], { env: syncEnv(SYNC_B) });
  assert.equal(status.json.data.pendingConflictCount >= 1, true);
});

// ═════════════════════════ 并发（C-32） ═════════════════════════

test('C-32b 两个 CLI 并发 deploy 同一技能：均成功且只有一份链接', async () => {
  const installed = runCli(['skills', 'install', 'dir', path.join(SAMPLES, 'conc-skill'), '--json']);
  assert.equal(installed.status, 0, installed.stderr);

  const [a, b] = await Promise.all([
    runCliAsync(['skills', 'deploy', 'conc-skill', '--agents', 'cursor', '--json']),
    runCliAsync(['skills', 'deploy', 'conc-skill', '--agents', 'cursor', '--json']),
  ]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);

  const target = path.join(agentSkillsDir('cursor'), 'conc-skill');
  assert.ok(fs.lstatSync(target).isSymbolicLink());
  assert.equal(lsNames(agentSkillsDir('cursor')).filter((n) => n === 'conc-skill').length, 1);

  // 幂等语义可由汇总状态体现（一次 deployed 一次 already，顺序不定）
  const totals = [a.json.data.summary, b.json.data.summary].reduce(
    (acc, s) => ({ deployed: acc.deployed + s.deployed, already: acc.already + s.already }),
    { deployed: 0, already: 0 },
  );
  assert.equal(totals.deployed + totals.already, 2);
});

test('C-32e 两个 CLI 同时 install 同一技能：库里恰好一份，不留半成品（跨进程不再互斥）', async () => {
  const source = path.join(SAMPLES, 'race-skill');
  writeSkill(source, 'race-skill', '并发导入样本');

  const [a, b] = await Promise.all([
    runCliAsync(['skills', 'install', 'dir', source, '--json']),
    runCliAsync(['skills', 'install', 'dir', source, '--json']),
  ]);

  // 不要求两个都成功：没有跨进程互斥时，后到的可能报冲突或跳过
  assert.ok(
    a.status === 0 || b.status === 0,
    `至少一个应成功：a=${a.status} b=${b.status}\n${a.stderr}\n${b.stderr}`,
  );

  // 能抓住的真实问题：留下半个目录、暂存目录没清、元数据重复
  const entries = lsNames(path.join(LIB, 'skills'));
  assert.equal(entries.filter((n) => n === 'race-skill').length, 1, '库内应恰好一份技能目录');
  assert.deepEqual(entries.filter((n) => n.startsWith('.staging-')), [], '不应残留暂存目录');
  const metaEntries = fs.existsSync(path.join(LIB, 'sync'))
    ? fs.readdirSync(path.join(LIB, 'sync'))
    : [];
  assert.equal(
    metaEntries.filter((n) => n === 'race-skill.skill.json').length,
    1,
    '元数据应恰好一份（收在 sync/ 下）',
  );
  const listed = runCli(['skills', 'list', '--json']);
  assert.equal(listed.json.data.skills.filter((s) => s.dirName === 'race-skill').length, 1);
});

test('C-32d CLI 写入后进程内 watcher 3 秒内看到索引变化', async () => {
  const lock = new WriteLock({ dataDir: DATA });
  const library = SkillLibraryService.create({ libraryDir: LIB, dataDir: DATA, lock });
  library.startWatching();
  try {
    const added = runCli(['skills', 'install', 'dir', path.join(SAMPLES, 'watch-skill'), '--json']);
    assert.equal(added.status, 0, added.stderr);
    const elapsed = await waitFor(
      () => library.listSkills().some((s) => s.dirName === 'watch-skill'),
      3000,
      '进程内 watcher 未在 3 秒内反映 CLI 的写入',
    );
    assert.ok(elapsed < 3000, `反映耗时 ${elapsed}ms 超出 3s`);
  } finally {
    library.stopWatching();
    library.close();
  }
});

// ═════════════════════════ 版本化发布 ═════════════════════════

test('publishCli：复制程序与运行依赖 + skills.cmd + 版本戳，发布副本可独立运行', () => {
  const configuredMode = JSON.parse(fs.readFileSync(path.join(BACKEND, 'src', 'config.json'), 'utf8')).CURRENT_ENV;
  const sourceDefault = runCli(['version', '--json']);
  assert.equal(sourceDefault.status, 0, sourceDefault.stderr);
  assert.equal(sourceDefault.json?.data?.mode, configuredMode);
  const sourceUat = runCli(['version', '--json', '--env=uat']);
  assert.equal(sourceUat.status, 0, sourceUat.stderr);
  assert.equal(sourceUat.json?.data?.mode, 'uat');

  const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
  const publishOptions = { targetDir: PUBLISH, mode: 'production', envFile: path.join(BACKEND, '.env.production') };
  const first = publishCli(publishOptions);

  assert.equal(first.version, pkg.version);
  assert.equal(fs.existsSync(path.join(PUBLISH, 'cli.js')), true);
  // dist/cli.js 是多文件 CJS 产物：同目录的 env.js / domain / infra 必须一起发布，
  // 否则 require('./env') 直接 MODULE_NOT_FOUND（过期/残缺二进制比没有更危险）。
  for (const rel of ['env.js', 'logger.js', 'domain/library.js', 'infra/write-lock.js']) {
    assert.equal(fs.existsSync(path.join(PUBLISH, rel)), true, `发布产物缺少 ${rel}`);
  }
  assert.equal(fs.existsSync(path.join(PUBLISH, 'node_modules', '@skills-studio', 'agent', 'dist', 'skills', 'skill-creator', 'SKILL.md')), true);
  assert.equal(fs.lstatSync(path.join(PUBLISH, 'node_modules', '@skills-studio', 'agent')).isSymbolicLink(), false, '发布副本不能链接回源码目录');
  assert.equal(fs.existsSync(path.join(PUBLISH, 'main.js')), false, 'Electron 专用文件不应进入 CLI 产物');
  // CLI/Agent/GUI 三部分边界：CLI 不带会话内核。Pi 及厂商 SDK 属 agent 部分，不进发布副本。
  assert.ok(first.dependencyCount >= 3 && first.dependencyCount <= 30, `CLI 运行依赖闭包异常：${first.dependencyCount}`);
  assert.equal(
    fs.existsSync(path.join(PUBLISH, 'node_modules', '@earendil-works', 'pi-coding-agent')),
    false,
    'Pi 是会话内核依赖，不应进入 CLI 发布副本',
  );

  const cmd = fs.readFileSync(path.join(PUBLISH, 'skills.cmd'), 'utf8');
  assert.match(cmd, /node "%~dp0cli\.js" %\*/);
  assert.ok(cmd.indexOf('\r\n') > 0, 'skills.cmd 应使用 CRLF（cmd.exe 兼容）');

  const stamp = JSON.parse(fs.readFileSync(path.join(PUBLISH, 'version.json'), 'utf8'));
  assert.equal(stamp.version, pkg.version);
  assert.equal(stamp.schemaVersion, 4);
  assert.equal(stamp.mode, 'production');
  assert.equal(stamp.cliSha256, sha256File(CLI));
  assert.equal(stamp.cliSha256, sha256File(path.join(PUBLISH, 'cli.js')));
  assert.deepEqual(stamp.files, ['cli.js', 'skills.cmd', '.env.selected', 'version.json']);
  assert.ok(Array.isArray(stamp.programFiles) && stamp.programFiles.includes('cli.js'));
  assert.equal(readCliVersionStamp(PUBLISH)?.version, pkg.version);

  // 发布副本必须真的能跑（纯 Node，不依赖 Electron / 源码目录）
  const runPublished = (args) =>
    spawnSync(NODE, [path.join(PUBLISH, 'cli.js'), ...args], {
      cwd: PUBLISH,
      encoding: 'utf8',
      env: envFor(),
      timeout: 120_000,
    });
  const versionOut = runPublished(['version', '--json']);
  assert.equal(versionOut.status, 0, versionOut.stderr);
  const versionJson = parseJson(versionOut.stdout);
  assert.equal(versionJson?.ok, true);
  assert.equal(versionJson.data.version, pkg.version);
  assert.equal(versionJson.data.published.version, pkg.version);

  // 不提供 CLI 路径覆盖，从别的工作目录启动：发布副本仍应使用真实 home 形态。
  const isolatedHome = path.join(ROOT, 'published-home');
  const isolatedAppData = path.join(ROOT, 'published-appdata');
  const cleanEnv = { ...process.env, USERPROFILE: isolatedHome, APPDATA: isolatedAppData, NODE_NO_WARNINGS: '1' };
  for (const key of ['HOME_DIR', 'DATA_DIR', 'LIBRARY_ROOT', 'TEMP_DIR', 'LOG_DIR', 'ADAPTERS', 'SKILLS_CLI_ENV']) delete cleanEnv[key];
  const runWithoutOverrides = () => spawnSync(NODE, [path.join(PUBLISH, 'cli.js'), 'version', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv,
    timeout: 120_000,
  });
  const defaultOut = runWithoutOverrides();
  assert.equal(defaultOut.status, 0, defaultOut.stderr);
  const defaultVersion = parseJson(defaultOut.stdout)?.data;
  assert.equal(defaultVersion?.mode, 'production');
  assert.equal(defaultVersion?.libraryDir, path.join(isolatedHome, '.skills-studio', 'skills-library'));
  assert.equal(defaultVersion?.dataDir, path.join(isolatedAppData, 'skills-studio'));

  const movedLibrary = path.join(ROOT, 'moved-library');
  fs.mkdirSync(path.join(isolatedAppData, 'skills-studio'), { recursive: true });
  fs.writeFileSync(path.join(isolatedAppData, 'skills-studio', 'app-state.json'), JSON.stringify({ libraryPath: movedLibrary }));
  const movedOut = runWithoutOverrides();
  assert.equal(movedOut.status, 0, movedOut.stderr);
  assert.equal(parseJson(movedOut.stdout)?.data?.libraryDir, movedLibrary);
  const rejectedOverride = runPublished(['version', '--json', '--env=uat']);
  assert.equal(rejectedOverride.status, 2);

  const listOut = runPublished(['skills', 'list', '--json']);
  assert.equal(listOut.status, 0, listOut.stderr);
  assert.equal(parseJson(listOut.stdout)?.ok, true);
  const unknownOut = runPublished(['skills', 'nope', '--json']);
  assert.equal(unknownOut.status, 2);

  // 副本内第三方依赖真实可加载（js-yaml：SKILL.md frontmatter 解析的实际依赖）
  const yamlProbe = spawnSync(
    NODE,
    ['-e', "const y = require('js-yaml'); console.log('ok:' + typeof y.load)"],
    { cwd: PUBLISH, encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(yamlProbe.status, 0, yamlProbe.stderr);
  assert.match(yamlProbe.stdout, /ok:function/);

  // 过期/损坏的副本必须被覆盖（过期二进制比缺失更危险）
  fs.writeFileSync(path.join(PUBLISH, 'cli.js'), 'BROKEN', 'utf8');
  const second = publishCli(publishOptions);
  assert.equal(second.changed, true);
  assert.equal(second.previousVersion, pkg.version);
  assert.equal(second.dependenciesCopied, false, '依赖闭包未变时应跳过 node_modules 复制');
  assert.equal(sha256File(path.join(PUBLISH, 'cli.js')), sha256File(CLI));
  assert.ok(new Date(second.publishedAt).getTime() >= new Date(first.publishedAt).getTime());
});
