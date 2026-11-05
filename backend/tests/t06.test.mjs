// T06 自动验证：Pi 内核、供应商与凭据、受限工具、事件流与持久会话
// 运行：cd backend && npm run build && node --no-warnings --test tests/t06.test.mjs
//
// 隔离纪律：一切写操作只落 tests/runtime/（t06-data / t06-sandbox / t06-outside）；
// 凭据只用测试键 skills-studio-test/*，测试结束清理；绝不读写真实用户目录与真实 Agent 技能目录。
//
// ⚠ 缺失条件（P0 未闭环）：C-25/C-26/C-27 的端到端验证使用**本地模拟 OpenAI 兼容服务**
//   （Node http，脚本化 SSE 响应）。真实供应商调用需要用户提供 API Key 后才能验收；
//   本文件不把模拟结果写成真实模型验收通过。
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
const ROOT = path.join(RUNTIME, 't06');
const DATA = path.join(ROOT, 'data');
const DATA_EMPTY = path.join(ROOT, 'data-empty');
/** 多模型用例独立数据目录：不污染 DATA 里的既有断言 */
const DATA_MULTI = path.join(ROOT, 'data-multi');
const SANDBOX = path.join(ROOT, 'sandbox');
const OUTSIDE = path.join(ROOT, 'outside');
const LOG_FILE = path.join(ROOT, 'agent.log');

const TEST_KEY = 'sk-test-T06-abcdef1234567890';
const CREDENTIAL_PREFIX = 'skills-studio-test/';

const {
  ConversationService,
  ProviderConfigService,
  CredentialVault,
  ToolScopeGuard,
  registerSecret,
  clearSecrets,
  redactText,
  ALLOWED_TOOLS,
} = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href);
const { WindowsCredentialStore } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'infra', 'win-credential.js')).href
);

// ── 本地假 provider（脚本化 SSE） ─────────────────────────────────────────

const FAKE = {
  requests: [],
  /** 首次请求（最后一条不是 tool 结果）时的行为 */
  action: { kind: 'text', text: '默认回复' },
  /** 工具结果返回后的行为 */
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
      const usage = action.usage ?? { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 };

      if (action.kind === 'status') {
        res.writeHead(action.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: action.message, type: 'fake_error' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (action.kind === 'slow') {
        const head = action.text ?? '慢速开始-';
        sseSend(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: head }, finish_reason: null }] });
        await sleep(action.delayMs ?? 6000);
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
                tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: action.name, arguments: '' } }],
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
      sseSend(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, mid) }, finish_reason: null }] });
      sseSend(res, { ...base, choices: [{ index: 0, delta: { content: text.slice(mid) }, finish_reason: null }] });
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

/** 递归收集目录下所有文件（跳过 .git） */
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

function findLeaks(roots, secret) {
  const hits = [];
  for (const root of roots) {
    for (const file of walkFiles(root)) {
      let raw;
      try {
        raw = fs.readFileSync(file);
      } catch {
        continue;
      }
      if (raw.includes(secret)) hits.push(file);
    }
  }
  return hits;
}

// ── 测试夹具 ─────────────────────────────────────────────────────────────

let providers;
let service;
let sessionId;
const appendedLogs = [];

const testLogger = {
  info: (event, data) => {
    const line = JSON.stringify([event, data ?? null]);
    appendedLogs.push(line);
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  },
  error: (event, data) => {
    const line = JSON.stringify([event, data ?? null]);
    appendedLogs.push(line);
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  },
};

