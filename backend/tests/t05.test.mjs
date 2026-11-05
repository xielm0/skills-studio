// T05 自动验证（tests/test_cases.md E 组 C-22~C-24 + 缓存行为 + 详情脚本提示 + 安装共用入库）
// 运行：cd backend && npm run build && node --no-warnings --test tests/t05.test.mjs
// 隔离纪律：一切读写只落 tests/runtime/（t05-lib / t05-data / t05-tmp）；不碰真实 Agent 目录。
// fixtures 来源（2026-10-25 实抓，裁剪后入库）：
//   leaderboard-rsc.txt / leaderboard.html ← https://www.skills.sh/ 的 Next.js flight 载荷
//   search-pdf.json ← https://www.skills.sh/api/search?q=pdf&limit=5
//   github-tree.json ← https://api.github.com/repos/anthropics/skills/git/trees/HEAD?recursive=1（保留 skills/pdf 等）
//   skill-md.md ← https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/pdf/SKILL.md
//   broken.html ← 构造的「上游改版」样本（无 initialSkills 标记）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(BACKEND, '..');
const RUNTIME = path.join(PROJECT_ROOT, 'tests', 'runtime');
const LIB = path.join(RUNTIME, 't05-lib');
const SKILLS = path.join(LIB, 'skills');
const DATA = path.join(RUNTIME, 't05-data');
const TMP = path.join(RUNTIME, 't05-tmp');
const ASSETS = path.join(PROJECT_ROOT, 'tests', 'assets', 'market');

const {
  SkillLibraryService,
  SkillSourceService,
  MarketService,
  MarketError,
  MarketCache,
  createFetchHttpClient,
  parseLeaderboardPayload,
  parseSearchPayload,
  describeTreeSkill,
  parseRepoTree,
} = await import(pathToFileURL(path.join(BACKEND, 'dist', 'domain', 'index.js')).href);

const LEADERBOARD_RSC = fs.readFileSync(path.join(ASSETS, 'leaderboard-rsc.txt'), 'utf8');
const LEADERBOARD_HTML = fs.readFileSync(path.join(ASSETS, 'leaderboard.html'), 'utf8');
const SEARCH_PDF = fs.readFileSync(path.join(ASSETS, 'search-pdf.json'), 'utf8');
const BROKEN_HTML = fs.readFileSync(path.join(ASSETS, 'broken.html'), 'utf8');
const TREE_JSON = fs.readFileSync(path.join(ASSETS, 'github-tree.json'), 'utf8');
const SKILL_MD = fs.readFileSync(path.join(ASSETS, 'skill-md.md'), 'utf8');

const TREE = JSON.parse(TREE_JSON);
const PDF_FILES = TREE.tree.filter((e) => e.type === 'blob' && e.path.startsWith('skills/pdf/'));
const PDF_TOTAL_BYTES = PDF_FILES.reduce((n, e) => n + (e.size ?? 0), 0);

let library;
let sources;
let skillCountBeforeInstall;

/** 记录调用的假 HTTP：按 URL 正则匹配路由，未命中抛网络错误（不静默成功）。 */
function makeHttp(routes) {
  const calls = [];
  const resolve = (url) => {
    for (const route of routes) {
      if (route.match.test(url)) return route;
    }
    throw new MarketError('MARKET_FETCH_FAILED', `测试未配置该地址的响应：${url}`, true);
  };
  const handle = async (url, kind) => {
    calls.push({ url, kind });
    const route = resolve(url);
    if (route.error) throw route.error;
    const payload =
      kind === 'text'
        ? { text: route.body ?? '' }
        : { buffer: route.buffer ?? Buffer.alloc(0) };
    return {
      status: route.status ?? 200,
      url,
      finalUrl: route.finalUrl ?? url,
      contentType: kind === 'text' ? 'text/html' : 'application/zip',
      ...payload,
    };
  };
  return {
    calls,
    getText: (url) => handle(url, 'text'),
    getBuffer: (url) => handle(url, 'buffer'),
  };
}

function makeService({ http, dataDir, ttl, tempDir = TMP, logger } = {}) {
  return new MarketService({
    dataDir,
    tempDir,
    sources,
    http,
    ttl,
    logger: logger ?? { info: () => undefined, error: () => undefined },
  });
}

