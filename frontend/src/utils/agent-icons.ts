/**
 * Agent 图标：**文件名即真相**，匹配规则一次写死，新增 Agent 不需要回来改这个文件。
 *
 * 素材放在 `src/assets/agent-icons/`，文件名用 Agent id 或名称的归一化形式
 * （`claude_code.svg`、`workbuddy.png`）；构建时自动收集整个目录，
 * 新增一个 Agent 只要把 `<id>.svg` 丢进目录即可生效。
 * 来源与许可见同目录 NOTICE.txt / LICENSE.skills-manager.txt。
 *
 * 用 `src/assets` 而非 `public`：Vite 无法枚举 public 目录的内容，只能手写映射表。
 */

const FILES = import.meta.glob('../assets/agent-icons/*.{svg,png}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** 文件名（去扩展名）→ 资源 URL */
const ICON_BY_KEY: Record<string, string> = {};
for (const [filePath, url] of Object.entries(FILES)) {
  const fileName = filePath.slice(filePath.lastIndexOf('/') + 1).replace(/\.(svg|png)$/i, '');
  ICON_BY_KEY[fileName] = url;
}

/**
 * 归一化：小写、空白与连字符转下划线、去掉自定义 Agent 的 `custom_` 前缀。
 * 让 `claude_code` / `custom-claude-code` / `Claude Code` 落到同一个键上。
 */
function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/^custom_/, '');
}

/**
 * 按 id → 去掉 `custom-` 前缀的 id → Agent 名称依次尝试，取第一个命中的图标。
 * 返回 null 时调用方显示泛化图标（例如竞品同样没有素材的 qclaw / easyclaw / autoclaw）。
 */
export function getAgentIconSrc(agentId: string, agentName?: string): string | null {
  const candidates = [agentId, agentId.replace(/^custom-/, '')];
  if (agentName) candidates.push(agentName);

  for (const candidate of candidates) {
    const direct = ICON_BY_KEY[candidate];
    if (direct) return direct;
    const normalized = normalizeKey(candidate);
    if (normalized && ICON_BY_KEY[normalized]) return ICON_BY_KEY[normalized];
    // 自定义 Agent 重名时 id 会带 `-2` 这类序号兜底（`custom-kimi-2`），归到同一个图标
    const deduped = normalized.replace(/_\d+$/, '');
    if (deduped && ICON_BY_KEY[deduped]) return ICON_BY_KEY[deduped];
  }
  return null;
}
