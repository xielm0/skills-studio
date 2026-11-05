// T07 自动验证：对话创建、改进与评测（prd.md §5.4/§5.8/§5.9；tests/test_cases.md C-28/C-29）
// 运行：cd backend && npm run build && node --no-warnings --test tests/t07.test.mjs
//
// 隔离纪律：一切写操作只落 tests/runtime/t07（库 / 本机会话数据 / 模拟 Agent 目录）；
// 模型调用全部走本地模拟 OpenAI 兼容服务（脚本化 SSE）；真实 Key 零使用。
// 缺失条件：真实供应商的模型输出质量与最终 Skill 适用性需用户人工验收。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME = path.join(PROJECT_ROOT, 'tests', 'runtime');
const ROOT = path.join(RUNTIME, 't07');
const LIB = path.join(ROOT, 'lib');
const SKILLS = path.join(LIB, 'skills');
const REPORTS = path.join(LIB, 'reports');
/** 报告文件名格式：`<技能名>_review_<yyyyMMdd-HHmmss>.md`；这里取该技能最新一份的绝对路径 */
function reportFileOf(skillName, dir = REPORTS) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.startsWith(`${skillName}_review_`) && file.endsWith('.md'))
    .sort();
  return files.length > 0 ? path.join(dir, files.at(-1)) : null;
}
/** 报告目录里的全部报告文件名（断言「只保留一份」与「无临时文件」用） */
function reportFiles(dir = REPORTS) {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}
const DATA = path.join(ROOT, 'data');
const DATA_EMPTY = path.join(ROOT, 'data-empty');
const AGENTS = path.join(ROOT, 'agents');

const TEST_KEY = 'sk-test-T07-abcdef1234567890';
const CREDENTIAL_PREFIX = 'skills-studio-test/';
const MODULE = pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href;

const {
  ConversationService,
  ProviderConfigService,
  CredentialVault,
  ToolScopeGuard,
  SkillLibraryService,
  SkillWorkflowService,
  EvalReportStore,
  AgentConfigService,
  SkillDeployService,
  selectBuiltinAgents,
  buildQuickActionPrompt,
  listBuiltinSkills,
  loadFlowText,
  validateTargetName,
  FLOW_SKILL_NAMES,
  clearSecrets,
} = await import(MODULE);
const { WindowsCredentialStore } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'infra', 'win-credential.js')).href
);
const { WriteLock } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'infra', 'write-lock.js')).href
);

// ── 本地假 provider（脚本化 SSE；与 t06 同形态，测试自足） ─────────────────

const FAKE = {
  requests: [],
  action: { kind: 'text', text: '默认回复' },
  afterTool: { kind: 'text', text: '工具已完成。' },
  server: null,
  baseUrl: '',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sseSend(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function startFakeProvider() {
  FAKE.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        parsed = {};
      }
      FAKE.requests.push(parsed);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const lastRole = messages.at(-1)?.role;
      const action = lastRole === 'tool' ? FAKE.afterTool : FAKE.action;
      const base = { id: 'fake-1', object: 'chat.completion.chunk', created: 1, model: parsed.model ?? 'fake-model' };
      const usage = { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 };

      if (action.kind === 'status') {
        res.writeHead(action.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: action.message, type: 'fake_error' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (action.kind === 'slow') {
        sseSend(res, {
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', content: action.text ?? '慢速开始-' }, finish_reason: null }],
        });
        await sleep(action.delayMs ?? 3000);
        if (!res.writableEnded) {
          sseSend(res, { ...base, choices: [{ index: 0, delta: { content: '-迟到的结尾' }, finish_reason: 'stop' }], usage });
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }
      if (action.kind === 'tool') {
        sseSend(res, {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: action.name, arguments: '' } },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        sseSend(res, {
          ...base,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(action.args ?? {}) } }] },
              finish_reason: null,
            },
          ],
        });
        sseSend(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const text = action.text ?? 'ok';
      const mid = Math.max(1, Math.floor(text.length / 2));
      sseSend(res, {
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, mid) }, finish_reason: null }],
      });
      sseSend(res, {
        ...base,
        choices: [{ index: 0, delta: { content: text.slice(mid) }, finish_reason: null }],
      });
      sseSend(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => FAKE.server.listen(0, '127.0.0.1', resolve));
  FAKE.baseUrl = `http://127.0.0.1:${FAKE.server.address().port}/v1`;
}

function resetFake() {
  FAKE.action = { kind: 'text', text: '默认回复' };
  FAKE.afterTool = { kind: 'text', text: '工具已完成。' };
}

