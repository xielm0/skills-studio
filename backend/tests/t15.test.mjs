// T15 自动验证：新对话 IPC（列表/详情/创建/发送/取消/模型/只读文件预览）与事件流
// 运行：cd backend && npm run build && node --no-warnings --test tests/t15.test.mjs
//
// 隔离纪律：一切写操作只落 tests/runtime/t15（库 / 会话 / 模拟 Agent 目录）；
// 模型调用全部走本地模拟 OpenAI 兼容服务（脚本化 SSE）；真实 Key 零使用。
// 缺失条件：真实供应商下的模型输出质量与 Skill 适用性需用户人工验收。
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
const ROOT = path.join(RUNTIME, 't15');
const LIB = path.join(ROOT, 'lib');
const SKILLS = path.join(LIB, 'skills');
const DATA = path.join(ROOT, 'data');
const EMPTY = path.join(ROOT, 'empty');
const AGENTS = path.join(ROOT, 'agents');
const CREDENTIAL_PREFIX = 'skills-studio-test/';

const { AppContext } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'context.js')).href);
const { createIpcHandlers } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'ipc', 'handlers.js')).href);
const { defaultSkillsDirFor, selectBuiltinAgents } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'agents.js')).href
);

// ── 本地假 provider（脚本化 SSE，形态与 t06/t07 一致） ─────────────────────

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
    req.on('end', () => {
      void (async () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          parsed = {};
        }
        FAKE.requests.push(parsed);
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const last = messages[messages.length - 1];
        const action = last?.role === 'tool' ? FAKE.afterTool : FAKE.action;
        const base = {
          id: 'fake-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: parsed.model ?? 'fake-model',
        };
        const usage = { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 };

        if (action.kind === 'status') {
          res.writeHead(action.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: action.message ?? 'fake_error', type: 'fake_error' } }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (action.kind === 'slow') {
          sseSend(res, {
            ...base,
            choices: [
              { index: 0, delta: { role: 'assistant', content: action.text ?? '慢速开始-' }, finish_reason: null },
            ],
          });
          await sleep(action.delayMs ?? 4000);
          if (!res.writableEnded) {
            sseSend(res, {
              ...base,
              choices: [{ index: 0, delta: { content: '-迟到的结尾' }, finish_reason: 'stop' }],
              usage,
            });
            res.write('data: [DONE]\n\n');
            res.end();
          }
          return;
        }
        if (action.kind === 'tool') {
          const calls = (action.calls ?? [{ name: action.name, args: action.args ?? {} }]).map((call, index) => ({
            name: call.name,
            args: call.args ?? {},
          }));
          sseSend(res, {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: action.text ?? '',
                  tool_calls: calls.map((call, index) => ({
                    index,
                    id: `call_${index + 1}`,
                    type: 'function',
                    function: { name: call.name, arguments: '' },
                  })),
                },
                finish_reason: null,
              },
            ],
          });
          // 参数按 SSE 增量补发（每次调用一段完整 JSON）
          sseSend(res, {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: calls.map((call, index) => ({
                    index,
                    function: { arguments: JSON.stringify(call.args) },
                  })),
                },
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
        const chunks = Math.max(1, action.chunks ?? 3);
        const size = Math.max(1, Math.ceil(text.length / chunks));
        for (let i = 0; i < text.length; i += size) {
          const part = text.slice(i, i + size);
          sseSend(res, { ...base, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
          if (action.delayMs) await sleep(action.delayMs);
        }
        sseSend(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
        res.write('data: [DONE]\n\n');
        res.end();
      })();
    });
  });
  await new Promise((resolve) => FAKE.server.listen(0, '127.0.0.1', resolve));
  FAKE.baseUrl = `http://127.0.0.1:${FAKE.server.address().port}/v1`;
}

function resetFake(action = { kind: 'text', text: '默认回复' }) {
  FAKE.action = action;
  FAKE.afterTool = { kind: 'text', text: '工具已完成。' };
  FAKE.requests.length = 0;
}

// ── 夹具 ─────────────────────────────────────────────────────────────────

function writeSkill(dir, name, description, body = '') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`,
    'utf8',
  );
}

function makeDirs(name) {
  const root = path.join(ROOT, name);
  fs.rmSync(root, { recursive: true, force: true });
  const dirs = {
    root,
    lib: path.join(root, 'lib'),
    data: path.join(root, 'data'),
    tmp: path.join(root, 'tmp'),
    agents: path.join(root, 'agents'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

function newContext(dirs) {
  return AppContext.create({
    libraryDir: dirs.lib,
    dataDir: dirs.data,
    tempDir: dirs.tmp,
    homeDir: dirs.agents,
    adapters: selectBuiltinAgents('codebuddy,cursor'),
    appEnv: 'development',
    version: '0.0.0-test',
    credentialPrefix: CREDENTIAL_PREFIX,
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
    pickFile: async () => null,
    openPath: async () => '',
  });
}

/** 等待某会话的 done 事件（发送前注册，避免错过）。 */
function onceDone(ctx, sessionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`等待 done 超时：${sessionId}`));
    }, 25_000);
    const off = ctx.conversations.subscribe(sessionId, (event) => {
      if (event.type !== 'done') return;
      clearTimeout(timer);
      off();
      resolve(event);
    });
  });
}

async function waitUntil(check, timeout = 15_000, label = '条件') {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`);
    await sleep(80);
  }
}

/** 该技能当前评测报告（`<技能名>_review_<时间戳>.md` 中最新的那份）。 */
function latestReport(skillName) {
  const dir = path.join(LIB, 'reports');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((file) => file.startsWith(`${skillName}_review_`)).sort();
  return files.length > 0 ? path.join(dir, files.at(-1)) : null;
}

