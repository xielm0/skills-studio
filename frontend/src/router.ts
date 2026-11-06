/**
 * 渲染层路由：hash 路由（Electron 以 file:// 加载，无服务端回退需求）。
 * 只做页面切换，不承担业务状态；业务数据自 T10 起经 IPC 获取。
 *
 * 支持 `#/library/<skillId>` 技能详情（T11：真实文件树 + 标签 + 编辑保存）
 * 与 `#/agent/<agentId>/<dirName>` Agent 源技能详情（T13）。
 */
import { useEffect, useState } from 'react';

export const ROUTES = ['home', 'library', 'install', 'backup', 'agents', 'chat', 'settings', 'first-run'] as const;

/** agent = Agent 源技能详情（不是左侧导航项，Tab 仍属于 Agents 页）。 */
export type RouteId = (typeof ROUTES)[number] | 'agent';

export const ROUTE_HASH: Record<RouteId, string> = {
  home: '#/home',
  library: '#/library',
  install: '#/install',
  backup: '#/backup',
  agents: '#/agents',
  chat: '#/chat',
  settings: '#/settings',
  'first-run': '#/first-run',
  agent: '#/agents',
};

export interface Route {
  id: RouteId;
  /** 技能详情：`#/library/<skillId>` 的 skillId，其余为 null */
  skillId: string | null;
  /** Agent 源详情：`#/agent/<agentId>/<dirName>` */
  agentId: string | null;
  agentDir: string | null;
  /** 市场只读详情：`#/install/market/<source>/<skillId>`。 */
  market?: { source: string; skillId: string };
  /** Git / 本地目录 / 压缩包 / 扫描本机的发现条目只读预览。 */
  installPreview?: { channel: 'git' | 'local' | 'archive' | 'scan'; key: string };
  /** 形如 `#/chat?file=SKILL.md` */
  raw: string;
  query: URLSearchParams;
}

export function parseRoute(hash: string): Route {
  const raw = hash || ROUTE_HASH.home;
  const body = raw.replace(/^#\/?/, '');
  const queryIndex = body.indexOf('?');
  const pathPart = queryIndex >= 0 ? body.slice(0, queryIndex) : body;
  const query = new URLSearchParams(queryIndex >= 0 ? body.slice(queryIndex + 1) : '');

  if (pathPart.startsWith('install/market/')) {
    const parts = pathPart.slice('install/market/'.length).split('/');
    if (parts.length === 2) {
      const source = safeDecode(parts[0]);
      const skillId = safeDecode(parts[1]);
      if (source && skillId) {
        return { id: 'install', skillId: null, agentId: null, agentDir: null, market: { source, skillId }, raw, query };
      }
    }
    return { id: 'install', skillId: null, agentId: null, agentDir: null, raw, query };
  }

  if (pathPart.startsWith('install/preview/')) {
    const parts = pathPart.slice('install/preview/'.length).split('/');
    if (parts.length === 2) {
      const channel = safeDecode(parts[0]);
      const key = safeDecode(parts[1]);
      if ((channel === 'git' || channel === 'local' || channel === 'archive' || channel === 'scan') && key) {
        return { id: 'install', skillId: null, agentId: null, agentDir: null, installPreview: { channel, key }, raw, query };
      }
    }
    return { id: 'install', skillId: null, agentId: null, agentDir: null, raw, query };
  }

  // #/agent/<agentId>/<dirName> → Agents 页内的 Agent 源技能详情
  if (pathPart.startsWith('agent/')) {
    const rest = pathPart.slice('agent/'.length);
    const slash = rest.indexOf('/');
    if (slash > 0 && slash < rest.length - 1) {
      const agentId = safeDecode(rest.slice(0, slash));
      const agentDir = safeDecode(rest.slice(slash + 1));
      if (agentId.length > 0 && agentDir.length > 0) {
        return { id: 'agent', skillId: null, agentId, agentDir, raw, query };
      }
    }
    return { id: 'agents', skillId: null, agentId: null, agentDir: null, raw, query };
  }

  // #/library/<skillId> → 中心库页 + 技能详情
  if (pathPart.startsWith('library/')) {
    const skillId = safeDecode(pathPart.slice('library/'.length));
    return { id: 'library', skillId: skillId.length > 0 ? skillId : null, agentId: null, agentDir: null, raw, query };
  }

  const id = (ROUTES as readonly string[]).includes(pathPart) ? (pathPart as RouteId) : 'home';
  return { id, skillId: null, agentId: null, agentDir: null, raw, query };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 未保存修改的导航守卫（T11 技能详情）：
 * 页面在存在未保存文件时注册守卫，导航被拦截并弹「保存 / 放弃 / 取消」。
 * 守卫返回 true 表示已接管本次导航（hash 不变）。
 */
type NavigationGuard = (targetHash: string) => boolean;

let navigationGuard: NavigationGuard | null = null;

export function setNavigationGuard(guard: NavigationGuard | null): void {
  navigationGuard = guard;
}

function applyHash(hash: string): void {
  if (navigationGuard && navigationGuard(hash)) return;
  window.location.hash = hash;
}

export function navigate(id: RouteId, query?: Record<string, string>): void {
  const search = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : '';
  applyHash(`${ROUTE_HASH[id]}${search}`);
}

/** 进入技能详情（T11：真实文件树 + 标签 + 编辑保存）。 */
export function navigateSkill(skillId: string, folder?: string): void {
  const query = folder ? `?folder=${encodeURIComponent(folder)}` : '';
  applyHash(`#/library/${encodeURIComponent(skillId)}${query}`);
}

/** 从市场列表进入只读技能详情，key 供原有市场安装链路使用。 */
export function navigateMarketSkill(source: string, skillId: string, key: string): void {
  applyHash(`#/install/market/${encodeURIComponent(source)}/${encodeURIComponent(skillId)}?key=${encodeURIComponent(key)}`);
}

/** 从安装页的发现结果进入只读文件预览。 */
export function navigateInstallPreview(channel: 'git' | 'local' | 'archive' | 'scan', key: string): void {
  applyHash(`#/install/preview/${channel}/${encodeURIComponent(key)}`);
}

/** 进入 Agent 源技能详情（T13：未入库编辑 Agent 原文件，已入库编辑中心库文件）。 */
export function navigateAgentSkill(agentId: string, dirName: string): void {
  applyHash(`#/agent/${encodeURIComponent(agentId)}/${encodeURIComponent(dirName)}`);
}

/** 直接跳到某个 hash（技能详情的「放弃修改并离开」使用）。 */
export function navigateToHash(hash: string): void {
  window.location.hash = hash;
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parseRoute(hash);
}
