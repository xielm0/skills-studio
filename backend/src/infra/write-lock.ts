/**
 * 库级写权限的进程内排队。
 *
 * 2026-10-30 之前这里是「跨进程文件锁」：在 <dataDir>/locks/<key>.lock 上用
 * `open(..., 'wx')` 做互斥，用于 GUI 主进程与 CLI 进程之间串行化写库。同日按用户决定
 * 移除——本产品是单机单用户，CLI 尚未接进 Agent 自动路径（T16/T17），不存在两
 * 端同时写同一个库的现实场景；而文件锁一旦在崩溃瞬间留下坏文件，会让之后每一次写操作
 * 都等满超时后失败。
 *
 * 保留下来的这一层不是「锁」，是同一进程内的 promise 队列。GUI 里有两条并发写入源：
 * 文件监视的 3 秒轮询重扫、用户触发的导入/同步/删除。它们操作同一个 skills/ 目录与
 * index.db，交错会让重扫把半成品目录登记成技能（见 library.ts 的注释）。队列只在内存
 * 里，不落盘、不会残留、不会阻塞进程退出。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LockHandle {
  readonly operation: string;
  readonly acquiredAt: string;
  release(): void;
}

export class WriteLock {
  /** 同进程排队：保证 Promise.all 并发调用按序执行而不是互相踩踏 */
  private tail: Promise<void> = Promise.resolve();
  /** 同一异步调用链的重入标记：持锁期间的嵌套调用直接放行，避免自死锁 */
  private readonly reentry = new AsyncLocalStorage<{ released: boolean }>();

  /**
   * 取到写权限。纯内存排队，没有超时也不会失败——唯一的约束是调用方必须 release，
   * 否则后面所有写操作都会排在它后面（同进程内，重启即恢复）。
   */
  async acquire(opts: { operation?: string } = {}): Promise<LockHandle> {
    const operation = opts.operation ?? 'unknown';
    const waitInProcess = this.tail;
    let openGate!: () => void;
    this.tail = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    try {
      await waitInProcess;
    } catch {
      /* 前一个持有者的异常不影响排队 */
    }

    let released = false;
    return {
      operation,
      acquiredAt: new Date().toISOString(),
      release: () => {
        if (released) return;
        released = true;
        openGate();
      },
    };
  }

  /** 便捷封装：持写权限执行（fn 可为同步或异步），异常也保证释放。可重入。 */
  async runExclusive<T>(operation: string, fn: () => T | Promise<T>): Promise<T> {
    const held = this.reentry.getStore();
    if (held != null && !held.released) return fn(); // 已在本锁的持有链内：直接执行
    const handle = await this.acquire({ operation });
    const token = { released: false };
    try {
      return await this.reentry.run(token, async () => fn());
    } finally {
      token.released = true;
      handle.release();
    }
  }

  /**
   * 当前异步调用链是否已持有写权限。
   * 供上层判断「这次操作已在写锁内」——例如保存文件后刷新索引时不必再排队
   * （否则会和另一个正在等锁的重扫互相等待）。
   */
  get heldByCurrentChain(): boolean {
    const held = this.reentry.getStore();
    return held != null && !held.released;
  }
}
