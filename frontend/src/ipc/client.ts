/**
 * IPC 客户端：渲染层唯一的数据入口。
 * 类型来自 backend/src/shared/ipc.ts（主/渲染共用契约），运行时只调用 window.skp。
 */
import type {
  AppInfoResult,
  IpcChannelName,
  IpcError,
  IpcRequestOf,
  IpcResultOf,
  SkpBridge,
} from '../../../backend/src/shared/ipc';

declare global {
  interface Window {
    skp?: SkpBridge;
  }
}

const BRIDGE_MISSING: IpcError = {
  code: 'INTERNAL_ERROR',
  detail: 'IPC 桥未注入：请通过 Electron 启动（npm start）',
};

export async function request<K extends IpcChannelName>(
  channel: K,
  payload?: IpcRequestOf<K>,
): Promise<IpcResultOf<K>> {
  const bridge = window.skp;
  if (!bridge) {
    return { ok: false, error: BRIDGE_MISSING } as IpcResultOf<K>;
  }
  try {
    return await bridge.invoke(channel, payload);
  } catch (err) {
    return {
      ok: false,
      error: { code: 'INTERNAL_ERROR', detail: err instanceof Error ? err.message : String(err) },
    } as IpcResultOf<K>;
  }
}

export async function fetchAppInfo(): Promise<AppInfoResult | null> {
  const result = await request('app:info');
  return result.ok ? result.data : null;
}