before(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(DATA_EMPTY, { recursive: true });
  fs.mkdirSync(DATA_MULTI, { recursive: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.writeFileSync(LOG_FILE, '', 'utf8');
  await startFakeProvider();
  resetFake();
});

after(async () => {
  // 清理正在运行的会话（若有用例失败留下活动运行）
  try {
    await service?.dispose();
  } catch {
    /* 忽略 */
  }
  // 清理测试凭据键与假服务
  try {
    const vault = new CredentialVault(new WindowsCredentialStore(), CREDENTIAL_PREFIX);
    for (const id of ['openai-compatible', 'openai', 'ollama']) {
      vault.delete(id);
    }
  } catch {
    /* 清理失败不掩盖测试结果 */
  }
  clearSecrets();
  if (FAKE.server) await new Promise((resolve) => FAKE.server.close(resolve));
});

// ── 供应商 / 模型 / 凭据 ──────────────────────────────────────────────────

describe('T06 供应商与凭据', () => {
  test('空配置 → 不可运行且给出可读引导（不崩溃）', () => {
    const empty = new ProviderConfigService({ dataDir: DATA_EMPTY, credentialPrefix: CREDENTIAL_PREFIX });
    const view = empty.view();
    assert.equal(view.runnable, false);
    assert.equal(view.providers.length, 0);
    assert.match(view.guidance, /尚未配置模型供应商/);
    assert.equal(view.presets.length, 14);
    assert.deepEqual(
      view.presets.map((p) => p.preset),
      [
        'openai',
        'anthropic',
        'gemini',
        'deepseek',
        'moonshotai',
        'zhipu',
        'qwen',
        'minimax',
        'siliconflow',
        'volcengine',
        'xai',
        'openrouter',
        'ollama',
        'openai-compatible',
      ],
    );
  });

  test('预设默认值、模型逐个添加、单选唯一生效供应商', () => {
    providers = new ProviderConfigService({ dataDir: DATA, credentialPrefix: CREDENTIAL_PREFIX });
    const openai = providers.addProvider({ preset: 'openai' });
    assert.equal(openai.baseUrl, 'https://api.openai.com/v1');
    assert.equal(openai.apiFormat, 'openai-responses');
    assert.equal(openai.requiresApiKey, true);

    const anthropic = providers.addProvider({ preset: 'anthropic' });
    assert.equal(anthropic.apiFormat, 'anthropic-messages');

    const gemini = providers.addProvider({ preset: 'gemini' });
    assert.equal(gemini.apiFormat, 'google-generative-ai');
    assert.equal(gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');

    // OpenAI 兼容端点是测试用的假服务
    const compat = providers.addProvider({
      preset: 'openai-compatible',
      name: '本地模拟服务',
      baseUrl: FAKE.baseUrl,
    });
    assert.equal(compat.models.length, 0);
    providers.addModel('openai-compatible', 'fake-model');
    providers.addModel('openai-compatible', 'fake-model'); // 去重
    providers.addModel('openai-compatible', 'fake-model-2');
    providers.setActiveProvider('openai-compatible');

    const config = providers.readConfig();
    assert.equal(config.activeProviderId, 'openai-compatible');
    assert.equal(config.activeModelId, 'fake-model');
    assert.deepEqual(
      config.providers.find((p) => p.id === 'openai-compatible').models,
      ['fake-model', 'fake-model-2'],
    );
    // 单选：切换后只有一个生效
    providers.setActiveProvider('openai');
    assert.equal(providers.readConfig().activeProviderId, 'openai');
    providers.setActiveProvider('openai-compatible');
    assert.equal(providers.readConfig().activeProviderId, 'openai-compatible');
    assert.throws(() => providers.setActiveProvider('not-exist'), /INVALID_PROVIDER/);
  });

  test('一个供应商可挂多个模型：候选来自 Pi 目录、可增删、删除生效模型后回退', () => {
    const multi = new ProviderConfigService({ dataDir: DATA_MULTI, credentialPrefix: CREDENTIAL_PREFIX });

    // 候选清单只作提示：Pi 收录的厂商有值，未收录的国内厂商为空
    const presets = multi.view().presets;
    assert.ok(presets.find((p) => p.preset === 'deepseek').suggestedModels.includes('deepseek-flash'));
    assert.equal(presets.find((p) => p.preset === 'zhipu').suggestedModels.length, 0);
    assert.equal(presets.find((p) => p.preset === 'openai-compatible').suggestedModels.length, 0);

    // 创建时整份写入（去重保序），首个模型自动生效
    multi.addProvider({
      preset: 'deepseek',
      models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-flash'],
    });
    let config = multi.readConfig();
    assert.deepEqual(config.providers[0].models, ['deepseek-flash', 'deepseek-v4-pro']);
    assert.equal(config.activeProviderId, 'deepseek');
    assert.equal(config.activeModelId, 'deepseek-flash');
    // 候选不写入配置：models 只包含用户添加的
    assert.equal(config.providers[0].models.length, 2);

    multi.setActiveModel('deepseek-v4-pro');
    assert.equal(multi.readConfig().activeModelId, 'deepseek-v4-pro');

    // 删除生效模型 → 回退到剩余第一个
    multi.removeModel('deepseek', 'deepseek-v4-pro');
    config = multi.readConfig();
    assert.deepEqual(config.providers[0].models, ['deepseek-flash']);
    assert.equal(config.activeModelId, 'deepseek-flash');

    // 编辑供应商时给 models = 整份替换；原生效模型不在新清单里则回退
    multi.addProvider({ preset: 'deepseek', models: ['deepseek-v4-pro'] });
    config = multi.readConfig();
    assert.deepEqual(config.providers[0].models, ['deepseek-v4-pro']);
    assert.equal(config.activeModelId, 'deepseek-v4-pro');

    // 删空后不可运行，引导回设置页补模型
    multi.removeModel('deepseek', 'deepseek-v4-pro');
    const view = multi.view();
    assert.deepEqual(view.providers[0].models, []);
    assert.equal(view.activeModelId, null);
    assert.equal(view.runnable, false);
    assert.match(view.guidance, /还没有添加模型 ID/);

    // 未添加的模型不能设为生效
    multi.addModel('deepseek', 'deepseek-flash');
    assert.throws(() => multi.setActiveModel('deepseek-v4-pro'), /INVALID_MODEL/);
    // 非法模型 ID 在批量写入时同样被拦（不留半份配置）
    assert.throws(() => multi.addProvider({ preset: 'deepseek', models: ['ok-model', 'bad model'] }), /INVALID_MODEL/);
    assert.deepEqual(multi.readConfig().providers[0].models, ['deepseek-flash'], '校验失败不落盘');
  });

  test('推理强度与模型成对记忆：换模型就近归一，非法档不收', () => {
    const memory = new ProviderConfigService({
      dataDir: path.join(ROOT, 'data-thinking'),
      credentialPrefix: CREDENTIAL_PREFIX,
    });
    memory.addProvider({ preset: 'deepseek', models: ['deepseek-flash', 'deepseek-v4-pro'] });

    // 从未选过 → 空（新会话退回该模型默认档）
    assert.equal(memory.readConfig().activeThinkingLevel, null);
    assert.equal(memory.getActiveThinkingLevel(), null);

    // 选中即与当前模型一起落盘
    memory.setActiveThinkingLevel('max');
    assert.equal(memory.readConfig().activeThinkingLevel, 'max');
    assert.equal(memory.view().activeThinkingLevel, 'max');

    // 换模型：档位随模型走，新模型仍支持就保留
    memory.setActiveModel('deepseek-v4-pro');
    assert.equal(memory.readConfig().activeThinkingLevel, 'max');

    // 新模型不支持的档在写入时直接拒绝（不静默改写）
    assert.throws(() => memory.setActiveThinkingLevel('low'), /INVALID_MODEL/);
    assert.equal(memory.readConfig().activeThinkingLevel, 'max');

    // 换到只有 low/high 的模型：max 就近降到 high，而不是掉回最低档
    memory.addProvider({ preset: 'moonshotai', models: ['kimi-k2.6'] });
    memory.setActiveProvider('moonshotai');
    assert.equal(memory.readConfig().activeThinkingLevel, 'high');

    // 旧文件里存了与新模型不匹配的档 → 读取时归一（不把非法组合交出去）
    const raw = JSON.parse(fs.readFileSync(memory.file, 'utf8'));
    raw.activeThinkingLevel = 'max';
    fs.writeFileSync(memory.file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    assert.equal(memory.readConfig().activeThinkingLevel, 'high');

    // 不支持推理的模型：档位记忆归 null
    memory.addProvider({ preset: 'openai', models: ['gpt-4'] });
    memory.setActiveProvider('openai');
    assert.equal(memory.readConfig().activeThinkingLevel, null);
    assert.throws(() => memory.setActiveThinkingLevel('high'), /INVALID_MODEL/);
  });

  test('全部预设都能被 Pi 运行时解析为模型（不发起真实请求）', async () => {
    const dir = path.join(ROOT, 'data-presets');
    fs.mkdirSync(dir, { recursive: true });
    const presets = new ProviderConfigService({ dataDir: dir, credentialPrefix: CREDENTIAL_PREFIX });
    const cases = [
      ['openai', 'gpt-4o-mini'],
      ['anthropic', 'claude-sonnet-4-5'],
      ['gemini', 'gemini-3-pro'],
      ['deepseek', 'deepseek-chat'],
      ['moonshotai', 'kimi-k2'],
      ['zhipu', 'glm-5'],
      ['qwen', 'qwen-max'],
      ['minimax', 'MiniMax-M3'],
      ['siliconflow', 'deepseek-v3'],
      ['volcengine', 'doubao-pro'],
      ['xai', 'grok-4'],
      ['openrouter', 'claude-sonnet-4'],
      ['ollama', 'qwen2.5-coder:7b'],
      ['openai-compatible', 'custom-model'],
    ];
    for (const [preset, model] of cases) {
      presets.addProvider({ preset, baseUrl: preset === 'openai-compatible' ? 'http://127.0.0.1:9/v1' : undefined });
      presets.addModel(preset, model);
    }
    const { PiBridge } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href);
    const bridge = new PiBridge({
      agentDir: path.join(dir, 'pi-agent'),
      sessionsDir: path.join(dir, 'sessions', 'pi'),
      providers: presets,
    });
    const runtime = await bridge.ensureRuntime();
    for (const [preset, model] of cases) {
      const resolved = runtime.getModel(preset, model);
      assert.ok(resolved, `Pi 应能解析 ${preset}/${model}`);
      assert.equal(resolved.provider, preset);
      assert.equal(resolved.id, model);
    }
  });

  test('API Key 存 Windows 凭据管理器：真实往返 + 配置文件只存状态', () => {
    const backend = new WindowsCredentialStore();
    const target = `${CREDENTIAL_PREFIX}roundtrip`;
    backend.set(target, TEST_KEY);
    assert.equal(backend.get(target), TEST_KEY);
    assert.equal(backend.delete(target), 'deleted');
    assert.equal(backend.get(target), null);
    assert.equal(backend.delete(target), 'missing');

    providers.setApiKey('openai-compatible', TEST_KEY);
    assert.deepEqual(providers.verifyCredential('openai-compatible'), {
      present: true,
      matchesStoredState: true,
    });

    const raw = fs.readFileSync(providers.file, 'utf8');
    assert.equal(raw.includes(TEST_KEY), false, '配置文件不得出现 API Key 明文');
    const config = JSON.parse(raw);
    const record = config.providers.find((p) => p.id === 'openai-compatible');
    assert.equal(record.credentialConfigured, true);
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'apiKey'), false);
    assert.equal(providers.readApiKey('openai-compatible'), TEST_KEY);

    assert.throws(() => providers.addModel('openai-compatible', 'bad model'), /INVALID_MODEL/);
    assert.throws(() => providers.addProvider({ preset: 'unknown' }), /INVALID_PROVIDER/);
    assert.throws(
      () => providers.addProvider({ preset: 'openai-compatible', baseUrl: 'ftp://x' }),
      /INVALID_PROVIDER/,
    );
  });

  test('未配置模型时 startRun 返回 NO_MODEL_CONFIGURED，createSession 仍可建会话', async () => {
    const emptyService = new ConversationService({ dataDir: DATA_EMPTY });
    const session = emptyService.createSession({ authorizedDir: SANDBOX });
    assert.equal(session.status, 'done');
    assert.equal(session.providerId, null);
    const detail = emptyService.getSession(session.sessionId);
    assert.equal(detail.modelConfigured, false);
    assert.match(detail.modelGuidance, /尚未配置模型供应商/);
    await assert.rejects(
      () => emptyService.startRun(session.sessionId, { prompt: '你好' }),
      (err) => err.code === 'NO_MODEL_CONFIGURED' && /尚未配置模型供应商/.test(err.detail),
    );
    // 未配置也不崩溃：会话仍可读取，且没有产生运行记录
    const after = emptyService.getSession(session.sessionId);
    assert.equal(after.runs.length, 0);
  });
});

