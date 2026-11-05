/**
 * 对话事件与列表刷新（T15）。
 *
 * - 事件来源：preload 的 `onConversationEvent`（主进程单向推送，已做类型白名单）。
 * - 列表刷新：会话创建/发送/取消/运行结束时，Sidebar 需要重新拉取 `conversation:list`；
 *   跨组件用 window 自定义事件通知，不引入状态库。
 */
import { useEffect, useRef } from 'react';
import type { ConversationEvent } from '../../../backend/src/shared/ipc';

const SESSIONS_CHANGED = 'skp:sessions-changed';

/** 订阅主进程对话事件；返回取消订阅函数（桥未注入时为空实现）。 */
export function subscribeConversationEvents(handler: (event: ConversationEvent) => void): () => void {
  const bridge = window.skp;
  if (!bridge || typeof bridge.onConversationEvent !== 'function') return () => undefined;
  return bridge.onConversationEvent(handler);
}

/** React 版订阅：始终调用最新的 handler（避免重订阅导致漏事件）。 */
export function useConversationEvents(handler: (event: ConversationEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeConversationEvents((event) => ref.current(event)), []);
}

/** 通知侧栏会话列表刷新。 */
export function notifySessionsChanged(): void {
  window.dispatchEvent(new CustomEvent(SESSIONS_CHANGED));
}

export function subscribeSessionsChanged(handler: () => void): () => void {
  const listener = () => handler();
  window.addEventListener(SESSIONS_CHANGED, listener);
  return () => window.removeEventListener(SESSIONS_CHANGED, listener);
}