let dirs;
let ctx;
let handlers;
let ids = {};
const allEvents = [];

before(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  dirs = {
    root: ROOT,
    lib: LIB,
    data: DATA,
    tmp: path.join(ROOT, 'tmp'),
    agents: AGENTS,
  };
  for (const dir of [LIB, DATA, dirs.tmp, AGENTS, EMPTY]) fs.mkdirSync(dir, { recursive: true });
  for (const def of selectBuiltinAgents('codebuddy,cursor')) {
    fs.mkdirSync(defaultSkillsDirFor(def.id, AGENTS), { recursive: true });
  }
  await startFakeProvider();
  resetFake();

  writeSkill(path.join(SKILLS, 'improve-skill'), 'improve-skill', '改进前的描述：整理会议纪要', 'v1 正文');
  writeSkill(path.join(SKILLS, 'evaluate-skill'), 'evaluate-skill', '用于评测的样本技能', '评测样本正文');

  ctx = newContext(dirs);
  ctx.providers.addProvider({ preset: 'ollama', name: '本地模拟服务', baseUrl: FAKE.baseUrl });
  ctx.providers.addModel('ollama', 'mock-model');
  ctx.providers.setActiveProvider('ollama');
  await ctx.library.rescan();
  ids = Object.fromEntries(ctx.library.listSkills().map((s) => [s.dirName, s.skillId]));
  handlers = makeHandlers(ctx, dirs);
  ctx.conversations.subscribeAll((event) => allEvents.push(event));
});

after(async () => {
  try {
    await ctx?.conversations.dispose();
  } catch {
    /* 忽略 */
  }
  ctx?.dispose();
  if (FAKE.server) await new Promise((resolve) => FAKE.server.close(resolve));
});

// ── 1. 空白会话与列表 ─────────────────────────────────────────────────────

describe('T15 空白会话', () => {
  test('斜杠菜单只列工作台 Agent 内部 Skill，并可选用 SOP', async () => {
    const names = handlers['conversation:skills']().items.map((item) => item.name).sort();
    // agents/skills/ 下随包分发的全部内部 Skill（2026-11-02 起 5 个：4 个能力 skill + skills-studio 管理技能）
    assert.deepEqual(names, ['skill-creator', 'skill-creator-sop', 'skill-doctor', 'skill-improve', 'skills-studio']);
    resetFake();
    const session = handlers['conversation:create']({ mode: 'blank' });
    const done = onceDone(ctx, session.sessionId);
    const sent = await handlers['conversation:send']({
      sessionId: session.sessionId,
      text: '/skill-creator-sop 请创建一个测试 Skill',
    });
    assert.equal(sent.accepted, true);
    const selected = ctx.conversations.getSession(session.sessionId);
    assert.equal(selected.workflow, 'create');
    assert.match(selected.systemPrompt, /skill-creator-sop/);
    await done;
  });

  test('conversation:create(blank) 建会话并出现在列表，详情可读', () => {
    const created = handlers['conversation:create']({ mode: 'blank' });
    assert.equal(created.mode, 'blank');
    assert.equal(created.prompt, '');
    assert.ok(created.sessionId?.startsWith('cv_'), `会话 ID：${created.sessionId}`);

    const list = handlers['conversation:list']();
    const item = list.items.find((entry) => entry.id === created.sessionId);
    assert.ok(item, '新会话应出现在列表');
    assert.equal(item.title, '新对话');
    assert.equal(item.workflow, null);
    assert.equal(item.messageCount, 0);
    assert.equal(item.running, false);

    const view = handlers['conversation:get']({ sessionId: created.sessionId });
    assert.equal(view.messages.length, 0);
    assert.equal(view.files.length, 0);
    assert.equal(view.status, 'done');
    assert.equal(view.modelId, 'mock-model');
    assert.equal(view.modelConfigured, true);
    assert.equal(view.canContinue, true);
    assert.equal(view.draftPrompt, null);
  });

  test('未知模式被拒绝；缺目标参数落到 skills/ 根会话', async () => {
    assert.throws(() => handlers['conversation:create']({ mode: 'unknown' }), /未知的会话模式/);
    const before = handlers['conversation:list']().items.length;
    const improve = handlers['conversation:create']({ mode: 'improve' });
    assert.ok(improve.sessionId, `库根会话应建成：${JSON.stringify(improve.error)}`);
    assert.equal(improve.targetSkillId, null);
    assert.equal(handlers['conversation:list']().items.length, before + 1, '库根会话同样建会话');
  });
});

// ── 2. 三个快捷入口：预填不运行 ───────────────────────────────────────────