// ── 运行、事件流与取消 ────────────────────────────────────────────────────

describe('T06 运行与事件流', () => {
  test('文本运行：状态机、增量与完整文本、token 用量、文件白名单', async () => {
    service = new ConversationService({ dataDir: DATA, providers, logger: testLogger });
    const session = service.createSession({ authorizedDir: SANDBOX });
    sessionId = session.sessionId;
    const events = [];
    service.subscribe(sessionId, (event) => events.push(event));

    resetFake();
    FAKE.action = { kind: 'text', text: '你好，这是本地模拟服务的回复。' };
    const result = await service.startRun(sessionId, { prompt: '介绍一下你自己' });

    assert.equal(result.status, 'done');
    assert.equal(result.error, null);
    assert.equal(result.text, '你好，这是本地模拟服务的回复。');
    assert.equal(result.usage.totalTokens, 28);
    assert.equal(result.usage.input, 21);
    assert.equal(result.usage.output, 7);

    const statuses = events.filter((e) => e.type === 'status').map((e) => e.status);
    assert.deepEqual(statuses, ['queued', 'running', 'done']);
    const deltas = events.filter((e) => e.type === 'message' && e.delta).map((e) => e.delta);
    assert.ok(deltas.length >= 2, `应有多个文本增量，实际 ${deltas.length}`);
    assert.equal(deltas.join(''), '你好，这是本地模拟服务的回复。');
    assert.ok(events.some((e) => e.type === 'usage' && e.usage.totalTokens === 28));
    assert.ok(events.some((e) => e.type === 'done' && e.status === 'done'));

    // 工具白名单：不含 bash / powershell
    const tools = (FAKE.requests.at(-1).tools ?? []).map((t) => t.function.name).sort();
    assert.deepEqual(tools, ['edit', 'find', 'grep', 'ls', 'read', 'write']);
    assert.deepEqual([...ALLOWED_TOOLS].sort(), ['edit', 'find', 'grep', 'ls', 'read', 'write']);

    const detail = service.getSession(sessionId);
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages[1].role, 'assistant');
    assert.equal(detail.messages[1].status, 'complete');
    assert.ok(detail.piMessageCount >= 2);
    assert.ok(detail.piSessionFile && fs.existsSync(service.store.piPath(detail.piSessionFile)));
    // 会话文件不含明文密钥
    assert.equal(fs.readFileSync(service.store.file(sessionId), 'utf8').includes(TEST_KEY), false);
  });

  test('取消：慢响应中断 → TASK_CANCELLED，已收到消息保留，状态 cancelled', async () => {
    const events = [];
    service.subscribe(sessionId, (event) => events.push(event));
    resetFake();
    FAKE.action = { kind: 'slow', text: '慢速开始-', delayMs: 7000 };
    const pending = service.startRun(sessionId, { prompt: '慢慢说' });
    const firstDelta = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待首个增量超时')), 20000);
      const unsub = service.subscribe(sessionId, (event) => {
        if (event.type === 'message' && event.role === 'assistant' && event.delta) {
          clearTimeout(timer);
          unsub();
          resolve(event.delta);
        }
      });
    });
    assert.match(String(firstDelta), /慢速开始/);
    // 运行中的会话状态必须是 running，不能被「重启归一」误改为失败
    assert.equal(service.listSessions().find((s) => s.sessionId === sessionId).status, 'running');
    assert.equal(service.getSession(sessionId).status, 'running');
    await service.cancelRun(sessionId);
    const result = await pending;

    assert.equal(result.status, 'cancelled');
    assert.equal(result.error.code, 'TASK_CANCELLED');
    assert.match(result.text, /慢速开始/, '中断前的 assistant 文本必须保留');

    const detail = service.getSession(sessionId);
    assert.equal(detail.status, 'cancelled');
    const assistant = detail.messages.filter((m) => m.role === 'assistant').at(-1);
    assert.ok(assistant);
    assert.match(assistant.text, /慢速开始/);
    assert.equal(assistant.status, 'aborted');
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.status);
    assert.ok(statuses.includes('cancelling'), `状态序列应包含 cancelling：${statuses.join(',')}`);
    assert.equal(statuses.at(-1), 'cancelled');
    await assert.rejects(() => service.cancelRun(sessionId), /NO_ACTIVE_RUN/);
  });

  test('供应商错误语义：401 → PROVIDER_AUTH_FAILED；超时 → PROVIDER_TIMEOUT', async () => {
    const events = [];
    service.subscribe(sessionId, (event) => events.push(event));
    resetFake();
    FAKE.action = { kind: 'status', status: 401, message: 'invalid api key' };
    const auth = await service.startRun(sessionId, { prompt: '401 测试' });
    assert.equal(auth.status, 'failed');
    assert.equal(auth.error.code, 'PROVIDER_AUTH_FAILED');
    assert.match(auth.error.detail, /API Key/);

    FAKE.action = { kind: 'status', status: 504, message: 'upstream timed out' };
    const timeout = await service.startRun(sessionId, { prompt: '超时测试' });
    assert.equal(timeout.status, 'failed');
    assert.equal(timeout.error.code, 'PROVIDER_TIMEOUT');
    const errorEvent = events.filter((e) => e.type === 'error').at(-1);
    assert.equal(errorEvent.code, 'PROVIDER_TIMEOUT');
    assert.equal(errorEvent.retryable, true);
  });
});

