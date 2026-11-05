// 生成「添加模型」候选清单与模型能力元数据：从 Pi 内置厂商目录抽取。
// 运行：node backend/scripts/gen-provider-models.mjs
//
// 只做候选提示与运行时注册依据，不写入用户配置（用户仍可手填任意模型 ID）；
// Pi 未收录的国内厂商（智谱 / 通义 / 硅基流动 / 火山方舟）与本地 Ollama、自定义端点留空。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const DATA = path.join(BACKEND, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data');
const OUT = path.join(BACKEND, '..', 'agents', 'src', 'provider-models.generated.ts');

/**
 * 我方 preset → Pi 数据文件名。
 * null = Pi 目录未收录，没有候选（手填）。
 */
const SOURCE = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  deepseek: 'deepseek',
  moonshotai: 'moonshotai',
  zhipu: null,
  qwen: null,
  minimax: 'minimax',
  siliconflow: null,
  volcengine: null,
  xai: 'xai',
  openrouter: 'openrouter',
  ollama: null,
  'openai-compatible': null,
};

function readModels(file) {
  return [...readEntries(file).keys()];
}

/**
 * 一个厂商目录里的对话模型（id → 原始条目）。
 * 同 id 出现在多个协议分组下时取第一条，与候选清单口径一致。
 */
function readEntries(file) {
  const full = path.join(DATA, `${file}.json`);
  const json = JSON.parse(fs.readFileSync(full, 'utf8'));
  const out = new Map();
  for (const group of Object.values(json)) {
    if (!group || typeof group !== 'object') continue;
    for (const entry of Object.values(group)) {
      if (!entry || typeof entry !== 'object') continue;
      // 只取对话模型（跳过 embedding / image 等）
      if (typeof entry.type === 'string' && entry.type !== 'chat') continue;
      const id = typeof entry.id === 'string' ? entry.id : null;
      if (!id || out.has(id)) continue;
      out.set(id, entry);
    }
  }
  return out;
}

/** 未收录模型的保守默认值（与原写死值一致，不猜）。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** 元数据一行一条：只保留运行时注册要用的字段。 */
function formatMeta(entry) {
  const contextWindow = Number.isFinite(entry.contextWindow) ? entry.contextWindow : DEFAULT_CONTEXT_WINDOW;
  const maxTokens = Number.isFinite(entry.maxTokens) ? entry.maxTokens : DEFAULT_MAX_TOKENS;
  const reasoning = entry.reasoning === true;
  const parts = [`contextWindow: ${contextWindow}`, `maxTokens: ${maxTokens}`, `reasoning: ${reasoning}`];
  const map = reasoning && entry.thinkingLevelMap && typeof entry.thinkingLevelMap === 'object' ? entry.thinkingLevelMap : null;
  if (map) {
    const pairs = Object.entries(map).map(([level, value]) =>
      value === null ? `${level}: null` : `${level}: '${String(value)}'`,
    );
    parts.push(`thinkingLevelMap: { ${pairs.join(', ')} }`);
  }
  return `{ ${parts.join(', ')} }`;
}

/** 按行宽折行，避免单个模型一行造成的超长文件 */
function formatIds(ids, indent) {
  const lines = [];
  let line = '';
  for (const id of ids) {
    const token = `'${id}', `;
    if (line.length > 0 && indent.length + line.length + token.length > 100) {
      lines.push(indent + line.trimEnd());
      line = '';
    }
    line += token;
  }
  if (line.length > 0) lines.push(indent + line.trimEnd());
  return lines;
}

const blocks = [];
const metaBlocks = [];
for (const [preset, file] of Object.entries(SOURCE)) {
  const ids = file ? readModels(file) : [];
  // 键名统一加引号：openai-compatible 这类含连字符的 preset 不是合法标识符
  const key = `'${preset}'`;
  if (ids.length === 0) {
    blocks.push(`  ${key}: [],`);
    metaBlocks.push(`  ${key}: {},`);
    continue;
  }
  blocks.push(`  ${key}: [`);
  blocks.push(...formatIds(ids, '    '));
  blocks.push('  ],');

  const entries = readEntries(file);
  const lines = ids.map((id) => `    '${id}': ${formatMeta(entries.get(id))},`);
  metaBlocks.push(`  ${key}: {\n${lines.join('\n')}\n  },`);
}

const content = `/**
 * 自动生成，请勿手改。再生成：node backend/scripts/gen-provider-models.mjs
 *
 * 来源：@earendil-works/pi-ai/dist/providers/data/<provider>.json
 * 用途：
 *  - SUGGESTED_MODELS：设置页「添加模型」的候选清单（仅提示，不写入配置；用户可手填任意模型 ID）。
 *  - MODEL_META：注册进 Pi 的模型能力（推理支持 / 级别映射 / 上下文窗口 / 输出上限）。
 * 空对象 = Pi 目录未收录该厂商，运行时走保守默认值。
 */
export interface ProviderModelMeta {
  contextWindow: number;
  maxTokens: number;
  /** Pi 目录标注该模型支持推理 */
  reasoning: boolean;
  /** Pi 的 thinkingLevelMap：null = 该级别明确不支持（缺省 = 支持） */
  thinkingLevelMap?: Readonly<Record<string, string | null>>;
}

export const SUGGESTED_MODELS: Readonly<Record<string, readonly string[]>> = {
${blocks.join('\n')}
};

export const MODEL_META: Readonly<Record<string, Readonly<Record<string, ProviderModelMeta>>>> = {
${metaBlocks.join('\n')}
};
`;

fs.writeFileSync(OUT, content, 'utf8');
const total = Object.entries(SOURCE).reduce((sum, [, file]) => sum + (file ? readModels(file).length : 0), 0);
console.log(`已生成 ${OUT}`);
console.log(`候选总数 ${total}：` + Object.entries(SOURCE).map(([p, f]) => `${p}=${f ? readModels(f).length : 0}`).join(' '));
