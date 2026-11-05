/**
 * 渲染层唯一通道：preload 白名单 IPC（tec.md §9.2）。
 *
 * - 渲染层无 Node 能力（contextIsolation: true / nodeIntegration: false）。
 * - 白名单直接取 shared/ipc.ts 的 IPC_CHANNELS，避免主/渲染/预加载三处清单漂移。
 * - 未在白名单内的通道在 preload 就被拒绝，不会到达主进程。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  CONVERSATION_EVENT_CHANNEL,
  CONVERSATION_EVENT_TYPES,
  IPC_CHANNELS,
  UPDATE_EVENT_CHANNEL,
  type AppUpdateState,
  type ConversationEvent,
  type IpcChannelName,
  type IpcRequestOf,
  type IpcResultOf,
  type SkpBridge,
} from './shared/ipc';

const ALLOWED = new Set<string>(IPC_CHANNELS);

/** 事件类型白名单：未声明的事件不进入渲染层（避免主进程误发结构失控的数据）。 */
const EVENT_TYPES = new Set<string>(CONVERSATION_EVENT_TYPES);

function invokeChannel<K extends IpcChannelName>(channel: K, payload?: IpcRequestOf<K>): Promise<IpcResultOf<K>> {
  if (!ALLOWED.has(channel)) {
    return Promise.reject(new Error(`IPC_CHANNEL_NOT_ALLOWED: ${channel}`));
  }
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResultOf<K>>;
}

function onConversationEvent(listener: (event: ConversationEvent) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
    if (!payload || typeof payload !== 'object') return;
    const type = (payload as { type?: unknown }).type;
    if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return;
    listener(payload as ConversationEvent);
  };
  ipcRenderer.on(CONVERSATION_EVENT_CHANNEL, wrapped);
  return () => {
    ipcRenderer.removeListener(CONVERSATION_EVENT_CHANNEL, wrapped);
  };
}

/** 更新状态推送只做结构校验（payload 必须带字符串 status），通过后整包转发。 */
function onUpdateState(listener: (state: AppUpdateState) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
    if (!payload || typeof payload !== 'object') return;
    if (typeof (payload as { status?: unknown }).status !== 'string') return;
    listener(payload as AppUpdateState);
  };
  ipcRenderer.on(UPDATE_EVENT_CHANNEL, wrapped);
  return () => {
    ipcRenderer.removeListener(UPDATE_EVENT_CHANNEL, wrapped);
  };
}

const bridge: SkpBridge = {
  channels: IPC_CHANNELS,
  invoke: invokeChannel,
  ping: () => invokeChannel('app:ping'),
  info: () => invokeChannel('app:info'),
  onConversationEvent,
  onUpdateState,
};

contextBridge.exposeInMainWorld('skp', bridge);