describe('T15 快捷项预填（不启动运行）', () => {
  test('create / improve / evaluate 只建会话填提示词，模型请求数 0', () => {
    const before = FAKE.requests.length;

    const create = handlers['conversation:create']({ mode: 'create', targetName: 'ui-created' });
    assert.equal(create.dirName, 'ui-created');
    assert.equal(fs.existsSync(path.join(SKILLS, 'ui-created')), true, 'T07 预建目标目录');
    assert.equal(create.prompt.includes('ui-created'), true, '提示词包含目标名');

    const improve = handlers['conversation:create']({ mode: 'improve', targetSkillId: ids['improve-skill'] });
    assert.equal(improve.targetSkillId, ids['improve-skill']);

    const evaluate = handlers['conversation:create']({ mode: 'evaluate', targetSkillId: ids['evaluate-skill'] });

    assert.equal(FAKE.requests.length, before, '预填不得触达模型');

    for (const sessionId of [create.sessionId, improve.sessionId, evaluate.sessionId]) {
      const view = handlers['conversation:get']({ sessionId });
      assert.equal(view.running, false);
      assert.equal(view.messages.length, 0, '预填不写入消息');
      assert.ok(view.draftPrompt && view.draftPrompt.length > 0, '草稿持久化供输入框回填');
      assert.ok(view.targetSkillId === null || view.targetSkillId.length > 0);
    }
    assert.equal(handlers['conversation:get']({ sessionId: improve.sessionId }).workflow, 'improve');
    assert.equal(handlers['conversation:get']({ sessionId: evaluate.sessionId }).workflow, 'evaluate');
  });

  test('conversation:prefill 行菜单入口同样写入草稿（T11 行为保持）', () => {
    const result = handlers['conversation:prefill']({ mode: 'improve', skillId: ids['improve-skill'] });
    const view = handlers['conversation:get']({ sessionId: result.sessionId });
    assert.equal(view.draftPrompt, result.prompt);
    assert.equal(view.workflow, 'improve');
  });
});

// ── 3. 发送：事件顺序与落盘 ───────────────────────────────────────────────

let streamSessionId = null;

describe('T15 发送与事件流', () => {
  test('send 立即返回；事件顺序 status running → 多个 delta → usage → done', async () => {
    resetFake({ kind: 'text', text: '第一段增量，第二段增量，第三段收尾。', chunks: 3, delayMs: 120 });
    const created = handlers['conversation:create']({ mode: 'blank' });
    streamSessionId = created.sessionId;
    allEvents.length = 0;

    const done = onceDone(ctx, streamSessionId);
    const sent = handlers['conversation:send']({ sessionId: streamSessionId, text: '请说明这个技能的结构。' });
    assert.equal(sent.accepted, true);
    assert.equal(sent.sessionId, streamSessionId);
    assert.equal(sent.status, 'queued');
    await done;

    const view = handlers['conversation:get']({ sessionId: streamSessionId });
    assert.equal(view.status, 'done');
    assert.equal(view.messages.length, 2, '用户消息 + assistant 消息');
    assert.equal(view.messages[0].role, 'user');
    assert.equal(view.messages[0].text, '请说明这个技能的结构。');
    assert.equal(view.messages[1].role, 'assistant');
    assert.match(view.messages[1].text, /第一段增量/);
    assert.equal(view.messages[1].status, 'complete');
    assert.ok(view.lastRun?.totalTokens >= 1, 'usage 已落盘');
    assert.equal(view.draftPrompt, null, '发送后草稿清空');

    const types = allEvents.map((event) => `${event.type}:${event.status ?? ''}`);
    const runningIndex = types.indexOf('status:running');
    const firstDelta = allEvents.findIndex((event) => event.type === 'message' && typeof event.delta === 'string' && event.delta.length > 0);
    const deltaCount = allEvents.filter((event) => event.type === 'message' && event.role === 'assistant' && !event.final).length;
    const usageIndex = allEvents.findIndex((event) => event.type === 'usage');
    const doneIndex = allEvents.findIndex((event) => event.type === 'done');
    assert.ok(runningIndex >= 0, '有 running 状态');
    assert.ok(firstDelta > runningIndex, '增量在 running 之后');
    assert.ok(deltaCount >= 2, `增量事件数：${deltaCount}`);
    assert.ok(usageIndex > firstDelta, 'usage 在增量之后');
    assert.ok(doneIndex > usageIndex, 'done 在 usage 之后');
    assert.equal(allEvents[doneIndex].status, 'done');

    // 请求模型正确（当前生效模型）
    assert.equal(FAKE.requests.length > 0, true);
    assert.equal(FAKE.requests[FAKE.requests.length - 1].model, 'mock-model');
  });

  test('空提示词被拒绝；运行中 Enter 排队、Ctrl+Enter 转入当前轮', async () => {
    assert.throws(() => handlers['conversation:send']({ sessionId: streamSessionId, text: '   ' }), /非空字符串|提示词不能为空/);
    resetFake({ kind: 'slow', text: '慢速开始-', delayMs: 2500 });
    const created = handlers['conversation:create']({ mode: 'blank' });
    const done = onceDone(ctx, created.sessionId);
    handlers['conversation:send']({ sessionId: created.sessionId, text: '慢一点。' });
    await waitUntil(() => handlers['conversation:get']({ sessionId: created.sessionId }).running, 8000, '进入运行');
    const queued = await handlers['conversation:send']({ sessionId: created.sessionId, text: '下一轮再说。', mode: 'queue' });
    assert.equal(queued.accepted, true);
    assert.equal(queued.status, 'queued');
    const steered = await handlers['conversation:send']({ sessionId: created.sessionId, text: '当前轮补充。', mode: 'steer' });
    assert.equal(steered.accepted, true);
    assert.equal(steered.status, 'steered');
    const busyView = handlers['conversation:get']({ sessionId: created.sessionId });
    assert.deepEqual(busyView.messages.filter((message) => message.role === 'user').map((message) => message.text),
      ['慢一点。', '下一轮再说。', '当前轮补充。']);
    await handlers['conversation:cancel']({ sessionId: created.sessionId });
    await done;
  });

  test('运行中排队的消息在当前回复结束后实际进入下一次模型请求', async () => {
    resetFake({ kind: 'text', text: '正在处理。', chunks: 3, delayMs: 160 });
    const created = handlers['conversation:create']({ mode: 'blank' });
    const beforeRequests = FAKE.requests.length;
    const done = onceDone(ctx, created.sessionId);
    handlers['conversation:send']({ sessionId: created.sessionId, text: '第一条' });
    await waitUntil(() => FAKE.requests.length > beforeRequests, 8000, '首条模型请求');
    const queued = await handlers['conversation:send']({ sessionId: created.sessionId, text: '第二条', mode: 'queue' });
    assert.equal(queued.status, 'queued');
    await done;
    assert.ok(FAKE.requests.length >= beforeRequests + 2, '排队消息触发第二次模型请求');
    const view = handlers['conversation:get']({ sessionId: created.sessionId });
    assert.ok(view.messages.some((message) => message.role === 'user' && message.text === '第二条'));
  });
});

