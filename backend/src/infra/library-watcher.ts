/**
 * 库监视（tec.md §5.1/§8：事件驱动 + 按路径短时窗口抑制自身写入回声——
 * 不得全局静音，否则真实外部改动会被吞）。思路对齐竞品 file_watcher.rs。
 * 2026-11-02 用户定：去掉定时轮询兜底（不必频繁全量扫描）；Windows 漏事件时
 * 由「GUI 打开中心库页触发 rescan」兜底。思路：事件驱动为主，打开页面为兜底。
 * 2026-11-02 改用原生 fs.watch(recursive)（替代 chokidar 3）：chokidar 3 在
 * Windows 对树内每个子目录各持一个 fs.watch 句柄，会把库内目录锁到资源管理器
 * 无法移动/重命名（报「已在另一程序中打开」）。recursive 单根句柄实测不阻塞
 * 树内任何 rename，监视根被改名后事件继续（tests/runtime/watch-move-probe*.cjs）。
 * 代价：无 awaitWriteFinish；消费端是幂等整库 rescan + 去抖，编辑器分段写入
 * 至多多触发一两次重扫，可接受。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LibraryWatcherOptions {
  /** 要监视的目录（递归） */
  dir: string;
  /** 外部变化回调（已去抖、已滤自身回声）。 */
  onExternalChange: (paths: string[]) => void;
  /** 自身写入回声抑制窗口，默认 1500ms */
  selfWriteWindowMs?: number;
  /** 事件去抖，默认 250ms */
  debounceMs?: number;
  /**
   * 启动静默期（ms）：start() 后该窗口内的事件直接丢弃，默认 0 = 不启用。
   * 动机（2026-11-09）：开机后系统扫描类进程（杀软/索引器/同步盘）触碰技能目录
   * 的**纯读操作**也会产生 change 事件（atime/属性更新），曾致每次启动后固定
   * 触发一次整库重扫。静默期内真实外部改动的兜底 =「打开中心库页触发 rescan」，
   * 不依赖监视（见类头注释）。
   */
  quietPeriodMs?: number;
}

interface MutedRoot {
  path: string;
  deadline: number;
}

export class LibraryWatcher {
  private readonly opts: Required<LibraryWatcherOptions>;
  private fsWatcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingPaths: string[] = [];
  /** 拿不到文件名的事件（缓冲溢出等）：无法判定归属，保守按外部变化上报。 */
  private sawUnnamedEvent = false;
  private muted: MutedRoot[] = [];
  private stopped = false;
  /** 启动静默期截止时刻；0 = 已过静默期（或未启用）。 */
  private quietUntil = 0;

  constructor(opts: LibraryWatcherOptions) {
    this.opts = {
      dir: opts.dir,
      onExternalChange: opts.onExternalChange,
      selfWriteWindowMs: opts.selfWriteWindowMs ?? 1500,
      debounceMs: opts.debounceMs ?? 250,
      quietPeriodMs: opts.quietPeriodMs ?? 0,
    };
  }

  start(): void {
    fs.mkdirSync(this.opts.dir, { recursive: true });

    this.quietUntil = Date.now() + this.opts.quietPeriodMs;
    this.fsWatcher = fs.watch(this.opts.dir, { recursive: true });
    this.fsWatcher
      .on('change', (_eventType: fs.WatchEventType, filename: string | Buffer | null) =>
        this.collect(filename),
      )
      .on('error', () => {
        /* 监视失败由「打开中心库页触发 rescan」兜底 */
      });
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer != null) clearTimeout(this.debounceTimer);
    this.fsWatcher?.close();
    this.fsWatcher = null;
  }

  /**
   * 应用自身写入前调用：登记路径与短时抑制窗口。窗口内该路径下的事件视为回声跳过；
   * 其他路径的事件（真实外部改动）不受影响、绝不吞掉。
   */
  noteSelfWrite(target: string): void {
    const now = Date.now();
    this.muted = this.muted.filter((m) => m.deadline > now);
    this.muted.push({ path: path.resolve(target), deadline: now + this.opts.selfWriteWindowMs });
  }

  private collect(filename: string | Buffer | null): void {
    if (this.stopped) return;
    // encoding 默认 utf8，filename 实际只会是 string 或 null；其余并入无名事件。
    if (typeof filename === 'string') {
      if (isInGitDir(filename)) return; // git 内部操作（fetch/pack）不是库内容变化
      this.pendingPaths.push(path.join(this.opts.dir, filename));
    } else {
      this.sawUnnamedEvent = true;
    }
    if (this.debounceTimer != null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), this.opts.debounceMs);
  }

  private flush(): void {
    const paths = this.pendingPaths;
    this.pendingPaths = [];
    const unnamed = this.sawUnnamedEvent;
    this.sawUnnamedEvent = false;
    if (this.stopped || (paths.length === 0 && !unnamed)) return;

    // 启动静默期：整批丢弃（不延迟）。开机风暴期间的真实外部改动
    // 由「打开中心库页触发 rescan」兜底，不依赖监视。
    if (Date.now() < this.quietUntil) return;

    const now = Date.now();
    this.muted = this.muted.filter((m) => m.deadline > now);
    const echoed =
      !unnamed && paths.every((p) => this.muted.some((m) => isInside(m.path, p)));
    if (echoed) return; // 纯自身回声：丢弃；混合外部路径时照常上报（不全局静音）

    this.opts.onExternalChange(paths);
  }
}

function isInGitDir(p: string): boolean {
  return p.split(/[\\/]/).includes('.git');
}

function isInside(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