// ── 夹具 ─────────────────────────────────────────────────────────────────

let providers;
let conversations;
let library;
let workflows;
let agents;
let deploy;
let improveSkillId;
let createHandle;
const workflowEvents = [];

const ADAPTERS = selectBuiltinAgents('codebuddy,cursor');
const agentSkills = (id) => {
  const def = ADAPTERS.find((b) => b.id === id);
  return path.join(AGENTS, def.skillsDirRel);
};

function writeSkill(dir, name, description, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  );
}

function skillMd(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

function walkFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** 读技能详情（按目录名），便于断言索引状态。 */
function skillByDir(dirName) {
  return library.listSkills().find((s) => s.dirName === dirName) ?? null;
}

before(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(DATA_EMPTY, { recursive: true });
  for (const def of ADAPTERS) fs.mkdirSync(agentSkills(def.id), { recursive: true });
  await startFakeProvider();
  resetFake();

  providers = new ProviderConfigService({ dataDir: DATA, credentialPrefix: CREDENTIAL_PREFIX });
  providers.addProvider({ preset: 'openai-compatible', name: '本地模拟服务', baseUrl: FAKE.baseUrl });
  providers.addModel('openai-compatible', 'fake-model');
  providers.setActiveProvider('openai-compatible');
  providers.setApiKey('openai-compatible', TEST_KEY);

  library = SkillLibraryService.create({ libraryDir: LIB, dataDir: DATA });
  conversations = new ConversationService({ dataDir: DATA, providers, builtinSkills: listBuiltinSkills() });
  workflows = new SkillWorkflowService({ library, conversations });
  workflows.subscribe((event) => workflowEvents.push(event));

  agents = AgentConfigService.create({ dataDir: DATA, homeDir: AGENTS, adapters: ADAPTERS });
  deploy = new SkillDeployService({
    library,
    agents,
    lock: new WriteLock({ dataDir: DATA }),
  });
  library.setDeploymentProbe(deploy.createProbe());

  // 改进/评测的目标技能（作为「已存在于库内」的真实技能）
  writeSkill(path.join(SKILLS, 'improve-skill'), 'improve-skill', '改进前的描述：整理会议纪要', 'v1 正文');
  await library.rescan();
  improveSkillId = skillByDir('improve-skill').skillId;
});

after(async () => {
  try {
    await conversations?.dispose();
  } catch {
    /* 忽略 */
  }
  try {
    const vault = new CredentialVault(new WindowsCredentialStore(), CREDENTIAL_PREFIX);
    vault.delete('openai-compatible');
  } catch {
    /* 清理失败不掩盖测试结果 */
  }
  clearSecrets();
  if (FAKE.server) await new Promise((resolve) => FAKE.server.close(resolve));
});

// ── 1. 快捷提示词与「预填不启动运行」 ──────────────────────────────────────