// ── 4. 取消：cancelled + 已收文本保留 ─────────────────────────────────────

describe('T15 中断', () => {
  test('cancel 后状态 cancelled，已接收的 assistant 文本保留', async () => {
    resetFake({ kind: 'slow', text: '这是取消前已经收到的开头。', delayMs: 5000 });
    const created = handlers['conversation:create']({ mode: 'blank' });
    allEvents.length = 0;
    const done = onceDone(ctx, created.sessionId);
    handlers['conversation:send']({ sessionId: created.sessionId, text: '讲一段很长的内容。' });
    await waitUntil(() => {
      const view = handlers['conversation:get']({ sessionId: created.sessionId });
      return view.messages.some((message) => message.role === 'assistant' && message.text.length > 0);
    }, 10_000, 'assistant 首个增量');

    const canceled = await handlers['conversation:cancel']({ sessionId: created.sessionId });
    assert.equal(canceled.canceled, true);
    await done;

    const view = handlers['conversation:get']({ sessionId: created.sessionId });
    assert.equal(view.status, 'cancelled');
    assert.equal(view.running, false);
    assert.equal(view.lastRun?.status, 'cancelled');
    const assistant = view.messages.find((message) => message.role === 'assistant');
    assert.ok(assistant, 'assistant 消息保留');
    assert.match(assistant.text, /取消前已经收到的开头/);
    assert.equal(assistant.status, 'aborted');

    const statuses = allEvents.filter((event) => event.type === 'status').map((event) => event.status);
    assert.ok(statuses.includes('cancelling'), '中断中有中间态');
    assert.ok(statuses.includes('cancelled'), '终态为 cancelled');
    const errorEvent = allEvents.find((event) => event.type === 'error');
    assert.equal(errorEvent?.code, 'TASK_CANCELLED');
    assert.equal(errorEvent?.retryable, false);

    // 取消后可继续发送（同一会话）
    resetFake({ kind: 'text', text: '继续完成。', chunks: 2 });
    const done2 = onceDone(ctx, created.sessionId);
    handlers['conversation:send']({ sessionId: created.sessionId, text: '继续。' });
    await done2;
    const after = handlers['conversation:get']({ sessionId: created.sessionId });
    assert.equal(after.status, 'done');
    assert.equal(after.messages.filter((message) => message.role === 'user').length, 2);
  });
});

// ── 4.5 归档会话（界面叫「归档」，行为是删除） ─────────────────────────────

describe('T15 归档会话', () => {
  test('归档后从列表消失，会话记录/事件日志/Pi 会话文件一并删除', async () => {
    resetFake({ kind: 'text', text: '归档用例的回复。', chunks: 2 });
    const created = handlers['conversation:create']({ mode: 'blank' });
    const sessionId = created.sessionId;
    const done = onceDone(ctx, sessionId);
    handlers['conversation:send']({ sessionId, text: '归档前先跑一轮。' });
    await done;

    const recordFile = path.join(DATA, 'sessions', `${sessionId}.json`);
    const eventsFile = path.join(DATA, 'sessions', `${sessionId}.events.jsonl`);
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    const piFile = record.piSessionFile
      ? path.join(DATA, record.piSessionFile.split('/').join(path.sep))
      : null;
    assert.ok(fs.existsSync(recordFile), '会话记录已落盘');
    assert.ok(fs.existsSync(eventsFile), '事件日志已落盘');
    assert.ok(piFile && fs.existsSync(piFile), 'Pi 会话文件已生成');

    const archived = handlers['conversation:delete']({ sessionId });
    assert.deepEqual(archived, { sessionId, deleted: true });
    assert.equal(handlers['conversation:list']().items.some((item) => item.id === sessionId), false);
    assert.equal(fs.existsSync(recordFile), false);
    assert.equal(fs.existsSync(eventsFile), false);
    assert.equal(fs.existsSync(piFile), false);
    assert.throws(() => handlers['conversation:get']({ sessionId }), /会话不存在/);
  });

  test('运行中的会话拒绝归档，中断后可归档', async () => {
    resetFake({ kind: 'slow', text: '还在输出。', delayMs: 5000 });
    const created = handlers['conversation:create']({ mode: 'blank' });
    const sessionId = created.sessionId;
    const done = onceDone(ctx, sessionId);
    handlers['conversation:send']({ sessionId, text: '讲一段很长的内容。' });
    await waitUntil(
      () => handlers['conversation:get']({ sessionId }).running,
      10_000,
      '进入运行态',
    );

    assert.throws(() => handlers['conversation:delete']({ sessionId }), /不能归档/);
    await handlers['conversation:cancel']({ sessionId });
    await done;

    handlers['conversation:delete']({ sessionId });
    assert.equal(handlers['conversation:list']().items.some((item) => item.id === sessionId), false);
  });
});