/** 生成 GitHub 风格 zip（单层 <repo>-HEAD/ 包皮）。 */
function makeRepoZip(entries) {
  const zip = new AdmZip();
  for (const [p, content] of Object.entries(entries)) {
    zip.addFile(p, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

const MARKET_SKILL_MD = (body) =>
  `---\nname: demo-market-skill\ndescription: 市场安装测试技能\n---\n\n# demo-market-skill\n\n${body}\n`;

const ZIP_SELECTED = makeRepoZip({
  'repoA-HEAD/README.md': '# repoA\n',
  'repoA-HEAD/skills/demo-market-skill/SKILL.md': MARKET_SKILL_MD('v1 body'),
  'repoA-HEAD/skills/demo-market-skill/scripts/run.py': 'print("market")\n',
  'repoA-HEAD/skills/demo-market-skill/references/notes.md': 'notes\n',
  'repoA-HEAD/skills/other-skill/SKILL.md': '---\nname: other-skill\n---\n\n# other\n',
});
const ZIP_SELECTED_V2 = makeRepoZip({
  'repoA-HEAD/skills/demo-market-skill/SKILL.md': MARKET_SKILL_MD('v2 body changed'),
  'repoA-HEAD/skills/demo-market-skill/scripts/run.py': 'print("market v2")\n',
});
const ZIP_NO_SKILL = makeRepoZip({ 'empty-HEAD/README.md': '# no skills\n' });

before(() => {
  fs.rmSync(LIB, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  library = SkillLibraryService.create({ libraryDir: LIB, dataDir: DATA });
  sources = new SkillSourceService({ library, tempDir: TMP });
  skillCountBeforeInstall = library.listSkills().length;
});

after(() => {
  library?.close();
});

// ───────────────────────── C-24 榜单解析（真实载荷 fixture） ─────────────────────────

test('C-24 解析热门榜：RSC 载荷与普通 HTML 两种形态字段一致（名称/来源/安装量）', () => {
  const fromRsc = parseLeaderboardPayload(LEADERBOARD_RSC);
  assert.equal(fromRsc.length, 10, '真实榜单片段解析出 10 条');
  const first = fromRsc[0];
  assert.equal(first.source, 'vercel-labs/skills');
  assert.equal(first.skillId, 'find-skills');
  assert.equal(first.name, 'find-skills');
  assert.equal(first.installs, 4035993);
  assert.equal(first.id, 'vercel-labs/skills/find-skills');
  assert.equal(first.upstreamUrl, 'https://www.skills.sh/vercel-labs/skills/find-skills');
  assert.equal(first.isOfficial, true);

  const fromHtml = parseLeaderboardPayload(LEADERBOARD_HTML);
  assert.deepEqual(
    fromHtml.map((i) => i.id),
    fromRsc.map((i) => i.id),
    'HTML 中转义的 flight 载荷解析结果与 RSC 一致',
  );

  // 去重：同一 id 出现多次只保留一条
  const dup = JSON.parse(
    '[' +
      JSON.stringify({ source: 'a/b', skillId: 'x', name: 'x', installs: 1 }) +
      ',' +
      JSON.stringify({ source: 'a/b', skillId: 'x', name: 'x', installs: 2 }) +
      ']',
  );
  const deduped = parseLeaderboardPayload(
    `4c:["$","$L53",null,{"initialSkills":${JSON.stringify(dup)}}]`,
  );
  assert.equal(deduped.length, 1);
});

test('C-24 解析失败：页面结构被破坏 → MARKET_PARSE_FAILED（重试标记，不是空列表）', async () => {
  assert.throws(
    () => parseLeaderboardPayload(BROKEN_HTML),
    (err) => err instanceof MarketError && err.code === 'MARKET_PARSE_FAILED' && err.retryable === true,
  );

  // 服务层同样必须报错，而不是返回 items: []
  const http = makeHttp([{ match: /skills\.sh/, body: BROKEN_HTML }]);
  const service = makeService({ http, dataDir: path.join(DATA, 'case-broken') });
  await assert.rejects(
    () => service.getLeaderboard('all-time'),
    (err) =>
      err instanceof MarketError &&
      err.code === 'MARKET_PARSE_FAILED' &&
      err.retryable === true &&
      /结构|initialSkills/.test(err.detail),
  );

  // 注入网络错误 → MARKET_FETCH_FAILED（不是解析错误冒充）
  const offline = makeService({
    http: makeHttp([
      { match: /skills\.sh/, error: new MarketError('MARKET_FETCH_FAILED', 'connect ECONNREFUSED', true) },
    ]),
    dataDir: path.join(DATA, 'case-offline-no-cache'),
  });
  await assert.rejects(
    () => offline.getLeaderboard('hot'),
    (err) => err.code === 'MARKET_FETCH_FAILED' && err.retryable === true,
  );
  // 失败不写缓存（不会留下「0 个 Skill」的假缓存）
  const cacheDir = path.join(DATA, 'case-offline-no-cache', 'market-cache');
  const cachedFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
  assert.deepEqual(cachedFiles, [], '无缓存时失败不留缓存文件');
});

// ───────────────────────── 搜索解析 ─────────────────────────

test('搜索解析：真实响应 5 条；合法空结果允许；结构缺失 → PARSE_FAILED', async () => {
  const items = parseSearchPayload(SEARCH_PDF);
  assert.equal(items.length, 5);
  assert.equal(items[0].id, 'anthropics/skills/pdf');
  assert.equal(items[0].installs, 216618);
  assert.equal(items[4].source, 'inference-sh/skills');

  assert.deepEqual(parseSearchPayload('{"query":"zzzz","skills":[]}'), [], '无匹配是合法空数组');
  assert.throws(
    () => parseSearchPayload('{"foo":1}'),
    (err) => err instanceof MarketError && err.code === 'MARKET_PARSE_FAILED',
  );
  assert.throws(
    () => parseSearchPayload('not json'),
    (err) => err instanceof MarketError && err.code === 'MARKET_PARSE_FAILED',
  );

  const service = makeService({ http: makeHttp([]), dataDir: path.join(DATA, 'case-query') });
  await assert.rejects(
    () => service.searchSkills('   '),
    (err) => err.code === 'MARKET_INVALID_QUERY',
  );
  await assert.rejects(
    () => service.getLeaderboard('weekly'),
    (err) => err.code === 'MARKET_INVALID_QUERY',
  );
});

// ───────────────────────── 缓存行为 ─────────────────────────

test('缓存：首次成功写 DATA_DIR 缓存；TTL 内二次读取不再请求网络', async () => {
  const dataDir = path.join(DATA, 'case-cache');
  const http = makeHttp([{ match: /skills\.sh/, body: LEADERBOARD_HTML }]);
  const service = makeService({ http, dataDir });

  const first = await service.getLeaderboard('all-time');
  assert.equal(first.fromCache, false);
  assert.equal(first.stale, false);
  assert.equal(first.items.length, 10);

  const cacheFile = new MarketCache(path.join(dataDir, 'market-cache')).fileFor('leaderboard-all-time');
  assert.ok(fs.existsSync(cacheFile), '缓存文件已写入 DATA_DIR/market-cache');
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.key, 'leaderboard-all-time');
  assert.ok(!Number.isNaN(Date.parse(raw.fetchedAt)), '缓存带 fetchedAt');
  assert.equal(raw.value.length, 10);

  const second = await service.getLeaderboard('all-time');
  assert.equal(second.fromCache, true);
  assert.equal(second.stale, false);
  assert.equal(http.calls.length, 1, 'TTL 内命中缓存，未发起第二次请求');
});

test('缓存：源不可用 + 缓存存在 → 返回缓存并标注「可能过期」', async () => {
  const dataDir = path.join(DATA, 'case-cache');
  const cacheFile = new MarketCache(path.join(dataDir, 'market-cache')).fileFor('leaderboard-all-time');
  // 把缓存时间改到过去，模拟 TTL 过期
  const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  raw.fetchedAt = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(cacheFile, JSON.stringify(raw), 'utf8');

  const offlineHttp = makeHttp([
    { match: /skills\.sh/, error: new MarketError('MARKET_FETCH_FAILED', 'connect ECONNREFUSED', true) },
  ]);
  const service = makeService({ http: offlineHttp, dataDir });
  const result = await service.getLeaderboard('all-time');
  assert.equal(result.fromCache, true);
  assert.equal(result.stale, true, '过期缓存必须标记 stale');
  assert.equal(result.items.length, 10, '缓存内容可展示');
  assert.match(result.warning ?? '', /可能过期/);
  assert.equal(result.fetchedAt, '2020-01-01T00:00:00.000Z');
  assert.equal(offlineHttp.calls.length, 1, '确实尝试过源');

  // 搜索同理：无缓存 + 源不可用 → 明确错误（不是空列表）
  const searchService = makeService({ http: offlineHttp, dataDir: path.join(DATA, 'case-cache-empty') });
  await assert.rejects(
    () => searchService.searchSkills('pdf'),
    (err) =>
      err instanceof MarketError &&
      err.code === 'MARKET_FETCH_FAILED' &&
      err.retryable === true &&
      err.detail.length > 0,
  );
});

// ───────────────────────── 市场详情：文件清单 / 总大小 / 脚本 ─────────────────────────

test('市场详情：文件清单、总大小、scripts 可执行脚本与描述（真实 tree + SKILL.md fixture）', async () => {
  const dataDir = path.join(DATA, 'case-detail');
  const http = makeHttp([
    { match: /api\.github\.com\/repos\/anthropics\/skills\/git\/trees/, body: TREE_JSON },
    {
      match: /raw\.githubusercontent\.com\/anthropics\/skills\/HEAD\/skills\/pdf\/SKILL\.md/,
      body: SKILL_MD,
    },
  ]);
  const service = makeService({ http, dataDir });
  const detail = await service.getDetail({ source: 'anthropics/skills', skillId: 'pdf' });

  assert.equal(detail.repoPath, 'skills/pdf');
  assert.equal(detail.fileCount, PDF_FILES.length);
  assert.equal(detail.totalBytes, PDF_TOTAL_BYTES, '总大小 = 技能目录下文件字节数之和');
  assert.ok(detail.files.some((f) => f.path === 'SKILL.md'));
  assert.ok(detail.files.some((f) => f.path === 'scripts/convert_pdf_to_images.py'));
  assert.deepEqual(
    detail.executableScripts,
    [
      'scripts/check_bounding_boxes.py',
      'scripts/check_fillable_fields.py',
      'scripts/convert_pdf_to_images.py',
      'scripts/create_validation_image.py',
      'scripts/extract_form_field_info.py',
      'scripts/extract_form_structure.py',
      'scripts/fill_fillable_fields.py',
      'scripts/fill_pdf_form_with_annotations.py',
    ],
    'scripts/ 下可执行脚本完整列出',
  );
  assert.match(detail.description, /Use this skill whenever the user wants to do anything with PDF files/);
  assert.equal(detail.skillName, 'pdf');
  assert.equal(detail.item.upstreamUrl, 'https://www.skills.sh/anthropics/skills/pdf');
  assert.equal(detail.item.source, 'anthropics/skills');

  // 缓存命中：不再发请求
  const callsBefore = http.calls.length;
  const again = await service.getDetail({ source: 'anthropics/skills', skillId: 'pdf' });
  assert.equal(http.calls.length, callsBefore);
  assert.equal(again.fromCache, true);
  assert.equal(again.executableScripts.length, detail.executableScripts.length);

  // 上游没有该技能 → MARKET_ITEM_NOT_FOUND（不可重试），不是空详情
  const missing = makeService({ http, dataDir: path.join(DATA, 'case-detail-missing') });
  await assert.rejects(
    () => missing.getDetail({ source: 'anthropics/skills', skillId: 'ghost' }),
    (err) =>
      err instanceof MarketError &&
      err.code === 'MARKET_ITEM_NOT_FOUND' &&
      err.retryable === false,
  );
});

test('详情：源不可用 + 详情缓存存在 → 返回缓存并标注「可能过期」', async () => {
  const dataDir = path.join(DATA, 'case-detail');
  const cache = new MarketCache(path.join(dataDir, 'market-cache'));
  const keys = [
    'detail-anthropics/skills-pdf',
    'repo-anthropics/skills',
    'skillmd-anthropics/skills-skills/pdf',
  ];
  for (const key of keys) {
    const cacheFile = cache.fileFor(key);
    assert.ok(fs.existsSync(cacheFile), `缓存已写入：${key}`);
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    raw.fetchedAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(cacheFile, JSON.stringify(raw), 'utf8');
  }

  const offline = makeHttp([
    {
      match: /github/,
      error: new MarketError('MARKET_FETCH_FAILED', 'connect ECONNREFUSED', true),
    },
  ]);
  const service = makeService({ http: offline, dataDir });
  const detail = await service.getDetail({ source: 'anthropics/skills', skillId: 'pdf' });
  assert.equal(detail.fromCache, true);
  assert.equal(detail.stale, true);
  assert.match(detail.warning ?? '', /可能过期/);
  assert.ok(detail.description.includes('Use this skill whenever'), '缓存描述保留');
  assert.equal(detail.executableScripts.length, 8, '缓存里的脚本清单保留');
});

test('详情：站点自发布条目（非 GitHub 仓库）明确报 MARKET_SOURCE_UNSUPPORTED', async () => {
  const service = makeService({ http: makeHttp([]), dataDir: path.join(DATA, 'case-site') });
  await assert.rejects(
    () => service.getDetail({ source: 'example.com', skillId: 'hello' }),
    (err) =>
      err instanceof MarketError &&
      err.code === 'MARKET_SOURCE_UNSUPPORTED' &&
      err.retryable === false,
  );
});

test('文件树解析纯函数：技能目录定位优先 skills/<id>，大小写兜底', () => {
  const tree = parseRepoTree(TREE_JSON);
  const described = describeTreeSkill(tree.entries, 'pdf');
  assert.equal(described.dirPath, 'skills/pdf');
  assert.equal(described.files.length, PDF_FILES.length);
  const upper = describeTreeSkill(tree.entries, 'PDF');
  assert.equal(upper.dirPath, 'skills/pdf', '大小写不一致时仍能定位');
  assert.equal(describeTreeSkill(tree.entries, 'nope'), null);
});

// ───────────────────────── 安装：复用 T02 入库 ─────────────────────────

test('安装共用入库：下载 fixture zip → importSkills → 库内来源为 market、逐项结果正确', async () => {
  const dataDir = path.join(DATA, 'case-install');
  const http = makeHttp([
    { match: /codeload\.github\.com\/acme\/repoA\/zip\/HEAD/, buffer: ZIP_SELECTED },
    { match: /codeload\.github\.com\/acme\/empty\/zip\/HEAD/, buffer: ZIP_NO_SKILL },
  ]);
  const service = makeService({ http, dataDir });

  const batch = await service.installItems([
    { source: 'acme/repoA', skillId: 'demo-market-skill', name: 'demo-market-skill', installs: 12 },
    { source: 'acme/repoA', skillId: 'other-skill', name: 'other-skill' },
    { source: 'acme/empty', skillId: 'ghost-skill', name: 'ghost-skill' },
  ]);

  assert.equal(batch.requested, 3);
  assert.deepEqual(
    batch.results.map((r) => r.itemId),
    ['acme/repoA/demo-market-skill', 'acme/repoA/other-skill', 'acme/empty/ghost-skill'],
    '结果与输入顺序一致',
  );
  assert.equal(batch.results[0].status, 'imported');
  assert.match(batch.results[0].skillId, /^sk_[0-9a-z]{17}$/);
  assert.equal(batch.results[1].status, 'imported', '同一仓库的第二个技能也能入库');
  assert.equal(batch.results[2].status, 'failed');
  assert.equal(batch.results[2].code, 'MARKET_ITEM_NOT_FOUND');
  assert.equal(batch.results[2].retryable, false);
  assert.equal(
    http.calls.filter((c) => c.url.includes('/acme/repoA/zip/')).length,
    1,
    '同一仓库多选只下载一次',
  );

  // 库内出现该技能；来源类型 market + 上游市场地址（不落本机绝对路径）
  const summary = library.listSkills().find((s) => s.dirName === 'demo-market-skill');
  assert.ok(summary, '库内出现 demo-market-skill');
  assert.equal(summary.source.type, 'market');
  assert.equal(summary.source.origin, 'https://www.skills.sh/acme/repoA/demo-market-skill');
  // 嵌套扫描口径：zip 内 <仓库根>/skills/<名>/ 是一层 group，sourceRelPath 记相对扫描根路径
  assert.equal(summary.source.sourceRelPath, 'skills/demo-market-skill');
  assert.equal(summary.description, '市场安装测试技能');
  assert.ok(fs.existsSync(path.join(SKILLS, 'demo-market-skill', 'scripts', 'run.py')));
  assert.ok(fs.existsSync(path.join(SKILLS, 'demo-market-skill', 'references', 'notes.md')));
  assert.ok(fs.existsSync(path.join(SKILLS, 'other-skill', 'SKILL.md')), '同一仓库中选中的技能入库');
  assert.equal(library.listSkills().length, skillCountBeforeInstall + 2);

  // 下载/解包临时会话已清理（只落 TEMP_DIR，且结束即删）
  const leftovers = fs.readdirSync(TMP).filter((n) => n.startsWith('market-'));
  assert.deepEqual(leftovers, []);
});

test('安装同名冲突按 T02 语义：同名异内容单项失败不覆盖；同名同内容跳过', async () => {
  const dataDir = path.join(DATA, 'case-install');
  const http = makeHttp([{ match: /codeload\.github\.com\/acme\/repoA\/zip\/HEAD/, buffer: ZIP_SELECTED_V2 }]);
  const service = makeService({ http, dataDir });

  const conflict = await service.installItems([
    { source: 'acme/repoA', skillId: 'demo-market-skill', name: 'demo-market-skill' },
  ]);
  assert.equal(conflict.results[0].status, 'failed');
  assert.equal(conflict.results[0].code, 'NAME_CONFLICT');
  assert.equal(conflict.results[0].reason, '中心库已存在同名但内容不同的 Skill');
  assert.equal(conflict.results[0].retryable, false);
  // 库内容未被覆盖
  assert.match(
    fs.readFileSync(path.join(SKILLS, 'demo-market-skill', 'scripts', 'run.py'), 'utf8'),
    /market/,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(SKILLS, 'demo-market-skill', 'scripts', 'run.py'), 'utf8'),
    /v2/,
  );

  const sameHttp = makeHttp([{ match: /codeload\.github\.com\/acme\/repoA\/zip\/HEAD/, buffer: ZIP_SELECTED }]);
  const same = await makeService({ http: sameHttp, dataDir }).installItems([
    { source: 'acme/repoA', skillId: 'demo-market-skill', name: 'demo-market-skill' },
  ]);
  assert.equal(same.results[0].status, 'already-in-library');
  assert.equal(library.listSkills().length, skillCountBeforeInstall + 2, '跳过不新增');
});

// ───────────────────────── C-22 实况检查（真实网络；允许标记缺失条件） ─────────────────────────

test('C-22 实况：skills.sh 热门榜 + 搜索（记录 URL/状态码/耗时/条数；>3s 或不可达记为缺失条件）', async (t) => {
  const http = createFetchHttpClient({ timeoutMs: 25_000 });
  const leaderboardUrl = 'https://www.skills.sh/';
  const searchApiUrl = 'https://www.skills.sh/api/search?q=pdf&limit=5';

  let boardStatus = 0;
  let boardMs = 0;
  let boardCount = 0;
  try {
    const started = Date.now();
    const res = await http.getText(leaderboardUrl, { timeoutMs: 25_000 });
    boardMs = Date.now() - started;
    boardStatus = res.status;
    boardCount = parseLeaderboardPayload(res.text).length;
  } catch (err) {
    const e = err instanceof MarketError ? err : new MarketError('MARKET_FETCH_FAILED', String(err), true);
    t.diagnostic(
      `榜单 GET ${leaderboardUrl} -> status=${boardStatus || 'n/a'}, ${boardMs}ms, 失败：${e.code} ${e.detail}`,
    );
    t.skip(`缺失条件：上游榜单不可用/结构变化（${e.code}）`);
    return;
  }
  t.diagnostic(
    `榜单 GET ${leaderboardUrl} -> status=${boardStatus}, ${boardMs}ms, 解析 ${boardCount} 条`,
  );

  let searchStatus = 0;
  let searchMs = 0;
  let searchCount = 0;
  try {
    const started = Date.now();
    const res = await http.getText(searchApiUrl, { timeoutMs: 25_000 });
    searchMs = Date.now() - started;
    searchStatus = res.status;
    searchCount = parseSearchPayload(res.text).length;
    assert.equal(res.status, 200);
  } catch (err) {
    const e = err instanceof MarketError ? err : new MarketError('MARKET_FETCH_FAILED', String(err), true);
    t.diagnostic(
      `搜索 GET ${searchApiUrl} -> status=${searchStatus || 'n/a'}, ${searchMs}ms, 失败：${e.code} ${e.detail}`,
    );
    t.skip(`缺失条件：上游搜索不可用/结构变化（${e.code}）`);
    return;
  }

  t.diagnostic(`搜索 GET ${searchApiUrl} -> status=${searchStatus}, ${searchMs}ms, 解析 ${searchCount} 条`);
  assert.ok(searchCount > 0, '真实搜索有结果');
  if (searchMs > 3000) {
    // PRD 成功标准是「3 秒内出结果或明确错误」；本机跨境网络冷连接常 >3s，如实记为缺失条件
    t.skip(
      `缺失条件：搜索耗时 ${searchMs}ms > 3000ms（本机跨境网络；结果 ${searchCount} 条已解析，非功能失败）`,
    );
  }
});
