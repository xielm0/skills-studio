/**
 * 主进程侧 IPC 路由（tec.md §7.1、§9.2）。
 *
 * 三条规则：
 * 1. 只有 shared/ipc.ts 里声明的通道会注册 handler；其余 invoke 由 Electron 直接拒绝。
 * 2. 每个请求先过「来源校验 → 参数校验」，失败返回错误信封，不抛异常到渲染层。
 * 3. 未实现的领域通道统一 NOT_IMPLEMENTED，避免渲染层误以为功能可用。
 *
 * T10：处理器从静态的 ping/info 扩展为集中装配的 IpcHandlers（ipc/handlers.ts），
 * 支持异步（首启导入、目录选择、库迁移）。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  IPC_ERROR_CODES,
  NO_ARG_CHANNELS,
  isIpcChannelName,
  type IpcChannelName,
  type IpcError,
  type IpcHandlers,
  type IpcResponse,
} from '../shared/ipc';
import type { Logger } from '../logger';

const MAX_PAYLOAD_BYTES = 64 * 1024;
/**
 * 通道级上限：文件保存需要携带全文（服务层另有 512KB 可编辑上限），
 * 其余通道保持 64KB，避免把参数校验整体放宽。
 */
const CHANNEL_PAYLOAD_LIMITS: Partial<Record<IpcChannelName, number>> = {
  'library:writeFile': 2 * 1024 * 1024,
};
const MAX_DETAIL_LENGTH = 300;

/** 不接受任何参数的通道（payload 必须是 undefined 或空对象）。 */
const NO_ARG = new Set<IpcChannelName>(NO_ARG_CHANNELS);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface IpcRouterDeps {
  logger: Logger;
  /** 只接受主窗口主框架发来的请求 */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
  handlers: IpcHandlers;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ok<T>(data: T): IpcResponse<T> {
  return { ok: true, data };
}

function fail(code: IpcError['code'], detail?: string): IpcResponse<never> {
  return { ok: false, error: { code, detail } };
}

/** 参数结构校验：只允许 undefined 或「无原型污染的普通对象」，并限制序列化体积。 */
function validatePayload(channel: IpcChannelName, payload: unknown): IpcError | null {
  if (payload === undefined || payload === null) {
    if (NO_ARG.has(channel)) return null;
    return { code: 'BAD_REQUEST', detail: `${channel} 需要参数对象` };
  }
  if (!isPlainObject(payload)) {
    return { code: 'BAD_REQUEST', detail: `${channel} 的参数必须是对象或省略` };
  }
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return { code: 'BAD_REQUEST', detail: `参数包含保留键 ${key}` };
    }
  }
  let size = 0;
  try {
    size = JSON.stringify(payload).length;
  } catch {
    return { code: 'BAD_REQUEST', detail: '参数不可序列化' };
  }
  if (size > (CHANNEL_PAYLOAD_LIMITS[channel] ?? MAX_PAYLOAD_BYTES)) {
    return {
      code: 'BAD_REQUEST',
      detail: `参数超过 ${CHANNEL_PAYLOAD_LIMITS[channel] ?? MAX_PAYLOAD_BYTES} 字节上限`,
    };
  }
  if (NO_ARG.has(channel) && Object.keys(payload).length > 0) {
    return { code: 'BAD_REQUEST', detail: `${channel} 不接受参数` };
  }
  return null;
}

async function dispatch(
  deps: IpcRouterDeps,
  channel: IpcChannelName,
  payload: unknown,
): Promise<IpcResponse<unknown>> {
  const invalid = validatePayload(channel, payload);
  if (invalid) {
    deps.logger.info('ipc:bad-request', { channel, code: invalid.code, detail: invalid.detail });
    return fail(invalid.code, invalid.detail);
  }

  const handler = (deps.handlers as Record<string, ((arg: unknown) => unknown) | undefined>)[channel];
  if (typeof handler !== 'function') {
    deps.logger.info('ipc:not-implemented', { channel });
    return fail('NOT_IMPLEMENTED', `${channel} 将在后续任务实现`);
  }

  try {
    const data = await handler(payload);
    return ok(data);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.logger.error('ipc:handler-failed', { channel, detail });
    // 参数类错误（如 AgentError('BAD_REQUEST')）保留语义码，其余统一 INTERNAL_ERROR
    const rawCode = (err as { code?: unknown } | null)?.code;
    const code =
      typeof rawCode === 'string' && (IPC_ERROR_CODES as readonly string[]).includes(rawCode)
        ? (rawCode as IpcError['code'])
        : 'INTERNAL_ERROR';
    return fail(code, detail.slice(0, MAX_DETAIL_LENGTH));
  }
}

export interface IpcRouterHandle {
  dispose(): void;
}

export function registerIpcRouter(deps: IpcRouterDeps): IpcRouterHandle {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse<unknown>> => {
      if (!isIpcChannelName(channel)) return fail('UNKNOWN_CHANNEL', String(channel));
      if (!deps.isTrustedSender(event)) {
        deps.logger.error('ipc:untrusted-sender', {
          channel,
          url: event.senderFrame?.url ?? 'unknown',
        });
        return fail('UNTRUSTED_SENDER', '只接受主窗口主框架的请求');
      }
      try {
        return await dispatch(deps, channel, payload);
      } catch (err) {
        deps.logger.error('ipc:internal-error', { channel, error: String(err) });
        return fail('INTERNAL_ERROR', '命令执行失败');
      }
    });
  }

  return {
    dispose() {
      for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel);
    },
  };
}