// ── 5. 文件卡与只读预览 ─────────────────
describe('T15 文件卡与只读预览', () => {
  test('Agent 写入 SKILL.md → 文件卡可见；查看区只读预览', async () => {
    const newMd = '---\nname: improve-skill\ndescription: 改进后的描述：按议题整理会议纪要\n---\n\n# improve-skill\n\nv2 正文（模型写入）\n';
    resetFake({
      kind: 'tool',
      calls: [{ name: 'write', args: { path: 'SKILL.md', content: newMd } }],
      text: '我来改写 SKILL.md。',
    });
    FAKE.afterTool = { kind: 'text', text: '已更新 SKILL.md。' };

    const improve = handlers['conversation:create']({ mode: 'improve', targetSkillId: ids['improve-skill'] });
    const done = onceDone(ctx, improve.sessionId);
    handlers['conversation:send']({ sessionId: improve.sessionId, text: '请按流程改进这个技能。' });
    await done;

    const view = handlers['conversation:get']({ sessionId: improve.sessionId });
    assert.equal(view.status, 'done');
    const file = view.files.find((entry) => entry.relPath === 'SKILL.md');
    assert.ok(file, `文件引用应出现在会话：${JSON.stringify(view.files)}`);
    assert.ok(file.bytes > 0);
    assert.equal(file.exists, true);
    const changedMessage = view.messages.find((message) => message.fileChanges.length > 0);
    assert.ok(changedMessage, '本轮对话应展示文件变更');
    assert.deepEqual(changedMessage.fileChanges.map((change) => change.relPath), ['SKILL.md']);
    assert.ok(changedMessage.fileChanges[0].added > 0);
    assert.ok(changedMessage.fileChanges[0].removed > 0);
    const change = handlers['conversation:fileChange']({
      sessionId: improve.sessionId, runId: changedMessage.changeRunId, relPath: 'SKILL.md',
    });
    assert.match(change.before.content, /v1 正文/);
    assert.match(change.after.content, /v2 正文（模型写入）/);
    assert.throws(() => handlers['conversation:fileChange']({
      sessionId: improve.sessionId, runId: changedMessage.changeRunId, relPath: '../outside.md',
    }), /差异记录不存在/);
    assert.deepEqual(handlers['conversation:get']({ sessionId: improve.sessionId }).messages
      .find((message) => message.changeRunId === changedMessage.changeRunId).fileChanges, changedMessage.fileChanges);

    const onDisk = fs.readFileSync(path.join(SKILLS, 'improve-skill', 'SKILL.md'), 'utf8');
    assert.match(onDisk, /v2 正文（模型写入）/);

    const toolEvents = allEvents.filter((event) => event.type === 'tool');
    assert.ok(toolEvents.some((event) => event.name === 'write' && event.phase === 'end'));
    assert.ok(allEvents.some((event) => event.type === 'file' && event.relPath === 'SKILL.md'));

    const preview = handlers['conversation:previewFile']({ sessionId: improve.sessionId, relPath: 'SKILL.md' });
    assert.match(preview.content, /v2 正文/);
    assert.equal(preview.base64, null);
    assert.equal(preview.reason, null);
    assert.equal(preview.absolutePath, path.join(SKILLS, 'improve-skill', 'SKILL.md'));
    assert.equal((await handlers['conversation:showFile']({ sessionId: improve.sessionId, relPath: 'SKILL.md' })).opened, true);
    assert.equal(handlers['conversation:writeFile'], undefined, '查看区不暴露保存接口');
    assert.equal(fs.readFileSync(path.join(SKILLS, 'improve-skill', 'SKILL.md'), 'utf8'), onDisk);
    fs.writeFileSync(path.join(SKILLS, 'improve-skill', 'SKILL.md'), '外部后续修改\n');
    assert.match(handlers['conversation:fileChange']({ sessionId: improve.sessionId,
      runId: changedMessage.changeRunId, relPath: 'SKILL.md' }).after.content, /v2 正文（模型写入）/,
    '历史差异应读取保存的快照，不受当前文件变化影响');
    fs.writeFileSync(path.join(SKILLS, 'improve-skill', 'SKILL.md'), onDisk);

    // 越界路径被拒绝
    assert.throws(
      () => handlers['conversation:previewFile']({ sessionId: improve.sessionId, relPath: '../outside.md' }),
      /越界|不能越出/,
    );
    assert.throws(
      () => handlers['conversation:previewFile']({ sessionId: improve.sessionId, relPath: 'C:/Windows/win.ini' }),
      /绝对路径|相对路径/,
    );
    await assert.rejects(
      () => handlers['conversation:showFile']({ sessionId: improve.sessionId, relPath: '../outside.md' }),
      /越界|不能越出/,
    );
  });

  test('空白会话授权到中心库 skills/ 根：写入落在该根内', async () => {
    resetFake({
      kind: 'tool',
      calls: [{ name: 'write', args: { path: 'notes.md', content: '# 草稿\n' } }],
    });
    FAKE.afterTool = { kind: 'text', text: '草稿已写入。' };
    const created = handlers['conversation:create']({ mode: 'blank' });
    assert.equal(
      path.resolve(ctx.conversations.getSession(created.sessionId).authorizedDir),
      path.resolve(SKILLS),
      '新对话与快捷入口同一授权口径',
    );
    const done = onceDone(ctx, created.sessionId);
    handlers['conversation:send']({ sessionId: created.sessionId, text: '先写一份草稿。' });
    await done;
    const view = handlers['conversation:get']({ sessionId: created.sessionId });
    const file = view.files.find((entry) => entry.relPath === 'notes.md');
    assert.ok(file);
    assert.equal(file.exists, true);
    const changeMessage = view.messages.find((message) => message.fileChanges.length > 0);
    assert.deepEqual(changeMessage.fileChanges[0], { relPath: 'notes.md', status: 'added', added: 1, removed: 0 });
    const change = handlers['conversation:fileChange']({ sessionId: created.sessionId,
      runId: changeMessage.changeRunId, relPath: 'notes.md' });
    assert.equal(change.before.exists, false);
    assert.equal(change.after.content, '# 草稿\n');
    const detail = handlers['conversation:previewFile']({ sessionId: created.sessionId, relPath: 'notes.md' });
    assert.equal(detail.content, '# 草稿\n');
    assert.equal(fs.existsSync(path.join(SKILLS, 'notes.md')), true, '写入落在中心库 skills/ 根');
  });

  test('写入相同内容时不显示虚假的文件变更', async () => {
    const content = fs.readFileSync(path.join(SKILLS, 'evaluate-skill', 'SKILL.md'), 'utf8');
    resetFake({ kind: 'tool', name: 'write', args: { path: 'SKILL.md', content } });
    FAKE.afterTool = { kind: 'text', text: '已检查。' };
    const session = handlers['conversation:create']({ mode: 'improve', targetSkillId: ids['evaluate-skill'] });
    const done = onceDone(ctx, session.sessionId);
    handlers['conversation:send']({ sessionId: session.sessionId, text: '保持文件内容不变。' });
    await done;
    const view = handlers['conversation:get']({ sessionId: session.sessionId });
    assert.equal(view.messages.some((message) => message.fileChanges.length > 0), false);
  });

  test('图片与 PDF 作为只读二进制预览返回，过大文件不读取', () => {
    const dir = path.join(SKILLS, 'improve-skill');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
    fs.writeFileSync(path.join(dir, 'preview.png'), image);
    fs.writeFileSync(path.join(dir, 'preview.pdf'), pdf);
    fs.writeFileSync(path.join(dir, 'oversize.bin'), '');
    fs.truncateSync(path.join(dir, 'oversize.bin'), 32 * 1024 * 1024 + 1);
    const session = handlers['conversation:create']({ mode: 'improve', targetSkillId: ids['improve-skill'] });
    const png = handlers['conversation:previewFile']({ sessionId: session.sessionId, relPath: 'preview.png' });
    assert.equal(png.mediaType, 'image/png');
    assert.equal(png.base64, image.toString('base64'));
    assert.equal(png.content, null);
    const document = handlers['conversation:previewFile']({ sessionId: session.sessionId, relPath: 'preview.pdf' });
    assert.equal(document.mediaType, 'application/pdf');
    assert.equal(document.base64, pdf.toString('base64'));
    assert.equal(document.content, null);
    const oversized = handlers['conversation:previewFile']({ sessionId: session.sessionId, relPath: 'oversize.bin' });
    assert.equal(oversized.reason, 'TOO_LARGE');
    assert.equal(oversized.base64, null);
  });
});

