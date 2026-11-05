// T12 自动验证（tests/test_cases.md C-21/C-22/C-23；ui.md「安装 Skills」）
// 运行：cd backend && npm run build && node --no-warnings --test tests/t12.test.mjs
// 隔离纪律：每次运行在 tests/runtime 下自建独占目录；市场走本地回放服务器，不访问真实网络。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME = path.join(PROJECT_ROOT, 'tests', 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });
const ROOT = fs.mkdtempSync(path.join(RUNTIME, 't12-'));
const LIB = path.join(ROOT, 'lib');
const SKILLS = path.join(LIB, 'skills');
const DATA = path.join(ROOT, 'data');
const TMP = path.join(ROOT, 'tmp');
const AGENTS = path.join(ROOT, 'agents-mock');
const SRC = path.join(ROOT, 'src');
const ASSETS = path.join(PROJECT_ROOT, 'tests', 'assets', 'market');

const { MarketError, MarketCache, hashSkillDir } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href
);
const { AppContext } = await import(pathToFileURL(path.join(BACKEND, 'dist', 'context.js')).href);
const { selectBuiltinAgents } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'agents.js')).href
);
const { createIpcHandlers } = await import(
  pathToFileURL(path.join(BACKEND, 'dist', 'ipc', 'handlers.js')).href
);

const LEADERBOARD_HTML = fs.readFileSync(path.join(ASSETS, 'leaderboard.html'), 'utf8');
const SEARCH_PDF = fs.readFileSync(path.join(ASSETS, 'search-pdf.json'), 'utf8');
const BROKEN_HTML = fs.readFileSync(path.join(ASSETS, 'broken.html'), 'utf8');
const TREE_JSON = fs.readFileSync(path.join(ASSETS, 'github-tree.json'), 'utf8');
const SKILL_MD = fs.readFileSync(path.join(ASSETS, 'skill-md.md'), 'utf8');

const PDF_TREE = JSON.parse(TREE_JSON).tree.filter((e) => e.type === 'blob' && e.path.startsWith('skills/pdf/'));

let server;
let baseUrl = '';
/** 回放服务器行为：ok = 正常 fixture；broken = 上游改版；offline = 网络不可达 */
let mode = 'ok';
let zipBuffer = Buffer.alloc(0);
/** 仓库 zip 下载次数：用于证明「查看差异」不重复下载 */
let codeloadHits = 0;
let ctx;
let handlers;
let pdfKey = '';
let agentsSnapshot = new Map();
let localConflictHashBefore = '';

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

function silentLogger() {
  return { info: () => undefined, error: () => undefined };
}

/** 市场 HTTP 客户端：把生产域名映射到本地回放服务器（零真实网络）。 */
function createReplayClient() {
  const rewrite = (url) => {
    const u = new URL(url);
    if (u.hostname === 'www.skills.sh') return `${baseUrl}${u.pathname}${u.search}`;
    if (u.hostname === 'api.github.com') return `${baseUrl}/github${u.pathname}${u.search}`;
    if (u.hostname === 'raw.githubusercontent.com') return `${baseUrl}/raw${u.pathname}`;
    if (u.hostname === 'codeload.github.com') return `${baseUrl}/codeload${u.pathname}`;
    throw new MarketError('MARKET_FETCH_FAILED', `测试未配置该域名：${u.hostname}`, true);
  };
  const get = async (url, kind) => {
    if (mode === 'offline') {
      throw new MarketError('MARKET_FETCH_FAILED', 'connect ECONNREFUSED（本地回放：模拟源不可用）', true);
    }
    const target = rewrite(url);
    const res = await fetch(target);
    const payload =
      kind === 'text'
        ? { text: await res.text() }
        : { buffer: Buffer.from(await res.arrayBuffer()) };
    return {
      status: res.status,
      url,
      finalUrl: url,
      contentType: res.headers.get('content-type') ?? '',
      ...payload,
    };
  };
  return {
    getText: (url) => get(url, 'text'),
    getBuffer: (url) => get(url, 'buffer'),
  };
}

function makeContext({ libraryDir = LIB, dataDir = DATA } = {}) {
  return AppContext.create({
    libraryDir,
    dataDir,
    tempDir: TMP,
    homeDir: AGENTS,
    adapters: selectBuiltinAgents('codebuddy,cursor'),
    appEnv: 'development',
    version: '0.1.0',
    logger: silentLogger(),
    marketHttp: createReplayClient(),
  });
}

function makeHandlers(context, allowedPaths = [], pickers = {}) {
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
    pickDirectory: pickers.pickDirectory ?? (async () => null),
    pickFile: pickers.pickFile ?? (async () => null),
    openPath: async () => '',
    installAllowedPaths: allowedPaths,
    logger: silentLogger(),
  });
}

function snapshotAgents() {
  const map = new Map();
  if (!fs.existsSync(AGENTS)) return map;
  for (const entry of fs.readdirSync(AGENTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillsDir = path.join(AGENTS, entry.name, 'skills');
    map.set(entry.name, fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).sort() : []);
  }
  return map;
}