// ── C-25 授权目录边界 ─────────────────────────────────────────────────────

describe('C-25 授权目录边界', () => {
  test('授权目录内写文件成功落盘，并记录文件引用', async () => {
    resetFake();
    FAKE.action = { kind: 'tool', name: 'write', args: { path: 'SKILL.md', content: '# Demo Skill\n\n由本地模拟服务生成。\n' } };
    const result = await service.startRun(sessionId, { prompt: '请生成 SKILL.md' });

    assert.equal(result.status, 'done');
    assert.equal(result.error, null);
    const target = path.join(SANDBOX, 'SKILL.md');
    assert.equal(fs.existsSync(target), true, '授权目录内应成功落盘');
    assert.match(fs.readFileSync(target, 'utf8'), /Demo Skill/);

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].relPath, 'SKILL.md');
    assert.ok(result.files[0].bytes > 0);

    const detail = service.getSession(sessionId);
    assert.equal(detail.files.length, 1);
    assert.equal(detail.files[0].relPath, 'SKILL.md');
  });

  test('越界 ../outside.txt：工具层拦截、运行中止、TOOL_OUT_OF_SCOPE、目录外零文件', async () => {
    resetFake();
    const outsideBefore = walkFiles(OUTSIDE).length;
    const requestsBefore = FAKE.requests.length;
    FAKE.action = { kind: 'tool', name: 'write', args: { path: '../outside/sneaky.txt', content: 'x' } };
    const result = await service.startRun(sessionId, { prompt: '写到授权目录外' });

    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'TOOL_OUT_OF_SCOPE');
    assert.equal(walkFiles(OUTSIDE).length, outsideBefore, '目录外不得产生任何文件');
    assert.equal(fs.existsSync(path.join(OUTSIDE, 'sneaky.txt')), false);
    assert.equal(FAKE.requests.length - requestsBefore, 1, '拦截后本次运行应立即中止，不再请求模型');
    assert.match(fs.readFileSync(service.store.file(sessionId), 'utf8'), /TOOL_OUT_OF_SCOPE/);
  });

  test('越界绝对路径：拦截并中止', async () => {
    resetFake();
    const requestsBefore = FAKE.requests.length;
    const absolute = path.join(OUTSIDE, 'absolute.txt');
    FAKE.action = { kind: 'tool', name: 'write', args: { path: absolute, content: 'x' } };
    const result = await service.startRun(sessionId, { prompt: '用绝对路径写到外面' });

    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'TOOL_OUT_OF_SCOPE');
    assert.equal(fs.existsSync(absolute), false);
    assert.equal(FAKE.requests.length - requestsBefore, 1);
  });

  test('符号链接 / junction 逃逸：目录内链接指向目录外也被拦截', async () => {
    const junction = path.join(SANDBOX, 'escape-link');
    let linked = false;
    try {
      fs.symlinkSync(OUTSIDE, junction, 'junction');
      linked = true;
    } catch {
      // 本机若无法创建 junction 则跳过该子项（Windows 非管理员仍可建 junction，通常可用）
      linked = false;
    }
    assert.equal(linked, true, '本机应能创建 junction 以验证链接逃逸');

    const guard = new ToolScopeGuard(SANDBOX);
    assert.equal(guard.check('write', { path: 'escape-link/evil.txt' }).ok, false);
    assert.equal(guard.check('read', { path: 'escape-link' }).ok, false);
    assert.equal(guard.check('bash', { command: 'whoami' }).ok, false);
    assert.equal(guard.check('write', { path: 'nested/../SKILL.md' }).ok, true);

    resetFake();
    const requestsBefore = FAKE.requests.length;
    FAKE.action = { kind: 'tool', name: 'write', args: { path: 'escape-link/evil.txt', content: 'x' } };
    const result = await service.startRun(sessionId, { prompt: '通过链接写到外面' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'TOOL_OUT_OF_SCOPE');
    assert.equal(fs.existsSync(path.join(OUTSIDE, 'evil.txt')), false);
    assert.equal(FAKE.requests.length - requestsBefore, 1);
  });

  test('额外只读根：读类工具可读内置 skill，write/edit 仍只落在授权目录', () => {
    const builtinRoot = path.join(ROOT, 'builtin-skills');
    const skillFile = path.join(builtinRoot, 'skill-creator', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, '---\nname: skill-creator\ndescription: 建技能\n---\n正文');

    const guard = new ToolScopeGuard(SANDBOX, { readOnlyRoots: [builtinRoot] });
    assert.equal(guard.check('read', { path: skillFile }).ok, true);
    assert.equal(guard.check('ls', { path: builtinRoot }).ok, true);
    assert.equal(guard.check('write', { path: skillFile }).ok, false);
    assert.equal(guard.check('edit', { path: skillFile }).ok, false);
    assert.equal(guard.check('read', { path: path.join(ROOT, 'outside-any') }).ok, false);
  });
});