describe('T07 快捷提示词（三个入口）', () => {
  test('三个入口都产出可编辑预填文本，流程由内部 Skill 提供', () => {
    const create = buildQuickActionPrompt('create', { targetName: 'meeting-notes' });
    assert.match(create, /meeting-notes/);

    const improve = buildQuickActionPrompt('improve', {
      skillName: 'improve-skill',
      skillId: improveSkillId,
    });
    assert.match(improve, /improve-skill/);

    const evaluate = buildQuickActionPrompt('evaluate', {
      skillName: 'improve-skill',
      skillId: improveSkillId,
      hasReport: true,
    });
    assert.match(evaluate, /improve-skill/);

    // 产品自带流程文本（不依赖用户本机安装的 Skill）
    assert.equal(FLOW_SKILL_NAMES.create, 'skill-creator');
    assert.equal(FLOW_SKILL_NAMES.improve, 'skill-improve');
    assert.equal(FLOW_SKILL_NAMES.evaluate, 'skill-doctor');
    for (const action of ['create', 'improve', 'evaluate']) {
      assert.ok(loadFlowText(action).length > 0, `${action} 的内部 Skill 正文可加载`);
    }
  });

  test('创建入口只预填：不发送提示词前运行请求数 = 0；显式 runCreate 才触达模型', async () => {
    const before = FAKE.requests.length;
    const handle = workflows.startCreateConversation({ targetName: 'meeting-notes' });
    createHandle = handle;
    assert.equal(FAKE.requests.length, before, '预填不得产生任何模型请求');

    const session = conversations.getSession(handle.sessionId);
    assert.equal(session.messages.length, 0, '预填不写入用户消息');
    assert.equal(session.runs.length, 0, '预填不创建运行记录');
    assert.equal(session.status, 'done');
    assert.equal(session.toolPolicy, 'read-write');
    assert.equal(session.workflow, 'create');
    assert.match(session.systemPrompt, /技能创建/, '流程文本应注入会话 system prompt');
    assert.equal(fs.existsSync(handle.authorizedDir), true, '目标技能目录已预建并授权');
    assert.equal(handle.authorizedDir, path.join(SKILLS, 'meeting-notes'));

    // 改进/评测入口同样不运行
    const improveBefore = FAKE.requests.length;
    workflows.startImproveConversation(improveSkillId);
    const evaluateBefore = FAKE.requests.length;
    workflows.startEvaluateConversation(improveSkillId);
    assert.equal(FAKE.requests.length, evaluateBefore, '改进/评测入口也不得自动运行');
    assert.equal(evaluateBefore, improveBefore);
  });

  test('库根会话（聊天页快捷入口）：授权 skills/ 根、不指定目标技能、提示词不含技能名', () => {
    const before = FAKE.requests.length;
    const improveLib = workflows.startLibraryConversation('improve');
    assert.equal(FAKE.requests.length, before, '库根会话同样只预填，不触达模型');

    const improveSession = conversations.getSession(improveLib.sessionId);
    assert.equal(improveSession.authorizedDir, path.resolve(SKILLS), '授权到 skills/ 根');
    assert.equal(improveSession.workflow, 'improve');
    assert.equal(improveSession.toolPolicy, 'read-write');
    assert.match(improveSession.systemPrompt, /技能优化/, '流程文本照旧注入');
    assert.doesNotMatch(improveLib.prompt, /improve-skill/, '提示词不写技能名');

    const evaluateLib = workflows.startLibraryConversation('evaluate');
    assert.equal(conversations.getSession(evaluateLib.sessionId).toolPolicy, 'read-write', '检查同样可在授权目录内读写');
    assert.doesNotMatch(evaluateLib.prompt, /reports\//, '库根检查不落盘报告');
  });
});

// ── 2. 创建（M9 / C-29） ─────────────────────────────────────────────────

describe('T07 创建：直写中心库并记为对话来源', () => {
  test('假服务写 SKILL.md 后 rescan 入索引：source=conversation、名称/描述可查、可部署', async () => {
    const handle = createHandle;
    assert.ok(handle, '复用「点击快捷项预填」创建的会话');
    resetFake();
    FAKE.action = {
      kind: 'tool',
      name: 'write',
      args: { path: 'SKILL.md', content: skillMd('meeting-notes', '把会议记录整理成结构化纪要', '## 步骤\n1. 读取记录\n') },
    };
    FAKE.afterTool = { kind: 'text', text: '已创建 meeting-notes。' };

    const outcome = await workflows.runCreate(handle.sessionId, { prompt: handle.prompt });
    assert.equal(outcome.result.status, 'done');
    assert.equal(outcome.indexed, true);
    assert.equal(outcome.sourceType, 'conversation');
    assert.ok(outcome.skillId);

    const file = path.join(SKILLS, 'meeting-notes', 'SKILL.md');
    assert.equal(fs.existsSync(file), true);
    assert.match(fs.readFileSync(file, 'utf8'), /结构化纪要/);

    const summary = skillByDir('meeting-notes');
    assert.ok(summary, '创建后应进入索引');
    assert.equal(summary.skillId, outcome.skillId);
    assert.equal(summary.name, 'meeting-notes');
    assert.equal(summary.description, '把会议记录整理成结构化纪要');
    assert.equal(summary.source.type, 'conversation');
    assert.equal(summary.missing, false);

    // 文件区入口：会话里记录生成文件
    const session = conversations.getSession(handle.sessionId);
    assert.ok(session.files.some((f) => f.relPath === 'SKILL.md'));
    assert.ok(session.messages.some((m) => m.role === 'assistant' && /已创建/.test(m.text)));

    // 近期动态：对话创建事件
    const activity = library.getRecentActivity().filter((e) => e.skillId === outcome.skillId);
    assert.ok(activity.some((e) => e.type === 'created' && /对话创建/.test(e.detail)));

    // 结构合法 → 可部署（链接）
    const deployed = await deploy.deployOne(outcome.skillId, 'codebuddy');
    assert.equal(deployed.status, 'deployed');
    assert.match(fs.readFileSync(path.join(agentSkills('codebuddy'), 'meeting-notes', 'SKILL.md'), 'utf8'), /结构化纪要/);
  });

  test('目标名校验与重名：TARGET_INVALID / NAME_CONFLICT 且目录零残留', async () => {
    const before = fs.readdirSync(SKILLS).sort();    const cases = [
      ['..', /TARGET_INVALID/],
      ['../escape', /TARGET_INVALID/],
      ['bad<name>', /TARGET_INVALID/],
      [' bad-space', /TARGET_INVALID/],
      ['CON', /TARGET_INVALID/],
      ['', /TARGET_INVALID/],
    ];
    for (const [name, pattern] of cases) {
      assert.throws(
        () => workflows.startCreateConversation({ targetName: name }),
        (err) => err.code === 'TARGET_INVALID' && pattern.test(err.message),
        `非法名应拒绝：${JSON.stringify(name)}`,
      );
    }
    assert.deepEqual(fs.readdirSync(SKILLS).sort(), before, '非法名不得留下任何目录');

    // 重名：已存在同名技能 → NAME_CONFLICT，零残留
    assert.throws(
      () => workflows.startCreateConversation({ targetName: 'meeting-notes' }),
      (err) => err.code === 'NAME_CONFLICT' && /已存在同名/.test(err.detail),
    );
    // 大小写不敏感（Windows 语义）
    assert.throws(
      () => workflows.startCreateConversation({ targetName: 'MEETING-NOTES' }),
      (err) => err.code === 'NAME_CONFLICT',
    );
    assert.deepEqual(fs.readdirSync(SKILLS).sort(), before);

    // 库路径不一致 → TARGET_INVALID（不写错库）
    assert.throws(
      () => workflows.startCreateConversation({ targetName: 'other-lib-skill', libraryPath: ROOT }),
      (err) => err.code === 'TARGET_INVALID',
    );

    // 纯函数也可单独使用
    assert.equal(validateTargetName('valid-name-1'), 'valid-name-1');

    // 会话归属不可混用：改进会话不能被当作创建运行（避免改写来源为 conversation）
    const improveHandle = workflows.startImproveConversation(improveSkillId);
    assert.equal(conversations.getSession(improveHandle.sessionId).workflow, 'improve');
    const requestsBefore = FAKE.requests.length;
    await assert.rejects(
      () => workflows.runCreate(improveHandle.sessionId, { prompt: '错误地用改进会话创建' }),
      (err) => err.code === 'TARGET_INVALID',
    );
    assert.equal(FAKE.requests.length, requestsBefore, '归属不匹配时不得发起模型请求');
  });

  test('创建中断：已写文件保留、不入索引；重启后会话/文件可读并能从原会话继续', async () => {
    const handle = workflows.startCreateConversation({ targetName: 'interrupted-skill' });
    resetFake();
    FAKE.action = { kind: 'tool', name: 'write', args: { path: 'draft.md', content: '半成品草稿' } };
    FAKE.afterTool = { kind: 'slow', text: '继续生成中-', delayMs: 2000 };

    const pending = workflows.runCreate(handle.sessionId, { prompt: handle.prompt });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待首个增量超时')), 20000);
      const unsub = conversations.subscribe(handle.sessionId, (event) => {
        if (event.type === 'message' && event.role === 'assistant' && event.delta) {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });
    await conversations.cancelRun(handle.sessionId);
    const outcome = await pending;

    assert.equal(outcome.result.status, 'cancelled');
    assert.equal(outcome.indexed, false, '没有 SKILL.md 不算结构合法的技能');
    assert.equal(skillByDir('interrupted-skill'), null, '中断的半成品不进入索引');
    assert.equal(fs.readFileSync(path.join(SKILLS, 'interrupted-skill', 'draft.md'), 'utf8'), '半成品草稿');

    // 模拟应用重启：新服务实例指向同一 DATA / 库
    const restartedProviders = new ProviderConfigService({ dataDir: DATA, credentialPrefix: CREDENTIAL_PREFIX });
    const restarted = new ConversationService({ dataDir: DATA, providers: restartedProviders });
    const restartedWorkflows = new SkillWorkflowService({
      library,
      conversations: restarted,
    });
    const list = restarted.listSessions();
    assert.ok(list.some((s) => s.sessionId === handle.sessionId), '重启后会话列表应包含该会话');
    const detail = restarted.getSession(handle.sessionId);
    assert.equal(detail.status, 'cancelled');
    assert.ok(detail.files.some((f) => f.relPath === 'draft.md'), '文件入口应恢复');
    assert.equal(fs.existsSync(path.join(SKILLS, 'interrupted-skill', 'draft.md')), true);
    assert.equal(restarted.resume(handle.sessionId).resumable, true);

    // 从原会话继续：补齐 SKILL.md 后正常入索引
    resetFake();
    FAKE.action = {
      kind: 'tool',
      name: 'write',
      args: { path: 'SKILL.md', content: skillMd('interrupted-skill', '中断后继续完成的技能', '正文') },
    };
    FAKE.afterTool = { kind: 'text', text: '已补齐 SKILL.md。' };
    const continued = await restartedWorkflows.runCreate(handle.sessionId, { prompt: '继续完成刚才的技能' });
    assert.equal(continued.result.status, 'done');
    assert.equal(continued.indexed, true);
    assert.equal(continued.sourceType, 'conversation');
    assert.equal(fs.existsSync(path.join(SKILLS, 'interrupted-skill', 'draft.md')), true, '旧文件不被清理');
    assert.equal(skillByDir('interrupted-skill').description, '中断后继续完成的技能');

    await restarted.dispose();
  });
});

// ── 3. 改进（M4） ────────────────────────────────────────────────────────

describe('T07 改进：改写库内文件 → 链接立即读到新内容', () => {
  test('改进运行 → rescan、content-changed 事件、Agent 链接内容更新（无需重新部署）', async () => {
    const deployed = await deploy.deployOne(improveSkillId, 'cursor');
    assert.equal(deployed.status, 'deployed');
    const agentFile = path.join(agentSkills('cursor'), 'improve-skill', 'SKILL.md');
    assert.match(fs.readFileSync(agentFile, 'utf8'), /改进前的描述/);

    const handle = workflows.startImproveConversation(improveSkillId);
    assert.equal(handle.skillId, improveSkillId);
    assert.equal(handle.authorizedDir, path.join(SKILLS, 'improve-skill'));
    const session = conversations.getSession(handle.sessionId);
    assert.match(session.systemPrompt, /技能优化/);
    assert.equal(session.workflow, 'improve');
    assert.equal(fs.existsSync(agentFile), true);

    const eventsBefore = workflowEvents.length;
    resetFake();
    FAKE.action = {
      kind: 'tool',
      name: 'write',
      args: {
        path: 'SKILL.md',
        content: skillMd('improve-skill', '改进后的描述：整理会议纪要并输出待办', 'v2 正文：新增待办提取步骤'),
      },
    };
    FAKE.afterTool = { kind: 'text', text: '已按诊断结果改进 SKILL.md。' };

    const outcome = await workflows.runImprove(handle.sessionId, { prompt: handle.prompt });
    assert.equal(outcome.result.status, 'done');
    assert.equal(outcome.contentChanged, true);
    assert.ok(outcome.contentHash);

    const summary = skillByDir('improve-skill');
    assert.equal(summary.description, '改进后的描述：整理会议纪要并输出待办');
    const activity = library.getRecentActivity().filter((e) => e.skillId === improveSkillId);
    assert.ok(activity.some((e) => e.type === 'content-changed'), 'rescan 应记录内容变更');

    const changedEvents = workflowEvents.slice(eventsBefore).filter((e) => e.type === 'content-changed');
    assert.equal(changedEvents.length, 1);
    assert.equal(changedEvents[0].skillId, improveSkillId);
    assert.equal(changedEvents[0].dirName, 'improve-skill');

    // 部署是链接：Agent 目录立即可读新内容，无需重新部署
    assert.match(fs.readFileSync(agentFile, 'utf8'), /新增待办提取步骤/);
    const verified = deploy.verifyDeployment(improveSkillId, 'cursor');
    assert.equal(verified.deployed, true);
  });

  test('库根改进会话：Agent 在 skills/ 内定位目标并改动 → content-changed 落在被改技能上', async () => {
    const handle = workflows.startLibraryConversation('improve');
    const eventsBefore = workflowEvents.length;
    resetFake();
    FAKE.action = {
      kind: 'tool',
      name: 'write',
      args: {
        path: 'improve-skill/SKILL.md',
        content: skillMd('improve-skill', '库根改进后的描述：整理会议纪要', 'v3 正文：库根会话写入'),
      },
    };
    FAKE.afterTool = { kind: 'text', text: '已改进 improve-skill。' };

    const outcome = await workflows.runImprove(handle.sessionId, { prompt: handle.prompt });
    assert.equal(outcome.result.status, 'done');
    assert.equal(outcome.contentChanged, true);
    assert.equal(outcome.dirName, 'improve-skill', '改动的技能被正确归属');

    const changedEvents = workflowEvents.slice(eventsBefore).filter((e) => e.type === 'content-changed');
    assert.equal(changedEvents.length, 1);
    assert.equal(changedEvents[0].dirName, 'improve-skill');
    assert.match(fs.readFileSync(path.join(SKILLS, 'improve-skill', 'SKILL.md'), 'utf8'), /库根会话写入/);

    // 内置 skill 作为「Agent 可发现的 skill」：清单随系统提示下发
    const payload = JSON.stringify(FAKE.requests.at(-1) ?? {});
    assert.match(payload, /可用技能/);
    assert.match(payload, /skill-improve/);
  });

  test('不存在 / 目录已丢失的技能 → SKILL_NOT_FOUND', () => {
    assert.throws(
      () => workflows.startImproveConversation('sk_00000000000000000'),
      (err) => err.code === 'SKILL_NOT_FOUND',
    );
    assert.throws(
      () => workflows.startEvaluateConversation('sk_00000000000000000'),
      (err) => err.code === 'SKILL_NOT_FOUND',
    );
  });
});

// ── 4. 评测（M8 / C-28） ─────────────────────────────────────────────────

describe('T07 评测：授权目录可读写 + 应用受控写入唯一报告', () => {
  test('评测会话也提供 write/edit，并限制写入授权目录', async () => {
    const handle = workflows.startEvaluateConversation(improveSkillId);
    const session = conversations.getSession(handle.sessionId);
    assert.equal(session.toolPolicy, 'read-write');
    assert.equal(session.workflow, 'evaluate');
    assert.match(session.systemPrompt, /技能评测（skill-doctor）/);
    assert.doesNotMatch(session.systemPrompt, /不能直接修改目标skill/);
    assert.equal(handle.hasReport, false, '首次评测前没有当前报告');
    assert.equal(path.dirname(handle.reportPath), REPORTS);
    assert.match(path.basename(handle.reportPath), /^improve-skill_review_\d{8}-\d{6}\.md$/);

    const guard = new ToolScopeGuard(handle.authorizedDir);
    assert.deepEqual([...guard.allowedTools].sort(), ['read', 'write', 'edit', 'ls', 'grep', 'find'].sort());
    assert.equal(guard.check('write', { path: 'SKILL.md' }).ok, true);
    assert.equal(guard.check('edit', { path: 'SKILL.md' }).ok, true);
    assert.equal(guard.check('read', { path: 'SKILL.md' }).ok, true);
    assert.equal(guard.check('write', { path: '../outside.txt' }).ok, false);

    resetFake();
    FAKE.action = {
      kind: 'tool',
      name: 'write',
      args: { path: 'repair-note.md', content: '已修复\n' },
    };
    FAKE.afterTool = { kind: 'text', text: '# 报告\n无问题。' };

    const outcome = await workflows.runEvaluate(handle.sessionId, { prompt: handle.prompt });

    const request = FAKE.requests.at(-1);
    assert.deepEqual(
      (request.tools ?? []).map((t) => t.function.name).sort(),
      ['edit', 'find', 'grep', 'ls', 'read', 'write'],
    );
    assert.equal(fs.readFileSync(path.join(handle.authorizedDir, 'repair-note.md'), 'utf8'), '已修复\n');
    assert.equal(outcome.saved, true, '本次运行仍完整结束，报告由应用保存');
    fs.rmSync(path.join(handle.authorizedDir, 'repair-note.md'));
  });

  test('首次成功：reports/<技能名>_review_<时间戳>.md = 捕获文本；不落 skills/、不部署到 Agent', () => {
    assert.equal(fs.existsSync(REPORTS), true);
    const reportFile = reportFileOf('improve-skill');
    assert.ok(reportFile, '报告已按命名规则落盘');
    assert.match(path.basename(reportFile), /^improve-skill_review_\d{8}-\d{6}\.md$/);
    const text = fs.readFileSync(reportFile, 'utf8');
    assert.match(text, /无问题/);
    assert.equal(workflows.hasReport(improveSkillId), true);

    // 报告目录只有这一份当前结果，且没有临时文件残留
    assert.deepEqual(reportFiles(), [path.basename(reportFile)]);

    // 不在 skills/ 下，也不出现在任何 Agent 技能目录
    assert.equal(fs.existsSync(path.join(SKILLS, 'reports')), false);
    for (const def of ADAPTERS) {
      const found = fs
        .readdirSync(agentSkills(def.id))
        .filter((name) => /reports/i.test(name));
      assert.deepEqual(found, [], `${def.id} 的 Agent 目录不应出现评测报告`);
    }
  });

  test('再次成功评测：整体替换旧报告（唯一文件）', async () => {
    const handle = workflows.startEvaluateConversation(improveSkillId);
    assert.equal(handle.hasReport, true);
    resetFake();
    FAKE.action = { kind: 'text', text: '# improve-skill 评测报告\n\n## 总评\n第二版报告：建议保留。\n' };

    const outcome = await workflows.runEvaluate(handle.sessionId, { prompt: handle.prompt });
    assert.equal(outcome.result.status, 'done');
    assert.equal(outcome.saved, true);
    assert.equal(outcome.error, null);
    const text = fs.readFileSync(reportFileOf('improve-skill'), 'utf8');
    assert.match(text, /第二版报告/);
    assert.equal(reportFiles().length, 1, '旧报告被清理，只保留最新一份');
  });

  test('评测失败（provider 500）：保留旧报告 + 错误可读', async () => {
    const before = fs.readFileSync(reportFileOf('improve-skill'), 'utf8');
    const handle = workflows.startEvaluateConversation(improveSkillId);
    resetFake();
    FAKE.action = { kind: 'status', status: 500, message: 'internal server error' };

    const outcome = await workflows.runEvaluate(handle.sessionId, { prompt: handle.prompt });
    assert.equal(outcome.result.status, 'failed');
    assert.equal(outcome.saved, false);
    assert.equal(outcome.error.code, 'PROVIDER_ERROR');
    assert.ok(outcome.error.detail.length > 0);
    assert.equal(fs.readFileSync(reportFileOf('improve-skill'), 'utf8'), before);
  });

  test('评测中断（用户取消）：保留旧报告 + TASK_CANCELLED', async () => {
    const before = fs.readFileSync(reportFileOf('improve-skill'), 'utf8');
    const handle = workflows.startEvaluateConversation(improveSkillId);
    resetFake();
    FAKE.action = { kind: 'slow', text: '报告生成中-', delayMs: 2500 };

    const pending = workflows.runEvaluate(handle.sessionId, { prompt: handle.prompt });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待首个增量超时')), 20000);
      const unsub = conversations.subscribe(handle.sessionId, (event) => {
        if (event.type === 'message' && event.role === 'assistant' && event.delta) {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });
    await conversations.cancelRun(handle.sessionId);
    const outcome = await pending;

    assert.equal(outcome.result.status, 'cancelled');
    assert.equal(outcome.saved, false);
    assert.equal(outcome.error.code, 'TASK_CANCELLED');
    assert.equal(fs.readFileSync(reportFileOf('improve-skill'), 'utf8'), before);
  });

  test('空报告文本：EVAL_REPORT_EMPTY，保留旧报告', async () => {
    const before = fs.readFileSync(reportFileOf('improve-skill'), 'utf8');
    const handle = workflows.startEvaluateConversation(improveSkillId);
    resetFake();
    FAKE.action = { kind: 'text', text: '' };

    const outcome = await workflows.runEvaluate(handle.sessionId, { prompt: handle.prompt });
    assert.equal(outcome.result.status, 'done');
    assert.equal(outcome.saved, false);
    assert.equal(outcome.error.code, 'EVAL_REPORT_EMPTY');
    assert.equal(fs.readFileSync(reportFileOf('improve-skill'), 'utf8'), before);
  });

  test('报告保存失败：EVAL_SAVE_FAILED，旧报告原样保留', async () => {
    const before = fs.readFileSync(reportFileOf('improve-skill'), 'utf8');
    const failingReports = {
      path: (id) => workflows.reports.path(id),
      has: (id) => workflows.hasReport(id),
      read: (id) => workflows.reports.read(id),
      save: () => {
        throw new Error('模拟磁盘写入失败');
      },
      remove: () => false,
    };
    const failingWorkflows = new SkillWorkflowService({ library, conversations, reports: failingReports });
    const handle = failingWorkflows.startEvaluateConversation(improveSkillId);
    resetFake();
    FAKE.action = { kind: 'text', text: '这份报告无法保存。' };

    const outcome = await failingWorkflows.runEvaluate(handle.sessionId, { prompt: handle.prompt });
    assert.equal(outcome.result.status, 'done');
    assert.equal(outcome.saved, false);
    assert.equal(outcome.error.code, 'EVAL_SAVE_FAILED');
    assert.match(outcome.error.detail, /模拟磁盘写入失败/);
    assert.equal(fs.readFileSync(reportFileOf('improve-skill'), 'utf8'), before);
  });

  test('EvalReportStore 原子替换语义：空文本拒绝、写入后可读、临时文件不残留', () => {
    const checkDir = path.join(ROOT, 'report-store-check');
    const store = new EvalReportStore(checkDir);
    assert.throws(() => store.save(improveSkillId, '   '), (err) => err.code === 'EVAL_REPORT_EMPTY');
    assert.equal(store.has(improveSkillId), false);
    const info = store.save(improveSkillId, '原子写入内容');
    assert.ok(info.bytes > 0);
    assert.equal(store.read(improveSkillId), '原子写入内容');
    // 没有名字解析器时退回用 Skill ID 命名
    const saved = fs.readdirSync(checkDir);
    assert.equal(saved.length, 1);
    assert.match(saved[0], new RegExp(`^${improveSkillId}_review_\\d{8}-\\d{6}\\.md$`));
    assert.equal(store.remove(improveSkillId), true);
    assert.equal(store.has(improveSkillId), false);
  });

  test('EvalReportStore 命名：有名字解析器时用技能名，重名技能退回目录名', () => {
    const namedDir = path.join(ROOT, 'report-store-named');
    const idA = 'sk_aaaaaaaaaaaaaaaaa';
    const idB = 'sk_bbbbbbbbbbbbbbbbb';
    const byName = new EvalReportStore(namedDir, () => 'grill-me');
    byName.save(idA, '# 报告');
    assert.match(fs.readdirSync(namedDir)[0], /^grill-me_review_\d{8}-\d{6}\.md$/);

    // 两个技能同名时解析器返回目录名 → 各存一份，互不覆盖
    const dup = new EvalReportStore(namedDir, (id) => (id === idA ? 'grill-me' : 'grill-me-2'));
    dup.save(idB, '# 另一份');
    const files = fs.readdirSync(namedDir).sort();
    assert.equal(files.length, 2);
    assert.ok(files.some((file) => /^grill-me_review_/.test(file)));
    assert.ok(files.some((file) => /^grill-me-2_review_/.test(file)));
    assert.equal(dup.read(idA), '# 报告');
    assert.equal(dup.read(idB), '# 另一份');
  });

  test('EvalReportStore 命名：非法字符被清洗，不会写出目录外', () => {
    const dirtyDir = path.join(ROOT, 'report-store-dirty');
    const store = new EvalReportStore(dirtyDir, () => 'a/b:c*?"<>|d');
    store.save('sk_ccccccccccccccccc', '# 报告');
    const files = fs.readdirSync(dirtyDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^a-b-c-+d_review_\d{8}-\d{6}\.md$/);
    assert.equal(path.dirname(path.join(dirtyDir, files[0])), dirtyDir);
  });
});

// ── 5. 未配置模型 ─────────────────────────────────────────────────────────

describe('T07 未配置模型：三个入口一致给出 NO_MODEL_CONFIGURED', () => {
  test('创建/改进/评测均拒绝并给出设置引导，且不留下目录或会话', async () => {
    const emptyProviders = new ProviderConfigService({ dataDir: DATA_EMPTY, credentialPrefix: CREDENTIAL_PREFIX });
    const emptyConversations = new ConversationService({ dataDir: DATA_EMPTY, providers: emptyProviders });
    const emptyWorkflows = new SkillWorkflowService({ library, conversations: emptyConversations });
    assert.equal(emptyProviders.view().runnable, false);

    const cases = [
      () => emptyWorkflows.startCreateConversation({ targetName: 'no-model-skill' }),
      () => emptyWorkflows.startImproveConversation(improveSkillId),
      () => emptyWorkflows.startEvaluateConversation(improveSkillId),
    ];
    for (const call of cases) {
      assert.throws(
        call,
        (err) => err.code === 'NO_MODEL_CONFIGURED' && /设置/.test(err.detail),
      );
    }
    assert.equal(fs.existsSync(path.join(SKILLS, 'no-model-skill')), false, '无模型时不得预建目录');
    assert.equal(emptyConversations.listSessions().length, 0, '无模型时不得产生会话');
    await emptyConversations.dispose();
  });
});

// ── 缺失条件说明 ─────────────────────────────────────────────────────────

test('缺失条件：真实供应商的模型输出质量未验收', () => {
  console.log(
    [
      '',
      '=== T07 验证边界 ===',
      '本次端到端使用的模型服务：本地模拟 OpenAI 兼容 HTTP 服务（脚本化 SSE 响应）。',
      '创建/改进/评测的流程编排、文件落盘、授权目录边界、报告原子替换均已自动验证；',
      '缺失条件：真实供应商下模型是否遵循流程文本、生成的 Skill 是否好用，需用户人工验收。',
      '',
    ].join('\n'),
  );
  assert.equal(true, true);
});