// ── 6. 评测：报告生成并可读 ───────────────────────────────────────────────

describe('T15 评测报告', () => {
  test('旧版只读检查会话继续发送修复要求时可写入授权目录', async () => {
    const evaluate = handlers['conversation:create']({ mode: 'evaluate', targetSkillId: ids['evaluate-skill'] });
    resetFake({ kind: 'text', text: '# 检查结果\n建议补充说明。' });
    const checked = onceDone(ctx, evaluate.sessionId);
    handlers['conversation:send']({ sessionId: evaluate.sessionId, text: evaluate.prompt });
    await checked;
    await waitUntil(() => latestReport('evaluate-skill') != null, 8000, '检查报告落盘');

    const file = ctx.conversations.store.file(evaluate.sessionId);
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    legacy.toolPolicy = 'read-only';
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.equal(ctx.conversations.getSession(evaluate.sessionId).toolPolicy, 'read-write');

    resetFake({ kind: 'tool', name: 'write', args: { path: 'repair-note.md', content: '已修复\n' } });
    FAKE.afterTool = { kind: 'text', text: '已按建议修复。' };
    const done = onceDone(ctx, evaluate.sessionId);
    handlers['conversation:send']({ sessionId: evaluate.sessionId, text: '按你的建议进行修复' });
    await done;

    assert.equal(fs.readFileSync(path.join(SKILLS, 'evaluate-skill', 'repair-note.md'), 'utf8'), '已修复\n');
    assert.ok(FAKE.requests.some((request) =>
      request.tools?.some((tool) => tool.function.name === 'write')));
    assert.equal(ctx.conversations.getSession(evaluate.sessionId).toolPolicy, 'read-write');
    assert.equal(ctx.conversations.getSession(evaluate.sessionId).workflow, null, '后续追问不再受 skill-doctor 的只诊断指令约束');
    assert.equal(ctx.conversations.getSession(evaluate.sessionId).systemPrompt, '');
    assert.match(fs.readFileSync(latestReport('evaluate-skill'), 'utf8'), /建议补充说明/, '修复追问不覆盖检查报告');
  });

  test('evaluate 会话运行完成 → reports/<技能名>_review_<时间戳>.md 生成，会话以文本打开', async () => {
    const reportText = '# 评测结果 · evaluate-skill\n\n总评：结构完整。\n\n## 逐项检查\n- frontmatter：通过\n\n## 结论\n建议补充输出模板。\n';
    resetFake({ kind: 'text', text: reportText, chunks: 3 });
    const evaluate = handlers['conversation:create']({ mode: 'evaluate', targetSkillId: ids['evaluate-skill'] });
    const done = onceDone(ctx, evaluate.sessionId);
    handlers['conversation:send']({ sessionId: evaluate.sessionId, text: '请按流程评测这个技能。' });
    await done;

    // 报告在运行结束后的工作流后处理里落盘：等它出现（界面同样靠刷新信号获知）
    await waitUntil(() => latestReport('evaluate-skill') != null, 10_000, '评测报告落盘');
    const reportPath = latestReport('evaluate-skill');
    assert.match(path.basename(reportPath), /^evaluate-skill_review_\d{8}-\d{6}\.md$/);
    assert.equal(fs.readFileSync(reportPath, 'utf8'), reportText);

    const view = await waitUntil(() => {
      const detail = handlers['conversation:get']({ sessionId: evaluate.sessionId });
      return detail.report?.exists ? detail : null;
    }, 8000, '会话读到报告');
    assert.equal(view.status, 'done');
    assert.equal(view.report?.exists, true);
    assert.match(view.report?.relPath ?? '', /^reports\/evaluate-skill_review_\d{8}-\d{6}\.md$/);
    assert.match(view.report?.text ?? '', /总评：结构完整/);

    const viaLibrary = handlers['library:report']({ skillId: ids['evaluate-skill'] });
    assert.equal(viaLibrary.exists, true);
    assert.equal(viaLibrary.text, reportText);

    // 模型只返回文本时技能内容不变；评测会话仍具备授权目录内的写入能力。
    const skillDir = path.join(SKILLS, 'evaluate-skill');
    assert.equal(fs.existsSync(path.join(skillDir, 'SKILL.md')), true);
    assert.equal(latestReport('evaluate-skill') != null, true);
    assert.equal(fs.readdirSync(path.join(LIB, 'reports')).filter((f) => f.startsWith('evaluate-skill_review_')).length, 1, '只保留最新一份');
  });
});