before(async () => {
  for (const dir of [SKILLS, DATA, TMP, AGENTS, SRC]) fs.mkdirSync(dir, { recursive: true });

  // ── 市场回放服务器（fixture 全部来自 tests/assets/market 的 T05 实抓样本）──
  zipBuffer = (() => {
    const zip = new AdmZip();
    zip.addFile(
      'repo-HEAD/skills/pdf/SKILL.md',
      Buffer.from(
        '---\nname: pdf\ndescription: Use this skill whenever the user wants to do anything with PDF files\n---\n\n# pdf\n\nfixture body\n',
        'utf8',
      ),
    );
    zip.addFile('repo-HEAD/skills/pdf/scripts/convert_pdf_to_images.py', Buffer.from('print("pdf")\n', 'utf8'));
    zip.addFile('repo-HEAD/skills/pdf/references/notes.md', Buffer.from('notes\n', 'utf8'));
    return zip.toBuffer();
  })();

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      const body = mode === 'broken' ? BROKEN_HTML : LEADERBOARD_HTML;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    }
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q') ?? '';
      if (q === 'pdf') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(SEARCH_PDF);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ query: q, skills: [] }));
      return;
    }
    if (url.pathname === '/github/repos/anthropics/skills/git/trees/HEAD') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(TREE_JSON);
      return;
    }
    if (url.pathname === '/raw/anthropics/skills/HEAD/skills/pdf/SKILL.md') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(SKILL_MD);
      return;
    }
    if (url.pathname === '/raw/anthropics/skills/HEAD/skills/pdf/reference.md') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end('# PDF reference\n');
      return;
    }
    if (url.pathname === '/raw/anthropics/skills/HEAD/skills/pdf/forms.md') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([0, 1, 2]));
      return;
    }
    if (url.pathname === '/codeload/anthropics/skills/zip/HEAD') {
      codeloadHits++;
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(zipBuffer);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // ── 本地目录夹具：多技能容器 / 单技能目录 / 含脚本 / 同名异内容冲突 ──
  writeSkill(path.join(SRC, 'multi', 'local-alpha'), 'local-alpha', '本地多选 A（含脚本）', 'alpha body');
  fs.mkdirSync(path.join(SRC, 'multi', 'local-alpha', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(SRC, 'multi', 'local-alpha', 'scripts', 'run.py'), 'print("alpha")\n', 'utf8');
  writeSkill(path.join(SRC, 'multi', 'local-beta'), 'local-beta', '本地多选 B', 'beta body');
  writeSkill(path.join(SRC, 'multi', 'local-gamma'), 'local-gamma', '本地多选 C', 'gamma body');
  writeSkill(path.join(SRC, 'single', 'solo-skill'), 'solo-skill', '容器根本身是技能', 'solo body');
  // 同名异内容：库里先放 v1，来源给 v2
  writeSkill(path.join(SRC, 'pre', 't12-conflict'), 't12-conflict', '同名冲突基线 v1', 'library v1');
  writeSkill(path.join(SRC, 'multi', 't12-conflict'), 't12-conflict', '同名冲突来源 v2', 'source v2');

  // ── Git 夹具：隔离 bare 仓库 ──
  const repoWork = path.join(ROOT, 'git-work');
  const bare = path.join(ROOT, 'fixtures', 'repo.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync('git', ['init', '-b', 'main', repoWork], { stdio: 'pipe' });
  writeSkill(path.join(repoWork, 'git-one'), 'git-one', 'Git 来源技能 A', 'git a');
  writeSkill(path.join(repoWork, 'git-two'), 'git-two', 'Git 来源技能 B', 'git b');
  git(['add', '-A'], repoWork);
  git(['-c', 'user.name=t12', '-c', 'user.email=t12@test.local', 'commit', '-m', 't12 skills'], repoWork);
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
  git(['push', bare, 'main'], repoWork);

  // ── zip 夹具：2 个技能 + 1 个坏包 ──
  const zipSrc = path.join(SRC, 'zip-src');
  writeSkill(path.join(zipSrc, 'zip-one'), 'zip-one', 'zip 来源技能 A', 'zip a');
  writeSkill(path.join(zipSrc, 'zip-two'), 'zip-two', 'zip 来源技能 B', 'zip b');
  fs.mkdirSync(path.join(SRC, 'zips'), { recursive: true });
  const zip = new AdmZip();
  zip.addLocalFolder(zipSrc);
  zip.writeZip(path.join(SRC, 'zips', 'skills.zip'));
  fs.writeFileSync(path.join(SRC, 'zips', 'broken.zip'), Buffer.from('definitely not a zip archive'));

  // ── 模拟 Agent 目录 ──
  // 扫描本机只覆盖适配器清单（codebuddy / cursor），夹具与之一致
  writeSkill(path.join(AGENTS, '.codebuddy', 'skills', 'agent-alpha'), 'agent-alpha', '来自 CodeBuddy 的技能', 'alpha');
  writeSkill(path.join(AGENTS, '.cursor', 'skills', 'agent-beta'), 'agent-beta', '来自 Cursor 的技能', 'beta');

  ctx = makeContext();
  const pre = await ctx.sources.importSkills([
    {
      path: path.join(SRC, 'pre', 't12-conflict'),
      source: { type: 'local-dir', origin: path.join(SRC, 'pre'), sourceRelPath: 't12-conflict' },
    },
  ]);
  assert.equal(pre.results[0].status, 'imported');
  localConflictHashBefore = hashSkillDir(path.join(SKILLS, 't12-conflict'));

  handlers = makeHandlers(ctx);
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  agentsSnapshot = snapshotAgents();
});

after(async () => {
  try {
    ctx?.dispose();
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (!ROOT.startsWith(RUNTIME + path.sep)) throw new Error('测试目录不在 tests/runtime 下');
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});

// ───────────────────────── 市场（本地回放） ─────────────────────────

test('市场：本地回放榜单/搜索解析 → 市场条目与 key；后端文件信息读取', async () => {
  const board = await handlers['install:marketLeaderboard']({ force: true });
  assert.equal(board.items.length, 10, '回放真实榜单片段解析出 10 条');
  assert.equal(board.stale, false);
  assert.equal(board.items[0].name, 'find-skills');
  assert.equal(board.items[0].source, 'vercel-labs/skills');
  assert.match(board.items[0].url, /^https:\/\/www\.skills\.sh\//);
  assert.equal(new Set(board.items.map((i) => i.key)).size, board.items.length, 'key 唯一');

  const search = await handlers['install:marketSearch']({ query: 'pdf' });
  assert.equal(search.query, 'pdf');
  assert.equal(search.items.length, 5);
  const pdf = search.items.find((item) => item.id === 'anthropics/skills/pdf');
  assert.ok(pdf, '搜索结果含 anthropics/skills/pdf');
  pdfKey = pdf.key;

  const preview = await handlers['install:marketPreview']({ key: pdfKey });
  assert.equal(preview.itemId, 'anthropics/skills/pdf');
  assert.equal(preview.fileCount, PDF_TREE.length);
  assert.equal(
    preview.totalBytes,
    PDF_TREE.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
  );
  assert.equal(preview.scriptManifest.hasExecutableScripts, true);
  assert.equal(preview.scriptManifest.executableScripts.length, 8, 'scripts/ 可执行脚本完整列出');
  assert.ok(preview.files.some((file) => file.path === 'SKILL.md'));

  const skillFile = await handlers['install:marketReadFile']({ source: 'anthropics/skills', skillId: 'pdf', path: 'SKILL.md' });
  assert.equal(skillFile.content, SKILL_MD);
  const otherFile = await handlers['install:marketReadFile']({ source: 'anthropics/skills', skillId: 'pdf', path: 'reference.md' });
  assert.equal(otherFile.content, '# PDF reference\n');
  const binaryFile = await handlers['install:marketReadFile']({ source: 'anthropics/skills', skillId: 'pdf', path: 'forms.md' });
  assert.equal(binaryFile.content, null);
  assert.match(binaryFile.reason, /二进制/);
  await assert.rejects(
    handlers['install:marketReadFile']({ source: 'anthropics/skills', skillId: 'pdf', path: '../secret' }),
    (err) => err.code === 'MARKET_ITEM_NOT_FOUND',
  );

  // 非法条目：未知 key / 缺参数 → BAD_REQUEST（不是空结果）
  await assert.rejects(
    async () => handlers['install:marketPreview']({ key: 'market:999:0' }),
    (err) => err.code === 'BAD_REQUEST',
  );
  await assert.rejects(async () => handlers['install:marketPreview']({}), (err) => err.code === 'BAD_REQUEST');
});

test('市场：导入含脚本条目 → 计数/来源 market；重复导入 skipped；不部署', async () => {
  const before = ctx.library.listSkills().length;
  const first = await handlers['install:import']({ channel: 'market', items: [{ key: pdfKey }] });
  assert.deepEqual(first.summary, { imported: 1, skipped: 0, failed: 0 });
  assert.equal(first.items[0].status, 'imported');
  assert.match(first.items[0].skillId, /^sk_[0-9a-z]{17}$/);

  const summary = ctx.library.listSkills().find((s) => s.dirName === 'pdf');
  assert.ok(summary, '市场技能已入库');
  assert.equal(summary.source.type, 'market');
  assert.equal(summary.source.origin, 'https://www.skills.sh/anthropics/skills/pdf');
  assert.ok(fs.existsSync(path.join(SKILLS, 'pdf', 'scripts', 'convert_pdf_to_images.py')));
  assert.equal(ctx.library.listSkills().length, before + 1);

  const again = await handlers['install:import']({ channel: 'market', items: [{ key: pdfKey }] });
  assert.equal(again.items[0].status, 'skipped');
  assert.equal(again.summary.skipped, 1);
  assert.equal(ctx.library.listSkills().length, before + 1, '跳过不新增');

  // 未部署：模拟 Agent 目录零变化
  assert.deepEqual(snapshotAgents(), agentsSnapshot, '市场导入不自动部署');
});

test('市场：TTL 过期且源不可用 → stale 标记 + 可能过期提示（不是空列表）', async () => {
  const cache = new MarketCache(path.join(DATA, 'market-cache'));
  const file = cache.fileFor('leaderboard-all-time');
  assert.ok(fs.existsSync(file), '榜单缓存已写入 DATA_DIR');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.fetchedAt = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');

  mode = 'offline';
  try {
    const result = await handlers['install:marketLeaderboard']({ force: true });
    assert.equal(result.stale, true);
    assert.equal(result.fromCache, true);
    assert.equal(result.items.length, 10, '回退缓存内容可展示');
    assert.match(result.warning ?? '', /可能过期/);
    assert.equal(result.fetchedAt, '2020-01-01T00:00:00.000Z');
  } finally {
    mode = 'ok';
  }
});

test('市场：页面结构变化 → MARKET_PARSE_FAILED（可重试，不呈现 0 个 Skill）', async () => {
  const brokenCtx = makeContext({
    libraryDir: path.join(ROOT, 'lib-broken'),
    dataDir: path.join(ROOT, 'data-broken'),
  });
  const brokenHandlers = makeHandlers(brokenCtx);
  mode = 'broken';
  try {
    await assert.rejects(
      async () => brokenHandlers['install:marketLeaderboard']({ force: true }),
      (err) =>
        err instanceof MarketError &&
        err.code === 'MARKET_PARSE_FAILED' &&
        err.retryable === true &&
        err.detail.length > 0,
    );
  } finally {
    mode = 'ok';
    brokenCtx.dispose();
  }
});

// ───────────────────────── Git ─────────────────────────

test('四来源只读详情：当前 key 才能查看文件，文本可读、越界与过期 key 被拒绝', async () => {
  const git = await handlers['install:gitParse']({ url: path.join(ROOT, 'fixtures', 'repo.git') });
  const local = await makeHandlers(ctx, [path.join(SRC, 'multi')])['install:localScan']({ dirPath: path.join(SRC, 'multi') });
  const archive = await makeHandlers(ctx, [path.join(SRC, 'zips', 'skills.zip')])['install:zipRead']({ zipPath: path.join(SRC, 'zips', 'skills.zip') });
  const scan = await handlers['install:agentScan']();
  const entries = [
    ['git', git.items.find((item) => item.name === 'git-one')],
    ['local', local.items.find((item) => item.name === 'local-alpha')],
    ['archive', archive.items.find((item) => item.name === 'zip-one')],
    ['scan', scan.items.find((item) => item.name === 'agent-alpha')],
  ];
  for (const [channel, item] of entries) {
    assert.ok(item?.valid, `${channel} 发现有效 Skill`);
    const preview = handlers['install:sourcePreview']({ channel, key: item.key });
    assert.ok(preview.files.some((file) => file.path === 'SKILL.md'));
    const content = handlers['install:sourceReadFile']({ channel, key: item.key, path: 'SKILL.md' });
    assert.match(content.content, /name:/);
    await assert.rejects(async () => handlers['install:sourceReadFile']({ channel, key: item.key, path: '../secret' }), (error) => error.code === 'INVALID_PATH');
  }
  const script = handlers['install:sourceReadFile']({ channel: 'local', key: local.items.find((item) => item.name === 'local-alpha').key, path: 'scripts/run.py' });
  assert.equal(script.content, 'print("alpha")\n');
  await assert.rejects(async () => handlers['install:sourcePreview']({ channel: 'local', key: 'local:0:0' }), (error) => error.code === 'BAD_REQUEST');
});

test('Git：本地仓库解析出条目与脚本清单；坏地址明确报错；导入来源为 git', async () => {
  const repo = path.join(ROOT, 'fixtures', 'repo.git');
  const parsed = await handlers['install:gitParse']({ url: repo });
  assert.equal(parsed.items.length, 2);
  assert.deepEqual(parsed.items.map((i) => i.name).sort(), ['git-one', 'git-two']);
  for (const item of parsed.items) {
    assert.equal(item.valid, true);
    assert.equal(item.scriptManifest.hasExecutableScripts, false);
    assert.ok(item.relPath.length > 0);
  }

  const picked = parsed.items[0];
  const imported = await handlers['install:import']({ channel: 'git', items: [{ key: picked.key, name: 'git-renamed' }] });
  assert.deepEqual(imported.summary, { imported: 1, skipped: 0, failed: 0 });
  const dirName = 'git-renamed';
  const summary = ctx.library.listSkills().find((s) => s.dirName === dirName);
  assert.equal(summary.name, dirName);
  assert.equal(summary.source.type, 'git');
  assert.equal(summary.source.origin, repo);
  assert.match(fs.readFileSync(path.join(SKILLS, dirName, 'SKILL.md'), 'utf8'), /^---\nname: git-renamed\n/m);
  assert.match(fs.readFileSync(path.join(ROOT, 'git-work', picked.name, 'SKILL.md'), 'utf8'), new RegExp(`name: ${picked.name}`));

  // 失败路径放在导入之后：每次解析都会换代，旧 key 会按「扫描结果已更新」处理
  await assert.rejects(
    async () => handlers['install:gitParse']({ url: path.join(ROOT, 'no-such-repo.git') }),
    (err) => err.code === 'GIT_CLONE_FAILED' && String(err.detail).length > 0,
  );
  await assert.rejects(
    async () => handlers['install:gitParse']({ url: 'ext::sh -c dir' }),
    (err) => err.code === 'GIT_INVALID_URL',
  );
});

// ───────────────────────── 本地目录 ─────────────────────────

test('本地目录：容器根/多技能列表；未通过选择器的路径一律拒绝（BAD_REQUEST）', async () => {
  const multi = path.join(SRC, 'multi');
  await assert.rejects(
    async () => handlers['install:localScan']({ dirPath: SRC }),
    (err) => err.code === 'BAD_REQUEST',
    // 用容器根断言「未经选择器的路径被拒」：multi 会被其他用例的 makeHandlers 写进
    // 共享 ctx.install 白名单（handler 构造参数直写 context），此处必须用从未授权的路径。
    '渲染层直接传任意路径必须被拒绝',
  );

  // 走系统选择器：pickDirectory 返回后写入白名单，再扫描
  const pickHandlers = createIpcHandlers({
    context: ctx,
    appInfo: () => ({
      productName: 'Skills 工作台',
      version: '0.1.0',
      appEnv: 'development',
      libraryDir: ctx.libraryDir,
      dataDir: ctx.dataDir,
      logDir: path.join(ROOT, 'logs'),
      electron: '39.8.12',
      chrome: '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    }),
    version: '0.1.0',
    mode: 'development',
    pickDirectory: async () => multi,
    pickFile: async () => null,
    openPath: async () => '',
    logger: silentLogger(),
  });
  const picked = await pickHandlers['app:pickDirectory']({ title: '选择要扫描的目录' });
  assert.equal(picked.path, multi);

  const scanned = await pickHandlers['install:localScan']({ dirPath: multi });
  assert.equal(scanned.items.length, 4, '多技能容器：3 个技能 + 1 个同名冲突技能');
  const alpha = scanned.items.find((item) => item.name === 'local-alpha');
  assert.equal(alpha.scriptManifest.hasExecutableScripts, true);
  assert.deepEqual(alpha.scriptManifest.executableScripts, ['scripts/run.py']);
  assert.ok(alpha.sizeBytes > 0);
  assert.equal(scanned.items.find((item) => item.name === 'local-beta').valid, true);

  // 容器根本身是技能 → 单项
  const singleRoot = path.join(SRC, 'single', 'solo-skill');
  const allowedSingle = makeHandlers(ctx, [singleRoot]);
  const solo = await allowedSingle['install:localScan']({ dirPath: singleRoot });
  assert.equal(solo.items.length, 1);
  assert.equal(solo.items[0].name, 'solo-skill');
  assert.equal(solo.items[0].relPath, '.');

  // 不存在的路径也拒绝（即使传了路径）
  await assert.rejects(
    async () => handlers['install:localScan']({ dirPath: path.join(ROOT, 'ghost-dir') }),
    (err) => err.code === 'BAD_REQUEST',
  );
  await assert.rejects(async () => handlers['install:localScan']({}), (err) => err.code === 'BAD_REQUEST');
});

test('本地目录：多选子集导入计数正确；同名同内容跳过、同名异内容失败且原技能不变', async () => {
  const multi = path.join(SRC, 'multi');
  const h = makeHandlers(ctx, [multi]);
  const scanned = await h['install:localScan']({ dirPath: multi });
  const keys = new Map(scanned.items.map((item) => [item.name, item.key]));

  const subset = await h['install:import']({
    channel: 'local',
    items: [{ key: keys.get('local-alpha') }, { key: keys.get('local-beta') }],
  });
  assert.deepEqual(subset.summary, { imported: 2, skipped: 0, failed: 0 });
  assert.equal(ctx.library.listSkills().length, 5, '只导入选中的 2 个（此前已入库 3 个）');
  const alpha = ctx.library.listSkills().find((s) => s.dirName === 'local-alpha');
  assert.equal(alpha.source.type, 'local-dir');
  assert.equal(alpha.source.origin, multi);
  assert.ok(fs.existsSync(path.join(SKILLS, 'local-alpha', 'scripts', 'run.py')));

  const same = await h['install:import']({
    channel: 'local',
    items: [{ key: keys.get('local-alpha') }],
  });
  assert.equal(same.items[0].status, 'skipped');
  assert.equal(same.items[0].reason, '同名同内容，已入库，跳过');

  const conflict = await h['install:import']({
    channel: 'local',
    items: [{ key: keys.get('t12-conflict') }],
  });
  assert.equal(conflict.items[0].status, 'failed');
  assert.equal(conflict.items[0].reason, '中心库已存在同名但内容不同的 Skill');
  assert.equal(hashSkillDir(path.join(SKILLS, 't12-conflict')), localConflictHashBefore, '库内原技能零改动');

  // 过期 key（上一次扫描的 key）不能借机导入任意路径
  const stale = await h['install:import']({ channel: 'local', items: [{ key: 'local:0:0' }] });
  assert.equal(stale.items[0].status, 'failed');
  assert.equal(stale.items[0].code, 'STALE_SCAN');
  assert.deepEqual(snapshotAgents(), agentsSnapshot, '本地导入不自动部署');
});

test('本地目录冲突：发现即标记、查看差异、跳过和复制覆盖', async () => {
  const multi = path.join(SRC, 'multi');
  const source = path.join(multi, 't12-conflict');
  const target = path.join(SKILLS, 't12-conflict');
  fs.writeFileSync(path.join(source, 'local-only.md'), 'local file');
  fs.writeFileSync(path.join(target, 'central-only.md'), 'central file');
  const originalId = ctx.library.listSkills().find((item) => item.dirName === 't12-conflict').skillId;
  const originalHash = hashSkillDir(target);
  const h = makeHandlers(ctx, [multi]);
  const rows = (await h['install:localScan']({ dirPath: multi })).items;
  assert.equal(rows.find((item) => item.name === 'local-alpha').status, 'in-library');
  assert.equal(rows.find((item) => item.name === 'local-gamma').status, 'not-in-library');
  const row = rows.find((item) => item.name === 't12-conflict');
  assert.equal(row.status, 'conflict');
  const diff = h['install:scanDiff']({ channel: 'local', key: row.key });
  assert.deepEqual(diff.files.map((file) => [file.relPath, file.status]), [
    ['SKILL.md', 'modified'], ['central-only.md', 'removed'], ['local-only.md', 'added'],
  ]);
  const file = h['install:scanDiff']({ channel: 'local', key: row.key, relPath: 'SKILL.md', sourceHash: diff.sourceHash, targetHash: diff.targetHash });
  assert.match(file.source.content, /source v2/);
  assert.match(file.target.content, /library v1/);
  const skipped = await h['install:resolveScanConflict']({ channel: 'local', key: row.key, choice: 'skip', sourceHash: diff.sourceHash, targetHash: diff.targetHash });
  assert.equal(skipped.status, 'skipped');
  assert.equal(hashSkillDir(target), originalHash);
  const overwritten = await h['install:resolveScanConflict']({ channel: 'local', key: row.key, choice: 'overwrite', sourceHash: diff.sourceHash, targetHash: diff.targetHash });
  assert.equal(overwritten.skillId, originalId);
  assert.equal(hashSkillDir(target), hashSkillDir(source));
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(target, 'central-only.md')), false);
});

// ───────────────────────── 压缩包 ─────────────────────────

test('压缩包：合法 zip 解出条目并导入（来源 zip）；坏包明确报错', async () => {
  const zipPath = path.join(SRC, 'zips', 'skills.zip');
  await assert.rejects(
    async () => handlers['install:zipRead']({ zipPath: path.join(SRC, 'zips', 'never-picked.zip') }),
    (err) => err.code === 'BAD_REQUEST',
    // 白名单校验先于文件存在性（requireAllowedFile），未授权路径稳定抛 BAD_REQUEST；
    // 不能用 skills.zip——它已被「四来源只读详情」用例写进共享白名单。
    '未经选择器的压缩包路径被拒绝',
  );

  const h = makeHandlers(ctx, [zipPath, path.join(SRC, 'zips', 'broken.zip')], {
    pickFile: async () => zipPath,
  });
  const picked = await h['app:pickFile']({ title: '选择技能压缩包' });
  assert.equal(picked.path, zipPath);

  const read = await h['install:zipRead']({ zipPath });
  assert.equal(read.items.length, 2);
  assert.deepEqual(read.items.map((i) => i.name).sort(), ['zip-one', 'zip-two']);

  const imported = await h['install:import']({ channel: 'archive', items: [{ key: read.items[0].key }] });
  assert.equal(imported.summary.imported, 1);
  const summary = ctx.library.listSkills().find((s) => s.dirName === read.items[0].name);
  assert.equal(summary.source.type, 'zip');
  assert.equal(summary.source.origin, zipPath);

  await assert.rejects(
    async () => h['install:zipRead']({ zipPath: path.join(SRC, 'zips', 'broken.zip') }),
    (err) => err.code === 'ARCHIVE_UNSUPPORTED',
  );
});

test('压缩包冲突：发现即标记、查看差异、跳过和复制覆盖', async () => {
  const zipPath = path.join(SRC, 'zips', 'conflict.zip');
  const zip = new AdmZip();
  zip.addFile('zip-one/SKILL.md', Buffer.from('---\nname: zip-one\ndescription: 更新版\n---\n\n# zip-one\n\nzip updated\n'));
  zip.addFile('zip-one/added.md', Buffer.from('new file'));
  zip.writeZip(zipPath);
  const h = makeHandlers(ctx, [zipPath]);
  const rows = (await h['install:zipRead']({ zipPath })).items;
  const row = rows.find((item) => item.name === 'zip-one');
  assert.equal(row.status, 'conflict');
  const target = path.join(SKILLS, 'zip-one');
  const originalHash = hashSkillDir(target);
  const originalId = ctx.library.listSkills().find((item) => item.dirName === 'zip-one').skillId;
  const diff = h['install:scanDiff']({ channel: 'archive', key: row.key });
  assert.deepEqual(diff.files.map((file) => [file.relPath, file.status]), [
    ['SKILL.md', 'modified'], ['added.md', 'added'],
  ]);
  const skipped = await h['install:resolveScanConflict']({ channel: 'archive', key: row.key, choice: 'skip', sourceHash: diff.sourceHash, targetHash: diff.targetHash });
  assert.equal(skipped.status, 'skipped');
  assert.equal(hashSkillDir(target), originalHash);
  const overwritten = await h['install:resolveScanConflict']({ channel: 'archive', key: row.key, choice: 'overwrite', sourceHash: diff.sourceHash, targetHash: diff.targetHash });
  assert.equal(overwritten.skillId, originalId);
  assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /zip updated/);
  assert.equal(fs.existsSync(path.join(target, 'added.md')), true);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
});

// ───────────────────────── 扫描本机 ─────────────────────────

test('扫描本机：条目带来源 Agent；入库记录具体 Agent 与根目录且零新增链接', async () => {
  const scanned = await handlers['install:agentScan']();
  assert.equal(scanned.items.length, 2);
  const alpha = scanned.items.find((item) => item.name === 'agent-alpha');
  assert.equal(alpha.agentId, 'codebuddy');
  assert.equal(alpha.agentLabel, 'CodeBuddy');
  assert.equal(alpha.inLibrary, false);
  assert.equal(alpha.status, 'not-in-library', '库里没有同名 → 未入库');
  assert.equal(scanned.items.find((item) => item.name === 'agent-beta').agentLabel, 'Cursor');

  const imported = await handlers['install:import']({
    channel: 'scan',
    items: scanned.items.map((item) => ({ key: item.key })),
  });
  assert.deepEqual(imported.summary, { imported: 2, skipped: 0, failed: 0 });

  const alphaSummary = ctx.library.listSkills().find((s) => s.dirName === 'agent-alpha');
  assert.equal(alphaSummary.source.type, 'agent:codebuddy');
  assert.equal(alphaSummary.source.origin, ctx.agents.get('codebuddy').skillsDir, '来源记可定位的 Agent 技能根目录');

  assert.deepEqual(snapshotAgents(), agentsSnapshot, '扫描本机导入不新增任何链接');

  // 再次扫描：已入库项被标记（仅提示）
  const again = await handlers['install:agentScan']();
  assert.equal(again.items.find((item) => item.name === 'agent-alpha').inLibrary, true);
  assert.equal(
    again.items.find((item) => item.name === 'agent-alpha').status,
    'in-library',
    '同名同内容 → 已入库',
  );
});

test('扫描本机冲突：本地 → 中心库差异；跳过不写入，覆盖复制并保留 Skill ID', async () => {
  const local = path.join(AGENTS, '.codebuddy', 'skills', 'agent-alpha');
  const central = path.join(SKILLS, 'agent-alpha');
  if (!ctx.library.listSkills().some((item) => item.dirName === 'agent-alpha')) {
    const imported = await ctx.sources.importSkills([{ path: local, source: { type: 'machine-scan', origin: 'CodeBuddy' } }]);
    assert.equal(imported.results[0].status, 'imported');
  }
  const originalId = ctx.library.listSkills().find((item) => item.dirName === 'agent-alpha').skillId;
  writeSkill(local, 'agent-alpha', '本地更新', 'local updated');
  fs.writeFileSync(path.join(local, 'local-only.md'), 'new file');
  fs.writeFileSync(path.join(central, 'central-only.md'), 'old file');
  const originalHash = hashSkillDir(central);
  const scanned = await handlers['install:agentScan']();
  const row = scanned.items.find((item) => item.name === 'agent-alpha');
  assert.equal(row.status, 'conflict');
  const diff = handlers['install:scanDiff']({ key: row.key });
  assert.deepEqual(diff.files.map((file) => [file.relPath, file.status]), [
    ['SKILL.md', 'modified'], ['central-only.md', 'removed'], ['local-only.md', 'added'],
  ]);
  const file = handlers['install:scanDiff']({ key: row.key, relPath: 'SKILL.md', sourceHash: diff.sourceHash, targetHash: diff.targetHash });
  assert.match(file.source.content, /local updated/);
  assert.match(file.target.content, /agent-alpha/);
  const skipped = await handlers['install:resolveScanConflict']({ key: row.key, choice: 'skip', sourceHash: diff.sourceHash, targetHash: diff.targetHash });
  assert.equal(skipped.status, 'skipped');
  assert.equal(hashSkillDir(central), originalHash);
  writeSkill(local, 'agent-alpha', '本地再次修改', 'local newer');
  await assert.rejects(
    () => handlers['install:resolveScanConflict']({ key: row.key, choice: 'overwrite', sourceHash: diff.sourceHash, targetHash: diff.targetHash }),
    (error) => error.code === 'BAD_REQUEST',
  );
  assert.equal(hashSkillDir(central), originalHash, '查看后来源变化时不得覆盖中心库');
  writeSkill(local, 'agent-alpha', '本地更新', 'local updated');
  // Windows 的目录 watcher 会阻止重命名中心库根目录；覆盖须在原目录内复制。
  const watcher = fs.watch(central, { recursive: process.platform === 'win32' }, () => undefined);
  let overwritten;
  try {
    overwritten = await handlers['install:resolveScanConflict']({ key: row.key, choice: 'overwrite', sourceHash: diff.sourceHash, targetHash: diff.targetHash });
  } finally {
    watcher.close();
  }
  assert.equal(overwritten.status, 'overwritten');
  assert.equal(overwritten.skillId, originalId);
  assert.equal(hashSkillDir(central), hashSkillDir(local));
  assert.equal(fs.lstatSync(local).isSymbolicLink(), false, '来源保持实体目录，不建链接');
  assert.equal(fs.existsSync(path.join(central, 'central-only.md')), false);
  assert.equal(fs.existsSync(path.join(central, 'local-only.md')), true);
});

test('扫描本机批量导入：同名不同内容按文件最新 mtime 优先，不受勾选顺序影响', async () => {
  const older = path.join(AGENTS, '.codebuddy', 'skills', 'scan-dupe');
  const newer = path.join(AGENTS, '.cursor', 'skills', 'scan-dupe');
  writeSkill(older, 'scan-dupe', '旧版本', 'older body');
  writeSkill(newer, 'scan-dupe', '新版本', 'newer body');
  fs.utimesSync(path.join(older, 'SKILL.md'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  fs.utimesSync(path.join(newer, 'SKILL.md'), new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'));
  const scanned = await handlers['install:agentScan']();
  const rows = scanned.items.filter((item) => item.name === 'scan-dupe');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].agentId, 'cursor', '列表同名项较新的在前');
  const imported = await handlers['install:import']({ channel: 'scan', items: [{ key: rows[1].key }, { key: rows[0].key }] });
  assert.equal(imported.items[0].key, rows[0].key, '导入顺序不受用户勾选顺序影响');
  assert.equal(imported.items[0].status, 'imported');
  assert.equal(imported.items[1].status, 'failed');
  assert.equal(imported.items[1].code, 'NAME_CONFLICT');
  assert.match(fs.readFileSync(path.join(SKILLS, 'scan-dupe', 'SKILL.md'), 'utf8'), /newer body/);
  assert.ok(Math.abs(fs.statSync(path.join(SKILLS, 'scan-dupe', 'SKILL.md')).mtimeMs - fs.statSync(path.join(newer, 'SKILL.md')).mtimeMs) < 1000,
    '扫描本机复制保留源文件 mtime，差异弹窗可比较两侧内容时间');
  const after = await handlers['install:agentScan']();
  const olderRow = after.items.find((item) => item.name === 'scan-dupe' && item.agentId === 'codebuddy');
  assert.equal(olderRow.status, 'conflict');
  assert.equal(after.items.find((item) => item.name === 'scan-dupe' && item.agentId === 'cursor').status, 'in-library');
  const diff = handlers['install:scanDiff']({ key: olderRow.key });
  assert.equal(diff.sourceMtime, '2020-01-01T00:00:00.000Z');
  assert.ok(diff.targetMtime);
});

test('扫描本机同名候选 mtime 相同时保留勾选顺序', async () => {
  const first = path.join(AGENTS, '.codebuddy', 'skills', 'scan-tie');
  const second = path.join(AGENTS, '.cursor', 'skills', 'scan-tie');
  writeSkill(first, 'scan-tie', '版本 A', 'body A');
  writeSkill(second, 'scan-tie', '版本 B', 'body B');
  const sameTime = new Date('2022-02-02T02:02:02Z');
  for (const dir of [first, second]) fs.utimesSync(path.join(dir, 'SKILL.md'), sameTime, sameTime);
  const rows = (await handlers['install:agentScan']()).items.filter((item) => item.name === 'scan-tie');
  const selected = [rows[1], rows[0]];
  const imported = await handlers['install:import']({ channel: 'scan', items: selected.map((row) => ({ key: row.key })) });
  assert.equal(imported.items[0].key, selected[0].key);
  assert.equal(imported.items[0].status, 'imported');
  assert.equal(imported.items[1].status, 'failed');
  assert.equal(hashSkillDir(path.join(SKILLS, 'scan-tie')), hashSkillDir(selected[0].agentId === 'codebuddy' ? first : second));
});

// ───────────────────────── 契约与边界 ─────────────────────────

test('导入参数边界：未知通道 / 空 key / 未扫描的 market key → 明确错误或逐项失败', async () => {
  await assert.rejects(
    async () => handlers['install:import']({ channel: 'ftp', items: [{ key: 'x' }] }),
    (err) => err.code === 'BAD_REQUEST',
  );
  await assert.rejects(
    async () => handlers['install:import']({ channel: 'local', items: [{ key: '  ' }] }),
    (err) => err.code === 'BAD_REQUEST',
  );
  await assert.rejects(
    async () => handlers['install:import']({ channel: 'local', items: 'not-array' }),
    (err) => err.code === 'BAD_REQUEST',
  );

  const unknownMarket = await handlers['install:import']({
    channel: 'market',
    items: [{ key: 'market:404:0' }],
  });
  assert.equal(unknownMarket.items[0].status, 'failed');
  assert.equal(unknownMarket.items[0].code, 'STALE_SCAN');
});

// ───────────────────── 市场冲突：查看差异与覆盖（复用安装时已下载的内容） ─────────────────────

test('市场冲突：安装失败保留已下载内容 → 查看差异不二次下载 → 跳过/覆盖', async () => {
  mode = 'ok';
  const search = await handlers['install:marketSearch']({ query: 'pdf', force: true });
  const pdf = search.items.find((item) => item.id === 'anthropics/skills/pdf');
  assert.ok(pdf, '搜索结果含 anthropics/skills/pdf');

  // 前置：库内先有同名技能（已入库时走跳过），再用应用内保存改成不同内容 → 下一次安装报同名冲突
  await handlers['install:import']({ channel: 'market', items: [{ key: pdf.key }] });
  const skillMd = path.join(SKILLS, 'pdf', 'SKILL.md');
  const librarySkill = ctx.library.listSkills().find((item) => item.dirName === 'pdf');
  assert.ok(librarySkill, '同名技能在库内');
  await handlers['library:writeFile']({
    skillId: librarySkill.skillId,
    relPath: 'SKILL.md',
    content: '---\nname: pdf\ndescription: 库内改写\n---\n\n# pdf\n\nlibrary body\n',
  });

  const hitsBefore = codeloadHits;
  const failed = await handlers['install:import']({ channel: 'market', items: [{ key: pdf.key }] });
  assert.equal(failed.items[0].status, 'failed');
  assert.equal(failed.items[0].code, 'NAME_CONFLICT');
  assert.equal(codeloadHits, hitsBefore + 1, '安装时下载一次仓库');

  const list = await handlers['install:marketDiff']({ key: pdf.key });
  assert.equal(codeloadHits, hitsBefore + 1, '查看差异复用安装时的下载，不重新下载');
  assert.deepEqual(list.files.map((file) => `${file.relPath}:${file.status}`), ['SKILL.md:modified']);
  assert.ok(list.sourceHash.length > 0 && list.targetHash.length > 0);

  const detail = await handlers['install:marketDiff']({ key: pdf.key, relPath: 'SKILL.md' });
  assert.match(detail.source.content, /fixture body/);
  assert.match(detail.target.content, /library body/);

  const stale = await handlers['install:marketDiff']({ key: pdf.key, sourceHash: 'stale', targetHash: list.targetHash });
  assert.equal(stale.stale, true, '哈希不符按过期处理');

  const skipped = await handlers['install:marketResolveConflict']({
    key: pdf.key, choice: 'skip', sourceHash: list.sourceHash, targetHash: list.targetHash,
  });
  assert.equal(skipped.status, 'skipped');
  assert.match(fs.readFileSync(skillMd, 'utf8'), /library body/, '跳过不改中心库');

  const overwritten = await handlers['install:marketResolveConflict']({
    key: pdf.key, choice: 'overwrite', sourceHash: list.sourceHash, targetHash: list.targetHash,
  });
  assert.equal(overwritten.status, 'overwritten');
  assert.match(fs.readFileSync(skillMd, 'utf8'), /fixture body/, '覆盖写入市场版本');
  const summary = ctx.library.listSkills().find((item) => item.dirName === 'pdf');
  assert.equal(summary.source.type, 'market');
  assert.equal(summary.source.origin, 'https://www.skills.sh/anthropics/skills/pdf');

  // 覆盖后保留内容释放：再查差异要求重新安装
  await assert.rejects(
    async () => handlers['install:marketDiff']({ key: pdf.key }),
    (err) => err.code === 'BAD_REQUEST',
  );
});

// ───────────────── 同名同内容但行尾符不同（CRLF / LF）→ 不再算冲突 ─────────────────

test('行尾符不同不算同名异内容：市场与本地目录都判为已入库', async () => {
  mode = 'ok';

  // ── 市场（GitHub LF）对库内 CRLF ──
  const search = await handlers['install:marketSearch']({ query: 'pdf', force: true });
  const pdf = search.items.find((item) => item.id === 'anthropics/skills/pdf');
  assert.ok(pdf, '搜索结果含 anthropics/skills/pdf');
  // 前置：库内先有市场版本（已入库时走跳过）
  await handlers['install:import']({ channel: 'market', items: [{ key: pdf.key }] });
  const librarySkill = ctx.library.listSkills().find((item) => item.dirName === 'pdf');
  const marketText = fs.readFileSync(path.join(SKILLS, 'pdf', 'SKILL.md'), 'utf8');
  assert.equal(marketText.includes('\r'), false, '前置：库内是市场版本（LF）');
  await handlers['library:writeFile']({
    skillId: librarySkill.skillId,
    relPath: 'SKILL.md',
    content: marketText.replace(/\n/g, '\r\n'),
  });
  assert.equal(
    fs.readFileSync(path.join(SKILLS, 'pdf', 'SKILL.md'), 'utf8').includes('\r\n'),
    true,
    '库内已改成 CRLF，内容文字与市场版本一致',
  );
  const imported = await handlers['install:import']({ channel: 'market', items: [{ key: pdf.key }] });
  assert.equal(imported.items[0].status, 'skipped', '只差行尾符 → 已入库跳过，不报同名冲突');
  assert.equal(imported.items[0].code, undefined);

  // ── 本地目录（LF）对库内 CRLF：列表四态与导入判定口径一致 ──
  const body = '---\nname: eol-skill\ndescription: 行尾差异样本\n---\n\n# eol-skill\n\nbody\n';
  const crlfSrc = path.join(SRC, 'eol', 'crlf-src');
  const lfSrc = path.join(SRC, 'eol', 'lf-src');
  fs.mkdirSync(path.join(crlfSrc, 'eol-skill'), { recursive: true });
  fs.mkdirSync(path.join(lfSrc, 'eol-skill'), { recursive: true });
  fs.writeFileSync(path.join(crlfSrc, 'eol-skill', 'SKILL.md'), body.replace(/\n/g, '\r\n'), 'utf8');
  fs.writeFileSync(path.join(lfSrc, 'eol-skill', 'SKILL.md'), body, 'utf8');

  const crlfScan = await makeHandlers(ctx, [crlfSrc])['install:localScan']({ dirPath: crlfSrc });
  assert.equal(crlfScan.items[0].status, 'not-in-library');
  const firstImport = await handlers['install:import']({ channel: 'local', items: [{ key: crlfScan.items[0].key }] });
  assert.equal(firstImport.items[0].status, 'imported');
  assert.equal(
    fs.readFileSync(path.join(SKILLS, 'eol-skill', 'SKILL.md'), 'utf8').includes('\r\n'),
    true,
    '库内保留 CRLF 那份',
  );

  const lfScan = await makeHandlers(ctx, [lfSrc])['install:localScan']({ dirPath: lfSrc });
  assert.equal(lfScan.items[0].status, 'in-library', '只差行尾符 → 显示已入库，不是有冲突');
  const secondImport = await handlers['install:import']({ channel: 'local', items: [{ key: lfScan.items[0].key }] });
  assert.equal(secondImport.items[0].status, 'skipped');
});
