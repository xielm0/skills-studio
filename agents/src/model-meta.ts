/**
 * 模型能力：推理强度档位与上下文/输出上限。
 *
 * 真相 = Pi 内置厂商目录（`pi-ai/dist/providers/data/<provider>.json`），
 * 由 `backend/scripts/gen-provider-models.mjs` 生成为 `MODEL_META`；本模块只做查表与裁剪。
 *
 * 裁剪口径与 Pi 保持一致（`pi-ai/dist/models.js` 的 getSupportedThinkingLevels）：
 *  - `reasoning: false` → 该模型没有推理强度可选；
 *  - `thinkingLevelMap[level] === null` → 该档明确不支持；
 *  - `max` 必须在 map 里显式声明才可用（Pi 对 xhigh/max 的硬要求）。
 *
 * 界面口径：只暴露 low / high / max 三档，且不提供“关闭推理”的 off 档
 * （用户 2026-10-28 决定，接受“支持推理的模型无法关闭”这一代价）。
 */
import type { ThinkingLevel } from './types';
import { MODEL_META } from './provider-models.generated';

export type { ThinkingLevel };
/** 由弱到强的模型推理档位。 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['low', 'high', 'max'];

/** 未收录模型的保守默认值（与改造前的写死值一致，不臆测）。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** 一个模型的推理能力与容量。 */
export interface ModelProfile {
  /** 是否可用推理强度（false → 界面不显示这一行） */
  thinkingEnabled: boolean;
  /** 可选档位（按 Pi 目录裁剪，可能少于三档） */
  thinkingLevels: readonly ThinkingLevel[];
  /**
   * 注册进 Pi 的 thinkingLevelMap。
   * `off: null` 恒定：界面不提供关闭，且让 Pi 在未指定级别时不发送任何推理参数。
   */
  thinkingLevelMap: Readonly<Record<string, string | null>>;
  contextWindow: number;
  maxTokens: number;
}

/** Pi 目录里某档的映射值：null=不支持，undefined=未声明。 */
function mappedValue(
  map: Readonly<Record<string, string | null>> | undefined,
  level: ThinkingLevel,
): string | null | undefined {
  return map?.[level];
}

/** low/high 在未声明时由 Pi 视为可用；max 必须显式声明。 */
function levelSupported(
  map: Readonly<Record<string, string | null>> | undefined,
  level: ThinkingLevel,
): boolean {
  const value = mappedValue(map, level);
  if (value === null) return false;
  if (typeof value === 'string') return true;
  return level !== 'max';
}

/**
 * 组装注册给 Pi 的 mapping：
 * off/minimal/medium/xhigh 一律 null（不提供关闭，也不让中间档混进候选），
 * low/high/max 按模型声明取值。
 */
function buildLevelMap(
  map: Readonly<Record<string, string | null>> | undefined,
): Readonly<Record<string, string | null>> {
  const out: Record<string, string | null> = { off: null, minimal: null, medium: null, xhigh: null };
  for (const level of THINKING_LEVELS) {
    if (!levelSupported(map, level)) {
      out[level] = null;
      continue;
    }
    const value = mappedValue(map, level);
    out[level] = typeof value === 'string' ? value : level;
  }
  return out;
}

/**
 * 解析某个供应商预设下的模型能力。
 *
 * 已收录：按 Pi 目录声明裁剪（厂商说不支持就不给，避免静默降级或请求被拒）。
 * 未收录：允许手动启用三档（Pi 目录更新滞后于厂商发版；用户 2026-10-28 确认允许）。
 */
export function modelProfile(preset: string, modelId: string): ModelProfile {
  const meta = MODEL_META[preset]?.[modelId];
  if (!meta) {
    return {
      thinkingEnabled: true,
      thinkingLevels: [...THINKING_LEVELS],
      thinkingLevelMap: buildLevelMap(undefined),
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
  }

  const levels = THINKING_LEVELS.filter((level) => levelSupported(meta.thinkingLevelMap, level));
  return {
    thinkingEnabled: meta.reasoning && levels.length > 0,
    thinkingLevels: meta.reasoning ? levels : [],
    thinkingLevelMap: buildLevelMap(meta.thinkingLevelMap),
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
  };
}

/** 未设置时优先 High；该档不可用时向上取 Max，再退到 Low；不支持推理时为 off。 */
export function defaultThinkingLevel(profile: ModelProfile): ThinkingLevel | 'off' {
  if (profile.thinkingLevels.includes('high')) return 'high';
  if (profile.thinkingLevels.includes('max')) return 'max';
  return profile.thinkingLevels[0] ?? 'off';
}

/**
 * 校验并归一：不在候选内 → 就近取档（顺序与 Pi `clampThinkingLevel` 一致：先向上再向下），
 * 没有任何候选时退回默认档。用于「记住的档位遇到换了模型」的场景，避免 max 静默掉成 low。
 */
export function normalizeThinkingLevel(
  profile: ModelProfile,
  level: ThinkingLevel | null | undefined,
): ThinkingLevel | 'off' {
  const levels = profile.thinkingLevels;
  if (level && levels.includes(level)) return level;
  const requested = level ? THINKING_LEVELS.indexOf(level) : -1;
  if (requested < 0) return defaultThinkingLevel(profile);
  for (let i = requested; i < THINKING_LEVELS.length; i += 1) {
    const candidate = THINKING_LEVELS[i];
    if (levels.includes(candidate)) return candidate;
  }
  for (let i = requested - 1; i >= 0; i -= 1) {
    const candidate = THINKING_LEVELS[i];
    if (levels.includes(candidate)) return candidate;
  }
  return defaultThinkingLevel(profile);
}