// ── 7. 模型菜单：addModel 去重 / setModel 生效 ────────────────────────────

describe('T15 模型菜单', () => {
  test('providers:models 只列当前供应商模型；addModel 去重并立即可选', () => {
    const initial = handlers['providers:models']();
    assert.equal(initial.providerId, 'ollama');
    assert.deepEqual(initial.models, ['mock-model']);
    assert.equal(initial.runnable, true);

    const duplicate = handlers['providers:addModel']({ modelId: 'mock-model' });
    assert.deepEqual(duplicate.models, ['mock-model'], '重复添加不产生副本');

    const added = handlers['providers:addModel']({ modelId: 'mock-model-pro' });
    assert.deepEqual(added.models, ['mock-model', 'mock-model-pro']);
    assert.equal(added.activeModelId, 'mock-model-pro', '新增后立即可选');

    const restored = handlers['providers:addModel']({ modelId: 'mock-model' });
    assert.equal(restored.activeModelId, 'mock-model');
  });

  test('conversation:setModel 生效：下一次请求使用所选模型', async () => {
    resetFake({ kind: 'text', text: '使用指定模型回答。', chunks: 2 });
    const created = handlers['conversation:create']({ mode: 'blank' });
    const switched = handlers['conversation:setModel']({ sessionId: created.sessionId, modelId: 'mock-model-pro' });
    assert.equal(switched.modelId, 'mock-model-pro');
    assert.equal(handlers['conversation:get']({ sessionId: created.sessionId }).modelId, 'mock-model-pro');

    const done = onceDone(ctx, created.sessionId);
    handlers['conversation:send']({ sessionId: created.sessionId, text: '请回答。' });
    await done;
    assert.equal(FAKE.requests[FAKE.requests.length - 1].model, 'mock-model-pro');

    // 未添加的模型被拒绝
    assert.throws(
      () => handlers['conversation:setModel']({ sessionId: created.sessionId, modelId: 'not-added' }),
      /INVALID_MODEL/,
    );
  });

  test('推理强度跟模型记忆：会话里选过的档带到下一个新会话', () => {
    const first = handlers['conversation:create']({ mode: 'blank' });
    // 未收录在 Pi 目录的模型三档全开，未设置时默认 High
    assert.equal(handlers['conversation:get']({ sessionId: first.sessionId }).thinkingLevel, 'high');

    handlers['conversation:setThinkingLevel']({ sessionId: first.sessionId, thinkingLevel: 'max' });
    assert.equal(handlers['conversation:get']({ sessionId: first.sessionId }).thinkingLevel, 'max', '会话级强度落盘后可读回');
    assert.equal(handlers['providers:models']().activeThinkingLevel, 'max', '与当前模型成对记下');

    // 新会话沿用上次为该模型选的档，而不是退回最低档
    const second = handlers['conversation:create']({ mode: 'blank' });
    assert.equal(handlers['conversation:get']({ sessionId: second.sessionId }).thinkingLevel, 'max');

    handlers['conversation:setThinkingLevel']({ sessionId: first.sessionId, thinkingLevel: 'low' });
    const third = handlers['conversation:create']({ mode: 'blank' });
    assert.equal(handlers['conversation:get']({ sessionId: third.sessionId }).thinkingLevel, 'low', '用户显式选择 Low 时继续沿用');
  });
});

// ── 8. 未配置模型：可读引导而不是崩溃 ─────────────────────────────────────

