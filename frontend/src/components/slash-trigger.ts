/**
 * 输入触发器的纯核心：从光标向左找存活的 `/`，并按名称排序候选。
 *
 * 照搬 DSH 的实现（MIT）：
 * - `packages/client/ui-input-trigger/src/core/detect.ts` 的斜杠分支（词边界 + URL 排除）；
 * - `packages/client/ui-primitives/src/rank-by-name.ts` 的排序（前缀优先 → 对齐分 → 原序）。
 * 未照搬 `@` 触发与 drill（我们没有文件引用与目录下钻）。
 */

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/u;

/** 光标处存活的斜杠标记。 */
export interface SlashToken {
  /** 触发符 `/` 的下标 */
  start: number;
  /** 光标位置（token 结束处） */
  end: number;
  /** 触发符与光标之间的文字（实时过滤用） */
  query: string;
}

/**
 * 词边界规则：触发符只在草稿开头、空白之后或标点之后生效。
 * 两处 URL 例外让 `/` 在网址里保持死键：`https:/…` 的协议分隔符，以及 `//` 的第二个斜杠。
 */
function boundaryOk(draft: string, index: number): boolean {
  if (index === 0) return true;
  const prev = draft.charAt(index - 1);
  if (WHITESPACE.test(prev)) return true;
  if (WORD_CHAR.test(prev)) return false;
  if (prev === '/') return false;
  if (prev === ':' && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2))) return false;
  return true;
}

/**
 * 检测光标处的斜杠标记。
 * @param draft - 完整草稿文本
 * @param caret - 光标偏移
 * @returns 命中的标记；光标与触发符之间有空白、或斜杠不满足词边界时不触发
 */
export function detectSlashToken(draft: string, caret: number): SlashToken | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = draft.charAt(i);
    if (WHITESPACE.test(ch)) return null;
    if (ch !== '/') continue;
    if (!boundaryOk(draft, i)) continue;
    return { start: i, end: caret, query: draft.slice(i + 1, caret) };
  }
  return null;
}

/** 一条命中及其原始次序。 */
interface Ranked<T> {
  readonly item: T;
  readonly index: number;
  readonly prefix: boolean;
  readonly score: number;
}

/** 名称开头与分隔符边界额外加分。 */
function boundaryBonus(name: string, index: number): number {
  return index === 0 || name.charAt(index - 1) === '-' || name.charAt(index - 1) === '_' ? 8 : 0;
}

/**
 * O(名称长度 × 查询长度) 的最强有序子序列对齐分：边界与相邻命中加分，
 * 跳过与前置字符扣分。查询不是子序列时返回 undefined。
 */
function alignmentScore(name: string, query: string): number | undefined {
  if (query.length > name.length) return undefined;
  const noMatch = Number.NEGATIVE_INFINITY;
  let previous = Array<number>(name.length).fill(noMatch);
  for (let index = 0; index < name.length; index++) {
    if (name.charAt(index) === query.charAt(0)) previous[index] = 1 + boundaryBonus(name, index) - index;
  }
  for (let queryIndex = 1; queryIndex < query.length; queryIndex++) {
    const current = Array<number>(name.length).fill(noMatch);
    let left = noMatch;
    let leftLeft = noMatch;
    let bestGapped = noMatch;
    for (const [index, prior] of previous.entries()) {
      if (leftLeft !== noMatch) bestGapped = Math.max(bestGapped, leftLeft + index - 2);
      if (name.charAt(index) === query.charAt(queryIndex)) {
        const bonus = 1 + boundaryBonus(name, index);
        let score = noMatch;
        if (left !== noMatch) score = left + bonus + 4;
        if (bestGapped !== noMatch) score = Math.max(score, bestGapped + bonus + 1 - index);
        current[index] = score;
      }
      leftLeft = left;
      left = prior;
    }
    previous = current;
  }
  let best = noMatch;
  for (const score of previous) best = Math.max(best, score);
  return best === noMatch ? undefined : best;
}

/**
 * 按菜单查询排序候选。
 * @param items - 来源顺序的候选
 * @param rawQuery - 触发符之后输入的文字（大小写不敏感）
 * @returns 前缀命中优先，其次对齐分，其次原序；空查询原样返回
 */
export function rankByName<T extends { readonly name: string }>(
  items: readonly T[],
  rawQuery: string,
): readonly T[] {
  const query = rawQuery.toLowerCase();
  if (query === '') return items;
  const ranked: Ranked<T>[] = [];
  items.forEach((item, index) => {
    const score = alignmentScore(item.name.toLowerCase(), query);
    if (score === undefined) return;
    ranked.push({ item, index, prefix: item.name.toLowerCase().startsWith(query), score });
  });
  ranked.sort((left, right) =>
    Number(right.prefix) - Number(left.prefix) || right.score - left.score || left.index - right.index);
  return ranked.map((match) => match.item);
}