// ── C-26 会话重启恢复 ─────────────────────────────────────────────────────

describe('C-26 会话重启恢复', () => {
  test('完成后重启：会话列表、消息、状态、文件引用可读；resume 后继续对话带历史', async () => {
    resetFake();
    const providers2 = new ProviderConfigService({ dataDir: DATA, credentialPrefix: CREDENTIAL_PREFIX });
    const restarted = new ConversationService({ dataDir: DATA, providers: providers2 });

    const list = restarted.listSessions();
    const summary = list.find((s) => s.sessionId === sessionId);
    assert.ok(summary, '重启后应能在列表中找到会话');
    assert.equal(summary.messageCount > 0, true);
    assert.equal(summary.fileCount, 1, '文件入口应恢复');
    assert.match(summary.title, /写到授权目录外|请生成 SKILL|通过链接|用绝对路径|慢慢说|超时测试|401 测试|介绍一下你自己/);

    const detail = restarted.getSession(sessionId);
    assert.ok(detail.messages.length >= 6, `消息应完整恢复，实际 ${detail.messages.length}`);
    assert.equal(detail.files[0].relPath, 'SKILL.md');
    assert.equal(fs.existsSync(detail.files[0].path), true);
    assert.ok(detail.piMessageCount > 0, 'Pi 会话文件应可解析');

    const resumed = restarted.resume(sessionId);
    assert.equal(resumed.resumable, true);
    assert.ok(resumed.resumedAt);

    const before = FAKE.requests.length;
    const result = await restarted.startRun(sessionId, { prompt: '继续，之前生成了什么文件？' });
    assert.equal(result.status, 'done');
    assert.equal(FAKE.requests.length, before + 1);
    const sent = FAKE.requests.at(-1).messages;
    assert.ok(sent.length > 5, `恢复后的请求应携带历史，实际 ${sent.length} 条`);
    assert.ok(
      sent.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('继续，之前生成了什么文件？')),
      '新提示词应在请求中',
    );
    assert.ok(
      sent.some((m) => m.role === 'assistant'),
      '历史 assistant 消息应在请求中（模型上下文已恢复）',
    );
  });

  test('运行中重启：状态归一为 failed/PI_RUN_INTERRUPTED，消息保留且可继续', async () => {
    resetFake();
    FAKE.action = { kind: 'slow', text: '中断前的输出-', delayMs: 8000 };
    const pending = service.startRun(sessionId, { prompt: '这次会被重启打断' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待首个增量超时')), 20000);
      const unsub = service.subscribe(sessionId, (event) => {
        if (event.type === 'message' && event.role === 'assistant' && event.delta) {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });

    // 模拟「应用重启」：新服务实例指向同一 DATA_DIR，进程内没有活动运行
    const providers3 = new ProviderConfigService({ dataDir: DATA, credentialPrefix: CREDENTIAL_PREFIX });
    const restarted = new ConversationService({ dataDir: DATA, providers: providers3 });
    const detail = restarted.getSession(sessionId);
    assert.equal(detail.status, 'failed');
    assert.equal(detail.error.code, 'PI_RUN_INTERRUPTED');
    assert.equal(detail.runs.at(-1).status, 'failed');
    const partial = detail.messages.filter((m) => m.role === 'assistant').at(-1);
    assert.ok(partial, '中断前已产生的消息应保留');
    assert.match(partial.text, /中断前的输出/);
    assert.equal(detail.resumable, true);

    // 清理：让第一个实例的运行结束（用户中断），避免悬挂请求
    await service.cancelRun(sessionId);
    const cancelled = await pending;
    assert.equal(cancelled.status, 'cancelled');

    // 重启后的实例可以继续该会话
    resetFake();
    FAKE.action = { kind: 'text', text: '已从中断处继续。' };
    const resumed = restarted.resume(sessionId);
    assert.equal(resumed.resumable, true);
    const continued = await restarted.startRun(sessionId, { prompt: '继续完成刚才的工作' });
    assert.equal(continued.status, 'done');
    assert.equal(continued.text, '已从中断处继续。');
  });
});

// ── C-27 凭据脱敏 ─────────────────────────────────────────────────────────

describe('C-27 凭据脱敏', () => {
  test('模型回显 API Key 时：会话/事件/Pi 会话/日志全部无明文', async () => {
    resetFake();
    // 让假服务回显密钥（含 Authorization 头形态）
    FAKE.action = {
      kind: 'text',
      text: `你的 key 是 ${TEST_KEY}，请求头是 Authorization: Bearer ${TEST_KEY}`,
    };
    const result = await service.startRun(sessionId, { prompt: `回显检查 ${TEST_KEY}` });

    assert.equal(result.status, 'done');
    assert.equal(result.text.includes(TEST_KEY), false, '返回文本必须已脱敏');
    assert.match(result.text, /\[REDACTED\]/);

    const leaks = findLeaks([DATA, ROOT], TEST_KEY);
    assert.deepEqual(leaks, [], `以下文件出现明文密钥：${leaks.join(', ')}`);

    // 会话与事件流里的文本也已脱敏
    const rawSession = fs.readFileSync(service.store.file(sessionId), 'utf8');
    assert.equal(rawSession.includes(TEST_KEY), false);
    const events = service.getSessionEvents(sessionId);
    assert.ok(events.some((e) => e.type === 'message' && String(e.text ?? '').includes('[REDACTED]')));

    // 注入日志同样脱敏
    assert.ok(appendedLogs.length > 0);
    assert.equal(appendedLogs.some((line) => line.includes(TEST_KEY)), false);

    // 凭据本身仍可被应用读取（只进凭据管理器）
    assert.equal(providers.readApiKey('openai-compatible'), TEST_KEY);
    assert.equal(redactText(`Bearer ${TEST_KEY}`).includes(TEST_KEY), false);

    // Pi 不使用磁盘上的 auth.json / models.json（凭据由 CredentialStore 在请求时提供）
    assert.equal(fs.existsSync(path.join(DATA, 'pi-agent', 'auth.json')), false);
    assert.equal(fs.existsSync(path.join(DATA, 'pi-agent', 'models.json')), false);
  });

  test('凭据删除后配置状态回退为未配置；再次运行给出 NO_MODEL_CONFIGURED 引导', async () => {
    providers.clearApiKey('openai-compatible');
    assert.deepEqual(providers.verifyCredential('openai-compatible'), {
      present: false,
      matchesStoredState: true,
    });
    const view = providers.view();
    assert.equal(view.runnable, false);
    assert.match(view.guidance, /尚未保存 API Key/);
    await assert.rejects(
      () => service.startRun(sessionId, { prompt: '没有 key 时不应运行' }),
      (err) => err.code === 'NO_MODEL_CONFIGURED',
    );

    // 恢复测试环境，供后续回归使用
    providers.setApiKey('openai-compatible', TEST_KEY);
    assert.equal(providers.view().runnable, true);
  });
});

// ── 缺失条件说明 ─────────────────────────────────────────────────────────

test('缺失条件：真实供应商调用未验收', () => {
  registerSecret('noop-secret-value');
  // 这条断言只保证本文件的结论没有被误解：所有运行均来自本地模拟服务
  assert.equal(true, true);
  console.log(
    [
      '',
      '=== T06 验证边界 ===',
      '本次端到端使用的模型服务：本地模拟 OpenAI 兼容 HTTP 服务（脚本化 SSE 响应）。',
      '缺失条件：真实供应商（OpenAI / Anthropic / OpenAI 兼容端点 / Ollama）调用需要用户提供 API Key 与账号后验收；',
      '本文件不把模拟结果写成真实模型验收通过。凭据管理器往返使用测试键 skills-studio-test/*，已在 after 中清理。',
      '',
    ].join('\n'),
  );
});