describe('T15 未配置模型', () => {
  test('send → NO_MODEL_CONFIGURED + 去设置引导；详情带 guidance', async () => {
    const emptyDirs = makeDirs('empty-run');
    writeSkill(path.join(emptyDirs.lib, 'skills', 'empty-skill'), 'empty-skill', '空环境样本');
    const emptyCtx = newContext(emptyDirs);
    const emptyHandlers = makeHandlers(emptyCtx, emptyDirs);
    try {
      await emptyCtx.library.rescan();
      const emptySkillId = emptyCtx.library.listSkills()[0].skillId;
      const created = emptyHandlers['conversation:create']({ mode: 'blank' });
      assert.ok(created.sessionId, '未配置模型仍可建会话');
      const sent = emptyHandlers['conversation:send']({ sessionId: created.sessionId, text: '你好' });
      assert.equal(sent.accepted, false);
      assert.equal(sent.error?.code, 'NO_MODEL_CONFIGURED');
      assert.equal(sent.error?.action, 'settings');
      assert.ok((sent.error?.detail ?? '').length > 0, '带可读原因');

      const view = emptyHandlers['conversation:get']({ sessionId: created.sessionId });
      assert.equal(view.modelConfigured, false);
      assert.ok(view.modelGuidance && view.modelGuidance.length > 0);
      assert.equal(view.messages.length, 0, '未启动运行');

      const improve = emptyHandlers['conversation:create']({ mode: 'improve', targetSkillId: emptySkillId });
      assert.equal(improve.sessionId, null);
      assert.equal(improve.error?.code, 'NO_MODEL_CONFIGURED');
      assert.equal(improve.error?.action, 'settings');

      const models = emptyHandlers['providers:models']();
      assert.deepEqual(models.models, []);
      assert.equal(models.runnable, false);
      assert.ok(models.guidance);
    } finally {
      emptyCtx.dispose();
    }
  });
});

// ── 9. 调用失败：401 / 504 映射可读 ──────────────────────────────────────

describe('T15 调用失败', () => {
  test('401 → PROVIDER_AUTH_FAILED；504 → PROVIDER_TIMEOUT（retryable）', async () => {
    resetFake({ kind: 'status', status: 401, message: 'invalid api key' });
    const s1 = handlers['conversation:create']({ mode: 'blank' });
    let done = onceDone(ctx, s1.sessionId);
    handlers['conversation:send']({ sessionId: s1.sessionId, text: '你好' });
    await done;
    let view = handlers['conversation:get']({ sessionId: s1.sessionId });
    assert.equal(view.status, 'failed');
    assert.equal(view.error?.code, 'PROVIDER_AUTH_FAILED');
    assert.match(view.error?.detail ?? '', /API Key|401|invalid/i);
    const authEvent = allEvents.filter((event) => event.type === 'error').at(-1);
    assert.equal(authEvent?.code, 'PROVIDER_AUTH_FAILED');

    resetFake({ kind: 'status', status: 504, message: 'gateway timeout' });
    const s2 = handlers['conversation:create']({ mode: 'blank' });
    done = onceDone(ctx, s2.sessionId);
    handlers['conversation:send']({ sessionId: s2.sessionId, text: '你好' });
    await done;
    view = handlers['conversation:get']({ sessionId: s2.sessionId });
    assert.equal(view.status, 'failed');
    assert.equal(view.error?.code, 'PROVIDER_TIMEOUT');
    const timeoutEvent = allEvents.filter((event) => event.type === 'error').at(-1);
    assert.equal(timeoutEvent?.retryable, true);
  });
});

// ── 10. 重启：列表/消息/文件可读并可继续 ──────────────────────────────────

describe('T15 重启恢复', () => {
  test('新实例读取旧会话（消息/文件/报告）并能继续对话', async () => {
    const before = handlers['conversation:list']().items;
    assert.ok(before.length >= 6, `会话数：${before.length}`);
    const improveItem = before.find((item) => item.title.startsWith('优化 Skill：') && item.messageCount >= 2);
    assert.ok(improveItem, '优化会话在列表中');
    assert.equal(improveItem.targetSkillId, ids['improve-skill']);
    assert.equal(improveItem.targetSkillName, 'improve-skill');

    await ctx.conversations.dispose();
    ctx.dispose();

    // 模拟重启：同一 DATA_DIR / 库目录重新装配
    ctx = newContext(dirs);
    handlers = makeHandlers(ctx, dirs);

    const list = handlers['conversation:list']().items;
    assert.ok(list.length >= before.length, '重启后会话列表仍可读');

    const improveView = handlers['conversation:get']({ sessionId: improveItem.id });
    assert.equal(improveView.status, 'done');
    assert.ok(improveView.messages.length >= 2);
    assert.ok(improveView.files.some((file) => file.relPath === 'SKILL.md'), '文件引用恢复');
    assert.equal(improveView.canContinue, true);

    const evaluateItem = list.find((item) => item.workflow === 'evaluate');
    assert.ok(evaluateItem);
    const evaluateView = handlers['conversation:get']({ sessionId: evaluateItem.id });
    assert.equal(evaluateView.report?.exists, true, '报告在重启后可读');
    assert.match(evaluateView.report?.text ?? '', /逐项检查/);

    // 从原会话继续
    resetFake({ kind: 'text', text: '重启后继续的回复。', chunks: 2 });
    const done = onceDone(ctx, improveItem.id);
    const sent = handlers['conversation:send']({ sessionId: improveItem.id, text: '继续改进，补充输出模板。' });
    assert.equal(sent.accepted, true);
    await done;
    const after = handlers['conversation:get']({ sessionId: improveItem.id });
    assert.equal(after.status, 'done');
    assert.ok(after.messages.length > improveView.messages.length, '消息继续累积');
    assert.match(after.messages.at(-1).text, /重启后继续的回复/);
  });
});
